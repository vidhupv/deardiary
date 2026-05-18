"""
Voice-loop closer: after a call, dispatch actions on filesystem mini-apps
based on what the user said.

Reads backend/apps/<id>/ to find the candidate set of apps. For each one,
gives Claude:
  - the app id
  - title
  - update_hints (the natural-language rule for when to dispatch which action)
  - current state.json
  - which actions are exported by actions.py (just the function names)
  - the latest transcript

Claude returns a list of action calls. We dispatch each through the same
(state, body) -> new_state pipeline that the HTTP action endpoint uses, so
voice-driven mutations and UI-click mutations end up at the same code path.

Run with:
    cd backend && ../backend/.venv/bin/python update_apps.py [session_id]

If no session_id is given, uses today's open session (or the most recent).
Authenticates via the local `claude` CLI — no API key needed.
"""

import asyncio
import ast
import importlib.util
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

BACKEND_DIR = Path(__file__).parent
APPS_DIR = BACKEND_DIR / "apps"

MEMORY_FILE = BACKEND_DIR / os.environ.get("DEARDIARY_MEMORY", "memory.json")


PROMPT_TEMPLATE = """You are the Life OS voice-loop closer for deardiary.

A call just ended. Your job: decide whether anything the user said should
trigger an action on one of their mini-apps. Be conservative — most calls
mention things in passing without expecting state to change. Only dispatch
an action when the user clearly intends it.

TODAY: {today}

LATEST CALL TRANSCRIPT:
{transcript}

MINI-APPS (each app's update_hints describes when to dispatch which action):
{apps}

OUTPUT FORMAT: a single JSON array of action calls. Each call is:
  {{ "app_id": "<id>", "action": "<action-name>", "body": {{ ... }} }}

Empty array `[]` is fine and often correct. No markdown, no commentary.

Rules:
- The action-name must be one this app's actions.py actually exports.
- The body must match what that action expects (use the update_hints).
- If a single user statement implies multiple actions (e.g. "add A and B"),
  emit multiple entries.
- If the user said "remove X" or "stop tracking X", use the appropriate
  remove/mark-done action — never invent a new action name.
"""


async def compute_actions(memory: dict, session_id: str | None = None) -> list[dict]:
    """Returns a list of action calls Claude wants dispatched. May be empty."""
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

    apps = _list_apps()
    if not apps:
        return []

    session = _pick_session(memory, session_id)
    if not session or not session.get("transcript"):
        return []

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
            "You decide which mini-app actions to dispatch based on a call "
            "transcript. You return ONLY a valid JSON array of action calls."
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

    calls = json.loads(raw)
    if not isinstance(calls, list):
        raise ValueError(f"expected JSON array, got {type(calls).__name__}")
    return calls


def dispatch(calls: list[dict]) -> list[dict]:
    """Run each action call against its app's actions.py. Returns a list of
    {app_id, action, ok, error?} so the caller can report what happened."""
    results = []
    for call in calls:
        app_id = call.get("app_id")
        action = call.get("action")
        body = call.get("body") or {}
        if not app_id or not action:
            results.append({**call, "ok": False, "error": "missing app_id or action"})
            continue
        try:
            _execute_action(app_id, action, body)
            results.append({"app_id": app_id, "action": action, "ok": True})
        except Exception as e:
            results.append({"app_id": app_id, "action": action, "ok": False, "error": str(e)})
    return results


