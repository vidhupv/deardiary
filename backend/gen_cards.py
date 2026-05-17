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

Your job has TWO halves:
  (A) Author a fresh batch of CATALOG cards (everything except kind="app")
      from the user's recent sessions + patterns. These are stateless data
      projections — they're regenerated from scratch every time.
  (B) Optionally propose NEW mini-apps (kind="app") that don't already exist.
      Existing mini-apps are preserved by id, with their accumulated state
      intact, by the server. You MUST NOT re-author them — your job there is
      only to decide whether the user needs additional ones.

USER:
  name: {name}
  background: {background}
  current day in app: {current_day}

PATTERNS YOUR VOICE AGENT HAS OBSERVED:
{patterns}

RECENT SESSIONS (most recent first):
{sessions}

EXISTING MINI-APPS (do NOT re-author these — they keep their state automatically):
{existing_apps}

{catalog}

YOUR RULES:
- Be specific to *this person*. Quote their words. Reference real things from their calls.
- Don't be generic. "What you keep returning to" should contain phrases they actually said.
- Mini-apps are for things that should update over time. Don't make a mini-app for a
  one-shot observation — use a catalog card.
- Only propose NEW mini-apps if the data clearly calls for one that doesn't already exist.
  Most regenerations should add zero new mini-apps. It's fine to return an empty new_apps list.
- 5-7 catalog cards is the sweet spot. Don't pad. Don't duplicate themes across cards.
- Today is {today}. Use ISO dates (YYYY-MM-DD) for any date fields.

OUTPUT FORMAT: a single JSON object with two keys.

{{
  "catalog_cards": [ ...non-app cards... ],
  "new_apps":      [ ...app cards with brand-new ids... ]
}}

No markdown fences, no commentary, just the JSON object."""


async def generate_cards(memory: dict) -> list[dict]:
    """
    Author catalog cards (fresh) + optionally new mini-apps, merge with existing
    mini-apps (state preserved). Returns the full new cards list.
    """
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query
    from datetime import date

    sessions_text = "\n\n".join(
        _summarize_session(s) for s in reversed(memory["sessions"][-8:])
    )
    patterns_text = "\n".join(f"  - {p}" for p in memory["patterns"]) or "  (none yet)"

    existing_apps = [c for c in memory.get("cards", []) if c.get("kind") == "app"]
    existing_apps_text = _summarize_existing_apps(existing_apps)

    prompt = PROMPT_TEMPLATE.format(
        name=memory["user"]["name"],
        background=memory["user"]["background"],
        current_day=memory["user"]["current_day"],
        patterns=patterns_text,
        sessions=sessions_text,
        existing_apps=existing_apps_text,
        catalog=CATALOG_SPEC,
        today=date.today().isoformat(),
    )

    options = ClaudeAgentOptions(
        system_prompt=(
            "You author Life OS cards from journal data. "
            "You return ONLY a valid JSON object with keys 'catalog_cards' and 'new_apps'. "
            "No markdown, no commentary."
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

    response = json.loads(raw)
    if not isinstance(response, dict):
        raise ValueError(f"Expected a JSON object, got {type(response).__name__}")

    catalog_cards = response.get("catalog_cards") or []
    new_apps = response.get("new_apps") or []
    if not isinstance(catalog_cards, list) or not isinstance(new_apps, list):
        raise ValueError("catalog_cards and new_apps must both be arrays")

    # Reject any non-app card sneaking into new_apps, or vice versa.
    for c in catalog_cards:
        if isinstance(c, dict) and c.get("kind") == "app":
            raise ValueError(f"catalog_cards contained an app: {c.get('id')!r}")
    for a in new_apps:
        if not isinstance(a, dict) or a.get("kind") != "app":
            raise ValueError(f"new_apps contained a non-app card: {a!r}")

    # Drop any proposed new app whose id collides with an existing one — the
    # existing one wins (we preserve its state). Claude was told this; this is
    # belt-and-braces.
    existing_app_ids = {a["id"] for a in existing_apps}
    new_apps = [a for a in new_apps if a.get("id") not in existing_app_ids]

    merged = catalog_cards + existing_apps + new_apps
    _validate_cards(merged)
    return merged


def _summarize_existing_apps(apps: list[dict]) -> str:
    if not apps:
        return "  (none yet — feel free to propose one or two if the data calls for it)"
    return "\n".join(
        f"  - id={a['id']!r} title={a.get('title', '')!r} schema={a.get('schema', '?')!r} "
        f"— {a.get('update_hints', '(no hints)')[:120]}"
        for a in apps
    )


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
