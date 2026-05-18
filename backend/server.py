"""
deardiary backend — FastAPI server

Endpoints:
  POST /call                  Trigger outbound call from CB to user
  GET  /call/{call_id}/status Poll call status; sends SMS if no-answer
  GET  /sessions              Return all journal sessions
  GET  /cards                 Return Life OS cards
  POST /webhook               Handle AgentPhone post-call events

Run with:
  uvicorn server:app --reload --port 8000
"""

import json
import os
import time
from datetime import datetime
from pathlib import Path

import requests
from agentphone import AgentPhone
from dotenv import find_dotenv, load_dotenv

# Load .env from the repo root (one level up from backend/).
load_dotenv(find_dotenv(usecwd=False))

from extract import build_system_prompt, extract_session_notes
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

app = FastAPI()

# Allow the Vite frontend (port 5173) to call this backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-developer memory file. Each dev sets DEARDIARY_MEMORY=memory.<name>.json
# in their local .env to journal as themselves without trampling the shared
# memory.json demo state.
MEMORY_FILENAME = os.environ.get("DEARDIARY_MEMORY", "memory.json")
MEMORY_FILE = os.path.join(os.path.dirname(__file__), MEMORY_FILENAME)
AP_API_KEY = os.environ.get("AGENTPHONE_API_KEY", "")
AMAN_PHONE = os.environ.get("AMAN_PHONE_NUMBER", "")
print(f"[deardiary] memory file: {MEMORY_FILENAME}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_memory() -> dict:
    with open(MEMORY_FILE, "r") as f:
        return json.load(f)


def save_memory(memory: dict) -> None:
    with open(MEMORY_FILE, "w") as f:
        json.dump(memory, f, indent=2)


def ap_client() -> AgentPhone:
    return AgentPhone(api_key=AP_API_KEY)


def send_sms(to_number: str, text: str) -> None:
    """Send a check-in SMS from CB's AgentPhone number."""
    memory = load_memory()
    agent_id = memory["config"].get("agent_id", "")
    if not agent_id:
        print("No agent_id configured — SMS skipped.")
        return

    try:
        ap_client().messages.send(agent_id=agent_id, to_number=to_number, body=text)
    except Exception as e:
        print(f"SMS send failed: {e}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/call")
async def trigger_call(request: Request):
    """
    Trigger CB to call the user.
    Reads memory, builds a fresh system prompt with today's context,
    fires the outbound call, returns the call_id for status polling.
    """
    # Always call AMAN_PHONE_NUMBER from .env — the frontend doesn't pass this
    # so users can't accidentally trigger calls to arbitrary numbers.
    to_number = AMAN_PHONE
    if not to_number:
        raise HTTPException(status_code=400, detail="AMAN_PHONE_NUMBER not set in .env")

    memory = load_memory()
    agent_id = memory["config"].get("agent_id")
    if not agent_id:
        raise HTTPException(status_code=500, detail="Agent not set up yet. Run setup.py first.")

    system_prompt = build_system_prompt(memory)
    user_name = memory["user"]["name"]

    # The opening line CB says the moment the call connects.
    begin_message = (
        f"Hey {user_name}. "
        f"Today's the day — Meta interview, right? How are you feeling about it?"
    )

    client = ap_client()
    call = client.calls.make(
        agent_id=agent_id,
        to_number=to_number,
        system_prompt=system_prompt,
        initial_greeting=begin_message,
    )

    return {"call_id": call.id, "status": "calling"}


@app.post("/entry")
async def add_journal_entry(request: Request):
    """
    Save a typed journal entry to today's session in memory.json.
    Appends as a user turn so it lives alongside voice transcript turns —
    Part 2 reads both identically without knowing the source.
    """
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    memory = load_memory()
    sessions = memory["sessions"]

    today_idx = next((i for i, s in enumerate(sessions) if s.get("isToday")), None)
    if today_idx is None:
        raise HTTPException(status_code=404, detail="No open session for today")

    sessions[today_idx]["transcript"].append({"who": "u", "text": text})
    save_memory(memory)

    return {"ok": True, "session": sessions[today_idx]}


@app.get("/call/{call_id}/status")
async def call_status(call_id: str, background_tasks: BackgroundTasks):
    """
    Poll the status of an active or completed call.
    If the call was not answered, schedule an SMS check-in.
    Returns: { status: "calling" | "connected" | "completed" | "no_answer" }
    """
    client = ap_client()
    call = client.calls.get(call_id)
    status = getattr(call, "status", "unknown")

    if status in ("no_answer", "busy", "failed"):
        memory = load_memory()
        user_name = memory["user"]["name"]
        background_tasks.add_task(
            send_sms,
            AMAN_PHONE,
            f"Hey {user_name}, missed you. Hope everything's okay. "
            f"Call me whenever you're free. - CB",
        )
        return {"status": "no_answer"}

    # Call finished — kick off note extraction in the background since the
    # webhook can't reach us on localhost.
    if status in ("completed", "ended"):
        background_tasks.add_task(process_call, call_id)

    return {"status": status}


@app.get("/config")
async def get_config():
    """Return public config the frontend needs — agent phone number."""
    memory = load_memory()
    return {"agent_phone_number": memory["config"].get("agent_phone_number", "")}


@app.get("/sessions")
async def get_sessions():
    """Return all journal sessions for the frontend."""
    memory = load_memory()
    return {"sessions": memory["sessions"]}


@app.get("/cards")
async def get_cards():
    """Return Life OS cards for the frontend dashboard."""
    memory = load_memory()
    return {"cards": memory["cards"]}


@app.post("/regenerate-cards")
async def regenerate_cards():
    """Re-author the cards array from sessions + patterns via Claude. Synchronous
    so the frontend can refetch /cards immediately after this returns."""
    import asyncio
    from gen_cards import generate_cards

    memory = load_memory()
    cards = await asyncio.to_thread(asyncio.run, generate_cards(memory))
    memory["cards"] = cards
    save_memory(memory)
    return {"ok": True, "count": len(cards), "kinds": [c["kind"] for c in cards]}


@app.post("/update-apps")
async def update_apps_endpoint():
    """Run the post-call state updater against the latest session. Useful for
    demos when you want to show mini-apps mutating without re-triggering a call."""
    import asyncio
    from update_apps import update_apps_from_transcript

    memory = load_memory()
    patches = await asyncio.to_thread(asyncio.run, update_apps_from_transcript(memory))
    if patches:
        for c in memory["cards"]:
            if c["id"] in patches and c.get("kind") == "app":
                c["state"] = patches[c["id"]]
        save_memory(memory)
    return {"ok": True, "updated": list(patches.keys())}


@app.post("/process-call/{call_id}")
async def manual_process(call_id: str, background_tasks: BackgroundTasks):
    """Manually trigger note extraction for a call that already ended.
    Runs in a background thread so asyncio.run() works inside extract.py.
    """
    background_tasks.add_task(process_call, call_id)
    return {"ok": True, "message": "Processing started. GET /sessions in ~10s to see results."}


@app.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks):
    """
    AgentPhone calls this endpoint when a call ends.
    Fetches the transcript, extracts notes, appends the new session to memory.

    Register this URL in the AgentPhone dashboard:
      https://<your-ngrok-or-server-url>/webhook
    """
    payload = await request.json()
    event = payload.get("event") or payload.get("type", "")

    if event != "agent.call_ended":
        return {"ok": True}

    call_id = payload.get("call_id") or payload.get("id")
    background_tasks.add_task(process_call, call_id)
    return {"ok": True}


