"""
Generate Life OS for the user. Two outputs:

  1. Catalog cards (mood/themes/person/...) — written into memory.json["cards"].
     These are stateless data projections, regenerated every refresh.

  2. NEW mini-apps — written as real directories under backend/apps/<id>/, each
     containing manifest.json + state.json + actions.py. Existing apps on disk
     are preserved by id (state untouched).

The script asks Claude (via the Agent SDK / local `claude` CLI auth) for both
in a single JSON response, then writes everything to disk.

Run with:
    cd backend && ../backend/.venv/bin/python gen_cards.py
"""

import asyncio
import ast
import json
import os
import re
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).parent
APPS_DIR = BACKEND_DIR / "apps"
MEMORY_FILE = BACKEND_DIR / "memory.json"

# Resolve actual memory file from env (so per-dev memories generate per-dev apps).
MEMORY_FILE = BACKEND_DIR / os.environ.get("DEARDIARY_MEMORY", "memory.json")

# Spec describing what catalog cards and mini-apps look like. Pasted into the
# prompt so Claude knows what shapes are renderable.
CATALOG_SPEC = """
==================================================================
PART A — catalog cards
==================================================================

Stateless, read-only summaries the user looks at. Regenerated fresh every run.

  mood:      { kind:"mood", id, title, sub, size:"wide", data:[ints 1-5] }
             ONE int per real journaled day. Don't fabricate days.

  person:    { kind:"person", id, title, sub, size:"tall",
               notes:["May 14 — sentence", ...], sentiment:"one word" }
             Only if a person shows up across multiple sessions.

  project:   { kind:"project", id, title, sub, size:"reg",
               steps:[{done:bool, text:"..."}, ...] }
             Real multi-step thing in flight. Steps from the user's words.

  countdown: { kind:"countdown", id, title, sub, size:"reg",
               days:int, toast:"<user's own line>" }

  themes:    { kind:"themes", id, title, sub, size:"tall",
               items:[{word, count}, ...] }
             Only if real recurrence across multiple sessions.

  sleep:     { kind:"sleep", id, title, sub, size:"reg",
               nights:[{h:float, late:bool}, ...]  // 7 entries Mon→Sun }

  letters:   { kind:"letters", id, title, sub, size:"reg",
               drafts:[{to, line}, ...] }

  list:      { kind:"list", id, title, sub, size:"reg",
               items:["...", ...] }

Sizes: "reg" (4 cols), "wide" (8 cols), "tall" (4 cols × 2 rows). Use wide sparingly.

==================================================================
PART B — mini-apps (REAL apps with backends)
==================================================================

Each mini-app you propose becomes a directory at backend/apps/<id>/ containing
manifest.json, state.json, and actions.py. The Python you write IS the backend
for that app — it gets dynamically loaded by the server and called when the
user clicks something in the UI.

For each new mini-app, produce:

{
  "id": "kebab-case-slug",
  "title": "Short noun phrase",
  "sub": "supporting line, lowercase",
  "size": "reg",
  "ui": <tree of primitive nodes — see below>,
  "initial_state": <JSON object — initial contents of state.json>,
  "actions_py": "<complete Python source for actions.py>",
  "update_hints": "Natural-language instruction for the voice-update pass: when the user mentions X on a call, dispatch action Y with body Z."
}

UI PRIMITIVES (use these as `type` in `ui` nodes):

  Layout:    stack {gap, children}
             grid  {cols, gap, children}
             row   {align, children}

  Display:   heading {value | bind}
             text    {value | bind, tone:"default|dim|muted", size:int}
             quote   {value | bind}
             label   {value | bind}              -- mono, dim
             pill    {value | bind, tone:"default|accent"}
             dot     {tone:"accent|muted"}
             counter {value | bind, unit, tone:"accent|ink"}
             streak  {value | bind, unit}
             bar     {value | bind, max | bind_max}

  Data:      list      {items | bind_items}            -- plain strings list
             key_value {pairs | bind_pairs}            -- pairs are {key,value,mono?}
             week_grid {bind_completions, bind_targets}-- ISO dates
             month_grid{bind_completions, days}

  *** INTERACTIVE *** (these POST to the app's endpoint and refresh state):

             text_input {
               placeholder: "...",
               submit_label: "add",
               action: "<name of function in actions.py>",
               field: "<key sent in the body>"
             }
             checkbox_list {
               bind_items: "$.state.queue",
               item_label_field: "text",     -- which field on each item to display
               item_id_field: "id",          -- which field to send back as id
               on_check_action: "<function in actions.py>",
               empty_text: "what to say when items=[]"
             }
             button {
               label: "...",
               action: "<function in actions.py>",
               body: { ... optional static payload ... },
               tone: "default|ghost"
             }

BINDINGS: a string starting with "$." resolves against the mini-app's data.
  $.state.x   — read from state
  $.computed.x — derived (queue_count_text, streak, this_week_count, completion_count, completed_count, pipeline_pairs)
  Use `bind` for the primary value prop on display primitives; use `bind_<key>`
  for any other prop (bind_items, bind_completions, bind_targets, bind_pairs).

ACTIONS.PY CONTRACT:

  Each public function: def <name>(state: dict, body: dict) -> dict
    - mutate and return the new state (or return state unchanged if no-op)
    - the dispatcher writes whatever you return to state.json

  Names must match the `action` fields you reference in the UI.
  Use kebab-case in the UI; snake_case in Python (dispatcher converts).

  Allowed imports: stdlib only (json, datetime, uuid, re, etc.).
  No third-party libraries, no I/O outside state.

EXAMPLE — a reading queue:

  {
    "id": "reading-queue",
    "title": "Reading Queue",
    "sub": "paste a link, mark it when you read",
    "size": "reg",
    "initial_state": { "queue": [], "completed": [] },
    "ui": {
      "type": "stack", "gap": 10,
      "children": [
        { "type": "label", "text": "queue" },
        {
          "type": "checkbox_list",
          "bind_items": "$.state.queue",
          "item_label_field": "text",
          "item_id_field": "id",
          "on_check_action": "mark-read",
          "empty_text": "nothing yet. paste a link below."
        },
        {
          "type": "text_input",
          "placeholder": "paste a link or title…",
          "submit_label": "add",
          "action": "add",
          "field": "text"
        }
      ]
    },
    "actions_py": "import uuid\\nfrom datetime import date\\n\\ndef add(state, body):\\n    text = (body.get('text') or '').strip()\\n    if not text: return state\\n    state.setdefault('queue', []).append({'id': uuid.uuid4().hex[:8], 'text': text, 'added': date.today().isoformat()})\\n    return state\\n\\ndef mark_read(state, body):\\n    item_id = body.get('id')\\n    queue = state.get('queue', [])\\n    item = next((i for i in queue if i.get('id') == item_id), None)\\n    if not item: return state\\n    state['queue'] = [i for i in queue if i.get('id') != item_id]\\n    state.setdefault('completed', []).append({**item, 'read': date.today().isoformat()})\\n    return state\\n",
    "update_hints": "When the user mentions an article/piece/post they want to read, POST add with body {text: \\"...\\"}. When they say they read one, POST mark-read with the matching id."
  }
"""

