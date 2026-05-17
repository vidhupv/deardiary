"""
Run once to create the CB agent on AgentPhone and buy a phone number.
Writes agent_id and agent_phone_number back into memory.json.

Usage:
    cd backend
    python setup.py
"""

import json
import os
from agentphone import AgentPhone
from dotenv import load_dotenv

load_dotenv()

MEMORY_FILE = os.path.join(os.path.dirname(__file__), "memory.json")


def main():
    api_key = os.environ.get("AGENTPHONE_API_KEY")
    if not api_key:
        raise SystemExit("AGENTPHONE_API_KEY not set in .env")

    client = AgentPhone(api_key=api_key)

    print("Creating CB agent on AgentPhone...")
    agent = client.agents.create(
        name="CB",
        voice_mode="hosted",
        model_tier="max",
        # beginMessage is overridden per-call with memory context,
        # but we set a safe fallback here.
        begin_message="Hey. How are you doing?",
        system_prompt=(
            "You are CB, a wellness companion. "
            "You talk like a close friend who pays attention, not a therapist."
        ),
    )
    print(f"  Agent created: {agent.id}")

    print("Buying a phone number...")
    number = client.numbers.buy(agent_id=agent.id)
    phone = getattr(number, "phone_number", None) or getattr(number, "number", None)
    print(f"  Number: {phone}")

    # Write IDs back into memory.json so server.py can use them.
    with open(MEMORY_FILE, "r") as f:
        memory = json.load(f)

    memory["config"]["agent_id"] = agent.id
    memory["config"]["agent_phone_number"] = phone

    with open(MEMORY_FILE, "w") as f:
        json.dump(memory, f, indent=2)

    print(f"\nDone. CB is live at {phone}")
    print("You can now run: uvicorn server:app --reload --port 8000")


if __name__ == "__main__":
    main()
