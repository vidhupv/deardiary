"""
Bootstrap a private memory file for personal dev/journaling.

Usage:
    cd backend && python init_dev_memory.py <your-name>

Creates memory.<your-name>.json from memory.template.json, with user.name set,
today's date filled in, and prints the env var line you should add to your .env
so the backend reads YOUR memory file instead of the shared demo (memory.json).

The created file is gitignored — your journaling stays local.
"""

import json
import sys
from datetime import date as _date
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATE = HERE / "memory.template.json"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    name = sys.argv[1].strip()
    if not name or not name.replace("-", "").replace("_", "").isalnum():
        print(f"name must be alphanumeric (dashes/underscores ok): got {name!r}")
        return 1

    out = HERE / f"memory.{name}.json"
    if out.exists():
        print(f"refusing to overwrite existing {out.name}. "
              f"Delete it manually if you want to reset.")
        return 1

    memory = json.loads(TEMPLATE.read_text())
    memory["user"]["name"] = name.capitalize()

    today = _date.today()
    memory["sessions"][0]["date"] = today.isoformat()
    memory["sessions"][0]["weekday"] = today.strftime("%A")

    out.write_text(json.dumps(memory, indent=2))

    print()
    print(f"  created: {out.name}")
    print(f"  user.name: {memory['user']['name']}")
    print(f"  today: {today.isoformat()} ({today.strftime('%A')})")
    print()
    print(f"Add this to your local .env (in the repo root):")
    print()
    print(f"  DEARDIARY_MEMORY={out.name}")
    print()
    print(f"Then edit {out.name} to set user.background to something real about you,")
    print(f"and restart the backend. The frontend will pick up your memory immediately.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
