"""
Run once to create the CB agent on AgentPhone and buy a phone number.
Prints the env-var lines to paste into .env (and into .env.example, so other
developers cloning the repo pick up the same agent).

Usage:
    cd backend
    python setup.py
"""

import os
from agentphone import AgentPhone
from dotenv import load_dotenv

load_dotenv()


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

    print()
    print("=" * 60)
    print("Agent identity is now live. Paste these into your .env:")
    print()
    print(f"  AGENT_ID={agent.id}")
    print(f"  AGENT_PHONE_NUMBER={phone}")
    print()
    print("And update .env.example with the same lines so other developers")
    print("pick up the new agent on their next clone.")
    print("=" * 60)


if __name__ == "__main__":
    main()
