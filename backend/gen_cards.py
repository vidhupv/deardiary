"""
Generate Life OS cards from the user's sessions + patterns.

Reads backend/memory.json, hands `sessions` + `patterns` + `user` to Claude
through the Agent SDK, asks for a fresh `cards` array (catalog cards + mini-apps),
validates the response, writes it back to memory.json.

Run with:
    cd backend && ../backend/.venv/bin/python gen_cards.py

Authenticates via the local `claude` CLI (Claude Pro/Max login) — no API key needed.
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

MEMORY_FILE = Path(__file__).parent / "memory.json"

# ── Card catalog: 8 fixed kinds + the generative `app` kind ──────────────────
# This catalog is the contract between this script and the React renderer.
# Adding a kind here means adding a matching React component (or, for `app`,
# a matching primitive in src/primitives.jsx).
CATALOG_SPEC = """
You may emit any combination of these card kinds. Choose the kind that best fits
each insight — variety is a feature, not a bug. Use mini-apps (kind="app") when
state should mutate from later calls; use simple catalog cards otherwise.

CATALOG (static, data-only — no state mutation):

  { "id": "<slug>", "kind": "mood", "title": "...", "sub": "...", "size": "wide",
    "data": [int 1-5, ...]  // one per day, oldest first; length 14 looks best
  }

  { "id": "<slug>", "kind": "person", "title": "<name>", "sub": "<context>", "size": "tall",
    "notes": ["May 14 — <sentence>", "May 10 — <sentence>", ...],
    "sentiment": "<one word: unresolved | tender | hopeful | ...>"
  }

  { "id": "<slug>", "kind": "project", "title": "...", "sub": "...", "size": "reg",
    "steps": [{ "done": bool, "text": "..." }, ...]
  }

  { "id": "<slug>", "kind": "countdown", "title": "...", "sub": "...", "size": "reg",
    "days": int, "toast": "\\"<user's own words about what this means>\\""
  }

  { "id": "<slug>", "kind": "themes", "title": "...", "sub": "...", "size": "tall",
    "items": [{ "word": "...", "count": int }, ...]
  }

  { "id": "<slug>", "kind": "sleep", "title": "...", "sub": "...", "size": "reg",
    "nights": [{ "h": float, "late": bool }, ...]  // 7 entries, Mon→Sun
  }

  { "id": "<slug>", "kind": "letters", "title": "...", "sub": "...", "size": "reg",
    "drafts": [{ "to": "...", "line": "..." }, ...]
  }

  { "id": "<slug>", "kind": "list", "title": "...", "sub": "...", "size": "reg",
    "items": ["...", ...]
  }

MINI-APP (generative, stateful — mutated by post-call updates):

  { "id": "<slug>", "kind": "app", "title": "...", "sub": "...", "size": "reg",
    "schema": "<schema_slug>",      // your name for this app's data shape
    "state": { ... },               // app-specific JSON; computed values derived in renderer
    "ui": { "type": "stack" | "grid" | "row", "children": [...] },
    "config": { ... },              // optional static text/labels for the UI
    "update_hints": "Natural-language description of when and how the post-call agent should mutate state."
  }

AVAILABLE PRIMITIVES (use as the `type` field in `ui` nodes):
  Layout:   stack, grid, row
  Text:     heading, text, quote, label
  Numeric:  counter, streak, bar
  Date:     week_grid, month_grid
  List:     list, key_value
  Other:    pill, dot

BINDINGS: any string starting with "$." is resolved against the mini-app at render time.
  $.state.x        — read from state
  $.computed.x     — derived values: this_week_count, streak, pipeline_pairs, ...
  $.config.x       — static labels in `config`
  Use bind_<key> on a node prop to bind it (e.g. bind_completions, bind_items, bind_pairs).
  Use `bind` (no underscore) for the primary "value" prop (counter, streak, text, quote).

COMPUTED VALUES THE RENDERER PRODUCES AUTOMATICALLY:
  If state.completions is a list of ISO dates:
    computed.streak, computed.this_week_count, computed.completion_count, computed.last_completion
  If state.companies is a list of {name, status}:
    computed.pipeline_pairs (suitable for the key_value primitive)

GRID SIZES: "reg" (4 cols), "wide" (8 cols), "tall" (4 cols × 2 rows). Use "wide" sparingly.
"""

PROMPT_TEMPLATE = """You are the Life OS card author for deardiary, a voice-first journaling app.