def _execute_action(app_id: str, action: str, body: dict) -> None:
    """Mirror server.py's dispatcher — load actions.py fresh, call the handler,
    persist the returned state."""
    app_dir = APPS_DIR / app_id
    if not app_dir.is_dir():
        raise FileNotFoundError(f"app {app_id!r} not found on disk")
    actions_path = app_dir / "actions.py"
    if not actions_path.exists():
        raise FileNotFoundError(f"app {app_id!r} has no actions.py")

    state_path = app_dir / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    spec = importlib.util.spec_from_file_location(f"apps.{app_id}.actions", actions_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    handler_name = action.replace("-", "_")
    handler = getattr(module, handler_name, None)
    if not callable(handler):
        raise AttributeError(f"app {app_id!r} has no action {handler_name!r}")

    new_state = handler(state, body) or state
    state_path.write_text(json.dumps(new_state, indent=2))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _list_apps() -> list[dict]:
    """Each app's id, title, current state, update_hints, and exported actions."""
    if not APPS_DIR.exists():
        return []
    out = []
    for d in sorted(APPS_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith((".", "_")):
            continue
        try:
            manifest = json.loads((d / "manifest.json").read_text())
            state = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else {}
            actions = _list_actions(d / "actions.py")
            out.append({
                "id": d.name,
                "title": manifest.get("title", d.name),
                "update_hints": manifest.get("update_hints", "(no hints)"),
                "state": state,
                "actions": actions,
            })
        except Exception as e:
            print(f"[update_apps] skipping {d.name}: {e}")
    return out


def _list_actions(actions_path: Path) -> list[str]:
    """Parse actions.py and return the names of all top-level functions —
    the dispatcher will translate '-' to '_', so we surface them un-translated
    (snake_case) for the prompt and let Claude use kebab-case if it wants."""
    if not actions_path.exists():
        return []
    try:
        tree = ast.parse(actions_path.read_text())
    except SyntaxError:
        return []
    return [
        node.name for node in tree.body
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_")
    ]


def _pick_session(memory: dict, session_id: str | None) -> dict | None:
    sessions = memory.get("sessions", [])
    if not sessions:
        return None
    if session_id is None:
        today = next((s for s in sessions if s.get("isToday")), None)
        return today or sessions[-1]
    return next((s for s in sessions if s["id"] == session_id), None)


def _describe_app(app: dict) -> str:
    return (
        f"### {app['id']}\n"
        f"  title: {app['title']}\n"
        f"  exported actions: {', '.join(app['actions']) or '(none)'}\n"
        f"  update_hints: {app['update_hints']}\n"
        f"  current state: {json.dumps(app['state'], indent=2)}"
    )


# ── Backward-compat shim ─────────────────────────────────────────────────────
# server.py still imports `update_apps_from_transcript`. Keep it callable; it
# now wraps compute_actions + dispatch and returns the same shape it used to
# (app_id -> latest state) so existing callers keep working.

async def update_apps_from_transcript(memory: dict, session_id: str | None = None) -> dict[str, dict]:
    calls = await compute_actions(memory, session_id)
    if not calls:
        return {}
    dispatch(calls)
    # Read fresh state per touched app.
    touched = sorted({c["app_id"] for c in calls if c.get("app_id")})
    return {
        app_id: json.loads((APPS_DIR / app_id / "state.json").read_text())
        for app_id in touched
        if (APPS_DIR / app_id / "state.json").exists()
    }


def main() -> int:
    session_id = sys.argv[1] if len(sys.argv) > 1 else None
    memory = json.loads(MEMORY_FILE.read_text())

    app_count = len(_list_apps())
    print(f"Checking {app_count} app(s) against "
          f"{'session ' + session_id if session_id else 'latest session'}…")

    calls = asyncio.run(compute_actions(memory, session_id))
    if not calls:
        print("No actions needed.")
        return 0

    print(f"\nDispatching {len(calls)} action(s):")
    for c in calls:
        print(f"  → {c.get('app_id')}/{c.get('action')}  body={json.dumps(c.get('body', {}))}")

    results = dispatch(calls)
    ok = sum(1 for r in results if r.get("ok"))
    bad = [r for r in results if not r.get("ok")]
    print(f"\n{ok}/{len(results)} succeeded.")
    for r in bad:
        print(f"  ✗ {r['app_id']}/{r['action']}: {r.get('error')}")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
