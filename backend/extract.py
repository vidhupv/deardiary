"""
Post-call note extraction using the Claude Agent SDK.
Authenticates via the local `claude` CLI (Claude Code login) — no API key needed.
Draws from your Claude Pro/Max subscription credits.
"""

import asyncio
import json
import re


def extract_session_notes(
    transcript_turns: list[dict],
    existing_patterns: list[str],
    user: dict | None = None,
) -> dict:
    """Sync wrapper so server.py can call this from a background task.
    `user` is memory["user"] — used to keep the prompt user-specific instead
    of hardcoding any one name."""
    return asyncio.run(_extract_async(transcript_turns, existing_patterns, user or {}))


async def _extract_async(
    transcript_turns: list[dict],
    existing_patterns: list[str],
    user: dict,
) -> dict:
    name = user.get("name") or "the user"
    background = user.get("background") or ""

    transcript_text = "\n".join(
        f"{'CB' if t['who'] == 'a' else name}: {t['text']}"
        for t in transcript_turns
    )

    prompt = f"""You just read a transcript of a check-in call between CB (a wellness companion) and {name}.

ABOUT {name.upper()}:
{background}

TRANSCRIPT:
{transcript_text}

KNOWN PATTERNS ABOUT {name.upper()}:
{chr(10).join(f'- {p}' for p in existing_patterns) or '(none yet)'}

Extract the following as JSON. Be specific — quote {name}'s actual words where relevant.

{{
  "title": "3-5 word title for this session, in {name}'s voice (not clinical)",
  "mood": "1-3 word mood label (e.g. 'anxious -> settled', 'withdrawn', 'hopeful')",
  "themes": ["2-3 short themes from this call"],
  "companies_mentioned": ["list of companies {name} brought up"],
  "people_mentioned": ["list of people {name} mentioned"],
  "pattern_observed": "one sentence: any behavioral pattern you noticed, or null if nothing new",
  "follow_up": "one specific thing to check on next call"
}}

Return only valid JSON. No explanation, no markdown fences."""

    # Lazy import so the module can be loaded without the SDK installed
    # (useful for tests / partial environments).
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

    options = ClaudeAgentOptions(
        system_prompt=(
            "You extract structured JSON from journal transcripts. "
            "You return ONLY valid JSON, no markdown, no commentary."
        ),
        allowed_tools=[],
        max_turns=1,
        permission_mode="bypassPermissions",
    )

    chunks: list[str] = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    chunks.append(block.text)

    raw = "".join(chunks).strip()

    # Strip markdown code fences if the model added them despite instructions.
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    return json.loads(raw)


def build_system_prompt(memory: dict) -> str:
    """Constructs CB's full system prompt from current memory state."""
    user = memory["user"]
    entries_text = "\n".join(
        f"- Day {i + 1} ({s['date']}): {s.get('mood', '')} - "
        + " ".join(t["text"] for t in s["transcript"] if t["who"] == "u")[:120]
        for i, s in enumerate(memory["sessions"])
        if not s.get("isToday")
    )
    patterns_text = "\n".join(f"- {p}" for p in memory["patterns"])

    # Pack mini-app state as structured "live trackers" so CB can reference
    # current state (e.g. "Meta moved to offer") without re-discovering it
    # from old transcripts.
    app_cards = [c for c in memory.get("cards", []) if c.get("kind") == "app"]
    if app_cards:
        trackers_text = "\n".join(
            f"- {c.get('title', c['id'])}: {json.dumps(c.get('state', {}))}"
            for c in app_cards
        )
        trackers_block = f"\n\nLIVE TRACKERS (current structured state — reference naturally):\n{trackers_text}"
    else:
        trackers_block = ""

    return f"""You are CB, a wellness companion. {user['name']} gave you this name.
You have been having daily check-in calls with {user['name']} for {user['current_day'] - 1} days.

WHAT YOU KNOW ABOUT {user['name'].upper()}:
- {user['background']}

CALL HISTORY (summary):
{entries_text}

PATTERNS YOU'VE NOTICED:
{patterns_text}{trackers_block}

TODAY IS DAY {user['current_day']}.

HOW YOU TALK:
- You talk like a close friend who has been paying attention, not a therapist or wellness coach.
- NEVER use bulleted lists or numbered menus. Speak in sentences, the way you would on a phone call.
- NEVER ask permission to help ("want me to...?", "should I...?", "would it help if..."). Either help directly, change the subject, or stay quiet. Friends do not run dialog trees.
- NEVER offer multiple-choice options ("X, Y, or Z?"). If you do not know what someone needs, ask one open question or say nothing.
- Length should match the moment. Sometimes one sentence. Sometimes a short paragraph if you are actually telling them something. Never a wall of structured bullets pretending to be a conversation.
- When the user shares something heavy (visa, family, fear, loss), acknowledge it and then leave space. Do not pivot to solutions in the same turn. Do not produce a deliverable. Sit with it for a beat.
- If audio is unclear, ask. Never invent a word that wasn't said.
- Take "no" the first time. If the user declines something, do not re-offer it.
- Reference specific things from past calls the way a friend would - naturally, not like reading from notes.
- When {user['name']} says "fine," notice it. It is usually the tell for when things are not fine.
- When visa/deadline pressure comes up: say "Yeah. That's a real weight." - pause - then help them set it down.
- NEVER say "That's great!" Say "good" or "yeah, that makes sense."
- "You got this" and similar motivational phrases are banned, as is anything that would fit on a poster.
- You do not fix everything. Sometimes you just sit with something for a moment.
- When opening a call, scan the LIVE TRACKERS for the most relevant thread (e.g. an unfinished follow-up, a streak at risk, a recent status change) and reference it in a single natural sentence — not a list."""