# ── Background task: process completed call ───────────────────────────────────

def process_call(call_id: str) -> None:
    """
    Fetch transcript from AgentPhone, extract notes with Claude,
    append a new session to memory.json.
    Runs in the background so the webhook returns immediately.
    """
    # Give AgentPhone a moment to finalise the transcript.
    time.sleep(3)

    try:
        client = ap_client()
        data = client.calls.get_transcript(call_id)
    except Exception as e:
        print(f"Failed to fetch transcript for {call_id}: {e}")
        return

    # Transcript shape from AgentPhone: list of {role, content} or {who, text}.
    # Normalise to the {who, text} shape the frontend expects.
    raw_turns = data.get("transcript") or data.get("turns") or []
    turns = []
    for t in raw_turns:
        who = "a" if t.get("role") in ("assistant", "agent") else "u"
        text = t.get("content") or t.get("text", "")
        if text:
            turns.append({"who": who, "text": text})

    if not turns:
        print(f"Empty transcript for call {call_id} — skipping.")
        return

    memory = load_memory()

    # Extract structured notes from the transcript.
    try:
        notes = extract_session_notes(turns, memory["patterns"])
    except Exception as e:
        print(f"Note extraction failed: {e}")
        notes = {
            "title": "untitled session",
            "mood": "unknown",
            "themes": [],
            "pattern_observed": None,
            "companies_mentioned": [],
            "follow_up": None,
        }

    now = datetime.now()
    new_session = {
        "id": f"call-{call_id[:8]}",
        "date": now.strftime("%Y-%m-%d"),
        "weekday": now.strftime("%A"),
        "time": now.strftime("%-I:%M %p"),
        "duration": _estimate_duration(turns),
        "mood": notes.get("mood", ""),
        "title": notes.get("title", ""),
        "isToday": False,
        "transcript": turns,
    }

    # Replace the "today" placeholder session with the real transcript,
    # keeping id="today" and isToday=true so the UI's default view still
    # lands on this session.
    sessions = memory["sessions"]
    today_idx = next((i for i, s in enumerate(sessions) if s.get("isToday")), None)
    if today_idx is not None:
        sessions[today_idx] = {**new_session, "id": "today", "isToday": True}
    else:
        sessions.append(new_session)

    # Update patterns if something new was observed.
    if notes.get("pattern_observed"):
        memory["patterns"].append(notes["pattern_observed"])

    memory["user"]["current_day"] += 1
    save_memory(memory)
    print(f"Session saved: {new_session['title']}")

    # Close the voice loop: hand the fresh transcript to the Life OS state
    # updater so any mini-apps with matching update_hints mutate in place.
    # Failures here must not break call processing — the dashboard just won't
    # reflect this call until the next refresh.
    try:
        import asyncio
        from update_apps import update_apps_from_transcript

        fresh_memory = load_memory()
        patches = asyncio.run(update_apps_from_transcript(fresh_memory))
        if patches:
            for c in fresh_memory["cards"]:
                if c["id"] in patches and c.get("kind") == "app":
                    c["state"] = patches[c["id"]]
            save_memory(fresh_memory)
            print(f"Updated {len(patches)} mini-app(s): {list(patches.keys())}")
    except Exception as e:
        print(f"Mini-app update failed (non-fatal): {e}")


def _estimate_duration(turns: list[dict]) -> str:
    """Rough duration label based on number of turns."""
    n = len(turns)
    if n <= 4:
        return "~2 min"
    if n <= 10:
        return "~5 min"
    if n <= 20:
        return "~10 min"
    return "~15 min"