PROMPT_TEMPLATE = """You are the Life OS dashboard author for deardiary, a voice-first journaling app.

Your goal is to decide what — if anything — would actually HELP this specific user
right now. Not to summarize their calls back to them. Not to fill a grid. Just:
"given what I know, what tiny tool or reminder would make their life slightly easier?"

Most users, most of the time, need very few cards. Often the right answer is zero
new things and the dashboard stays as it is. Restraint is a feature.

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

YOUR JOB — read carefully:

You output TWO arrays:
  - catalog_cards: read-only summaries (mood/themes/person/project/countdown/sleep/letters/list)
  - new_apps:     proposals for new INTERACTIVE mini-apps (kind="app")

Density target by user state:
  - Brand-new user (current_day ≤ 2, ≤ 1 session): 0 catalog cards, 0-1 new app. The
    dashboard should mostly be empty with a quiet "still listening" feel. Don't
    fabricate themes/moods from one conversation.
  - Light history (3-6 days, few sessions): 1-2 catalog cards if they GENUINELY help,
    0-1 new app. Skip cards that just rephrase what was said.
  - Rich history: 3-5 catalog cards + whatever mini-apps the data justifies.

What "genuinely helps" looks like for catalog cards:
  - mood: only with 7+ days of mood data. NEVER fabricate values for days that
    weren't journaled. Skip this card otherwise.
  - themes: only if real recurring patterns exist across MULTIPLE sessions.
  - person: only if a specific person is mentioned across multiple calls with
    enough texture to draw a portrait. Not for one-mention people.
  - countdown: only for real dates the user mentioned with a deadline they care about.
  - project: only if there's an actual multi-step thing in flight, with steps that
    came from the user's words. Not a generic "do the hackathon" checklist.
  - sleep/letters/list: only when the user's content directly maps to them.

What "genuinely helps" looks like for mini-apps:
  - The user explicitly asked for accountability/tracking on something
  - There's a recurring pattern that would benefit from a simple, interactive tool
  - The user would actually open this card and CLICK something in it
  - Examples: a reading queue they can paste links into, a habit they want to track,
    a question log they want to capture as it comes up
  - NOT: passive trackers that just display old transcript content

Bias toward mini-apps when an interactive surface would help; bias toward zero
cards when nothing would.

Constraints:
- NEVER fabricate data (sparkline values for days without journals, etc.). Use what
  the user actually said.
- Be specific to *this person*. Quote their words.
- Today is {today}. Use ISO dates (YYYY-MM-DD) for date fields.

OUTPUT FORMAT: a single JSON object.

{{
  "catalog_cards": [ ... ],
  "new_apps":      [ ... ]
}}

Empty arrays are fine and often correct. No markdown fences, no commentary."""