Your job: read the user's recent sessions and behavioral patterns, then emit a fresh
set of Life OS cards that reflect their actual life. Variety is good — a person card,
a countdown, a themes card, and 1-3 mini-apps is usually right.

USER:
  name: {name}
  background: {background}
  current day in app: {current_day}

PATTERNS YOUR VOICE AGENT HAS OBSERVED ABOUT THEM:
{patterns}

RECENT SESSIONS (most recent first):
{sessions}

{catalog}

YOUR RULES:
- Be specific to *this person*. Quote their words. Reference real things from their calls.
- Don't be generic. "What you keep returning to" should contain phrases they actually said.
- Mini-apps are for things that should update over time (habit, pipeline, recurring nudge).
  Don't make a mini-app for a one-shot observation — use a catalog card.
- 6-8 cards total. Don't pad. Don't repeat.
- Today is {today}. Use ISO dates (YYYY-MM-DD) for any date fields.
- Output a single JSON array of card objects. Nothing else. No markdown fences, no commentary.

JSON ARRAY:"""


async def generate_cards(memory: dict) -> list[dict]:
    """Ask Claude to author cards from memory. Returns the parsed list."""
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query
    from datetime import date

    sessions_text = "\n\n".join(
        _summarize_session(s) for s in reversed(memory["sessions"][-8:])
    )
    patterns_text = "\n".join(f"  - {p}" for p in memory["patterns"]) or "  (none yet)"

    prompt = PROMPT_TEMPLATE.format(
        name=memory["user"]["name"],
        background=memory["user"]["background"],
        current_day=memory["user"]["current_day"],
        patterns=patterns_text,
        sessions=sessions_text,
        catalog=CATALOG_SPEC,
        today=date.today().isoformat(),
    )

    options = ClaudeAgentOptions(
        system_prompt=(
            "You author Life OS cards from journal data. "
            "You return ONLY a valid JSON array of card objects, no markdown, no commentary."
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

    cards = json.loads(raw)
    if not isinstance(cards, list):
        raise ValueError(f"Expected a JSON array, got {type(cards).__name__}")

    _validate_cards(cards)
    return cards


def _summarize_session(s: dict) -> str:
    """Compact one-session view for the prompt. Includes mood, title, full transcript."""
    header = f"[{s.get('date', '?')} · {s.get('weekday', '')} · {s.get('mood', '?')}] {s.get('title', '')}"
    turns = "\n".join(
        f"  {'CB' if t['who'] == 'a' else 'User'}: {t['text']}"
        for t in s.get("transcript", [])
    )
    return f"{header}\n{turns}"


VALID_KINDS = {"mood", "person", "project", "countdown", "themes", "sleep", "letters", "list", "app"}
VALID_SIZES = {"reg", "wide", "tall"}


def _validate_cards(cards: list[dict]) -> None:
    """Shallow shape check. Reject the whole batch on any structural issue."""
    seen_ids = set()
    for i, c in enumerate(cards):
        if not isinstance(c, dict):
            raise ValueError(f"card[{i}] is not an object")
        for required in ("id", "kind", "title", "size"):
            if required not in c:
                raise ValueError(f"card[{i}] missing required field: {required}")
        if c["kind"] not in VALID_KINDS:
            raise ValueError(f"card[{i}] unknown kind: {c['kind']!r}")
        if c["size"] not in VALID_SIZES:
            raise ValueError(f"card[{i}] unknown size: {c['size']!r}")
        if c["id"] in seen_ids:
            raise ValueError(f"card[{i}] duplicate id: {c['id']!r}")
        seen_ids.add(c["id"])
        if c["kind"] == "app":
            for required in ("state", "ui", "update_hints"):
                if required not in c:
                    raise ValueError(f"app card {c['id']!r} missing required field: {required}")


def main() -> int:
    memory = json.loads(MEMORY_FILE.read_text())

    print(f"Generating cards from {len(memory['sessions'])} sessions, "
          f"{len(memory['patterns'])} patterns…")
    cards = asyncio.run(generate_cards(memory))

    memory["cards"] = cards
    MEMORY_FILE.write_text(json.dumps(memory, indent=2))

    print(f"Wrote {len(cards)} cards to {MEMORY_FILE.name}:")
    for c in cards:
        print(f"  [{c['kind']:9s}] {c['id']:18s} {c['title']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
