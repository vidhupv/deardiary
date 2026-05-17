"""
Voice-loop closer: after a call, mutate mini-app state based on what the user said.

Reads backend/memory.json. For each card with kind=="app", hands Claude the
current state + the app's update_hints + the latest transcript, asks for state
mutations. Applies them in-place, writes memory.json back.

Run with:
    cd backend && ../backend/.venv/bin/python update_apps.py [session_id]

If no session_id is given, uses the most recent session in memory.

Authenticates via the local `claude` CLI (Claude Pro/Max login) — no API key needed.
"""

import asyncio
import json
import re
import sys
from datetime import date
from pathlib import Path

MEMORY_FILE = Path(__file__).parent / "memory.json"


PROMPT_TEMPLATE = """You are the Life OS state updater for deardiary.

A call just ended. Your job: decide whether any mini-apps on the user's dashboard
need their state updated based on what was said. Most apps will NOT need updates
most of the time. Be conservative — only mutate when the transcript clearly implies it.

TODAY: {today}

LATEST CALL TRANSCRIPT:
{transcript}

MINI-APPS (each with current state and the rules for when to mutate):
{apps}

OUTPUT FORMAT: a single JSON object mapping app_id -> new_state. Only include apps
that need updates. If nothing should change, return {{}}. Each value must be a full
replacement for the app's `state` field (not a partial patch). Preserve fields you're
not changing. No markdown fences, no commentary.

JSON OBJECT:"""


async def update_apps_from_transcript(memory: dict, session_id: str | None = None) -> dict[str, dict]:
    """Returns a dict of app_id -> new_state for apps that need updating."""
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

    apps = [c for c in memory["cards"] if c.get("kind") == "app"]
    if not apps:
        return {}

    session = _pick_session(memory, session_id)
    if not session:
        return {}

    apps_text = "\n\n".join(_describe_app(a) for a in apps)
    transcript = "\n".join(
        f"  {'CB' if t['who'] == 'a' else 'User'}: {t['text']}"
        for t in session["transcript"]
    )

    prompt = PROMPT_TEMPLATE.format(
        today=date.today().isoformat(),
        transcript=transcript,
        apps=apps_text,
    )

    options = ClaudeAgentOptions(
        system_prompt=(
            "You update Life OS mini-app state from call transcripts. "
            "Return ONLY a valid JSON object mapping app_id to new state."
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
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    patches = json.loads(raw)
    if not isinstance(patches, dict):
        raise ValueError(f"Expected JSON object of patches, got {type(patches).__name__}")
    return patches


def _pick_session(memory: dict, session_id: str | None) -> dict | None:
    sessions = memory.get("sessions", [])
    if not sessions:
        return None
    if session_id is None:
        # Default to today's open session, else the most recent.
        today = next((s for s in sessions if s.get("isToday")), None)
        return today or sessions[-1]
    return next((s for s in sessions if s["id"] == session_id), None)


def _describe_app(app: dict) -> str:
    return (
        f"### {app['id']} (schema={app.get('schema', '?')})\n"
        f"  title: {app['title']}\n"
        f"  update_hints: {app.get('update_hints', '(none)')}\n"
        f"  current state: {json.dumps(app.get('state', {}), indent=2)}"
    )


def main() -> int:
    session_id = sys.argv[1] if len(sys.argv) > 1 else None
    memory = json.loads(MEMORY_FILE.read_text())

    app_count = sum(1 for c in memory["cards"] if c.get("kind") == "app")
    print(f"Checking {app_count} mini-apps against "
          f"{'session ' + session_id if session_id else 'latest session'}…")

    patches = asyncio.run(update_apps_from_transcript(memory, session_id))

    if not patches:
        print("No updates needed.")
        return 0

    for c in memory["cards"]:
        if c["id"] in patches and c.get("kind") == "app":
            c["state"] = patches[c["id"]]
            print(f"  updated: {c['id']}")

    MEMORY_FILE.write_text(json.dumps(memory, indent=2))
    print(f"Wrote {len(patches)} state update(s) to {MEMORY_FILE.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