async def generate(memory: dict) -> dict:
    """
    Ask Claude for: catalog cards (fresh) + new mini-apps (codegen).
    Writes new mini-apps to disk under backend/apps/<id>/.
    Returns {"cards": [catalog cards only], "created_apps": [ids], "skipped": [...]}.

    Existing apps already on disk are NOT re-authored — their state is preserved.
    """
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query
    from datetime import date

    sessions_text = "\n\n".join(
        _summarize_session(s) for s in reversed(memory["sessions"][-8:])
    )
    patterns_text = "\n".join(f"  - {p}" for p in memory["patterns"]) or "  (none yet)"

    existing_apps = _existing_apps_on_disk()
    existing_apps_text = _summarize_existing_apps(existing_apps)

    prompt = PROMPT_TEMPLATE.format(
        name=memory["user"]["name"],
        background=memory["user"].get("background") or "(none yet)",
        current_day=memory["user"]["current_day"],
        patterns=patterns_text,
        sessions=sessions_text,
        existing_apps=existing_apps_text,
        catalog=CATALOG_SPEC,
        today=date.today().isoformat(),
    )

    options = ClaudeAgentOptions(
        system_prompt=(
            "You author Life OS dashboards. You return ONLY a valid JSON object "
            "with keys 'catalog_cards' and 'new_apps'. No markdown, no commentary."
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

    # Catalog cards: drop any that smuggled in kind:"app" (those belong in disk apps).
    catalog_cards = [c for c in catalog_cards if isinstance(c, dict) and c.get("kind") != "app"]
    _validate_catalog_cards(catalog_cards)

    # New apps: each gets its own directory on disk.
    created, skipped = [], []
    for spec in new_apps:
        try:
            app_id = _install_app(spec, existing_apps)
            if app_id:
                created.append(app_id)
            else:
                skipped.append((spec.get("id"), "already exists"))
        except Exception as e:
            skipped.append((spec.get("id", "<no id>"), str(e)))

    return {
        "cards": catalog_cards,
        "created_apps": created,
        "skipped_apps": skipped,
    }


# Back-compat shim — old call sites used `generate_cards`. Keep them working.
async def generate_cards(memory: dict) -> list[dict]:
    result = await generate(memory)
    return result["cards"]


# ── App installer ───────────────────────────────────────────────────────────
APP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$")


def _install_app(spec: dict, existing_ids: set[str]) -> str | None:
    """Validate spec + write manifest.json/state.json/actions.py to disk.
    Returns the installed app id, or None if it already existed (skipped)."""
    if not isinstance(spec, dict):
        raise ValueError("app spec must be an object")

    app_id = spec.get("id", "").strip()
    if not APP_ID_RE.match(app_id):
        raise ValueError(f"invalid app id: {app_id!r} (must be kebab-case, 3-42 chars)")
    if app_id in existing_ids:
        return None  # preserve, don't overwrite

    for required in ("title", "ui", "initial_state", "actions_py"):
        if required not in spec:
            raise ValueError(f"app {app_id!r} missing required field: {required}")

    # Syntax-check the generated Python before writing it to disk. Logic bugs
    # we can't catch; syntax errors we definitely can.
    actions_py = spec["actions_py"]
    if not isinstance(actions_py, str):
        raise ValueError(f"app {app_id!r}: actions_py must be a string")
    try:
        ast.parse(actions_py)
    except SyntaxError as e:
        raise ValueError(f"app {app_id!r}: actions.py has a SyntaxError ({e})")

    manifest = {
        "title": spec["title"],
        "sub": spec.get("sub", ""),
        "size": spec.get("size", "reg"),
        "ui": spec["ui"],
        "config": spec.get("config", {}),
        "update_hints": spec.get("update_hints", ""),
    }

    app_dir = APPS_DIR / app_id
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (app_dir / "state.json").write_text(json.dumps(spec["initial_state"], indent=2))
    (app_dir / "actions.py").write_text(actions_py)
    return app_id


def _existing_apps_on_disk() -> list[dict]:
    """Read the on-disk app set so we can tell Claude what already exists."""
    if not APPS_DIR.exists():
        return []
    out = []
    for d in sorted(APPS_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith((".", "_")):
            continue
        manifest_file = d / "manifest.json"
        state_file = d / "state.json"
        if not manifest_file.exists():
            continue
        try:
            manifest = json.loads(manifest_file.read_text())
            state = json.loads(state_file.read_text()) if state_file.exists() else {}
            out.append({**manifest, "id": d.name, "state": state})
        except Exception as e:
            print(f"[gen_cards] skipping {d.name}: {e}")
    return out


def _summarize_existing_apps(apps: list[dict]) -> str:
    if not apps:
        return "  (none yet — propose one or two if the data clearly calls for it)"
    return "\n".join(
        f"  - id={a['id']!r} title={a.get('title', '')!r}"
        f" — {a.get('update_hints', '(no hints)')[:120]}"
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


CATALOG_KINDS = {"mood", "person", "project", "countdown", "themes", "sleep", "letters", "list"}
VALID_SIZES = {"reg", "wide", "tall"}


def _validate_catalog_cards(cards: list[dict]) -> None:
    """Shape-check catalog cards. Apps are validated separately in _install_app."""
    seen_ids = set()
    for i, c in enumerate(cards):
        if not isinstance(c, dict):
            raise ValueError(f"card[{i}] is not an object")
        for required in ("id", "kind", "title", "size"):
            if required not in c:
                raise ValueError(f"card[{i}] missing required field: {required}")
        if c["kind"] not in CATALOG_KINDS:
            raise ValueError(f"card[{i}] unknown catalog kind: {c['kind']!r}")
        if c["size"] not in VALID_SIZES:
            raise ValueError(f"card[{i}] unknown size: {c['size']!r}")
        if c["id"] in seen_ids:
            raise ValueError(f"card[{i}] duplicate id: {c['id']!r}")
        seen_ids.add(c["id"])


def main() -> int:
    memory = json.loads(MEMORY_FILE.read_text())

    print(f"Generating dashboard from {len(memory['sessions'])} sessions, "
          f"{len(memory['patterns'])} patterns, "
          f"reading from {MEMORY_FILE.name}…")
    result = asyncio.run(generate(memory))

    memory["cards"] = result["cards"]
    MEMORY_FILE.write_text(json.dumps(memory, indent=2))

    print(f"\nCatalog cards: {len(result['cards'])}")
    for c in result["cards"]:
        print(f"  [{c['kind']:9s}] {c['id']:18s} {c['title']}")

    print(f"\nApps created: {len(result['created_apps'])}")
    for app_id in result["created_apps"]:
        print(f"  + {app_id}")

    if result["skipped_apps"]:
        print(f"\nApps skipped: {len(result['skipped_apps'])}")
        for app_id, reason in result["skipped_apps"]:
            print(f"  - {app_id}: {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
