"""Aura Local Mac Agent.

  python -m local_agent              run the agent (launchd runs this)
  python -m local_agent allow NAME PATH   authorize an extra folder (local action only)
  python -m local_agent roots        show authorized folders and macOS access status
"""
import json
import sys

from local_agent.config import add_root, load_config


def cli():
    args = sys.argv[1:]
    if args[:1] == ["allow"] and len(args) == 3:
        add_root(args[1], args[2])
        print(f"Authorized {args[1]} → {args[2]}. Restart the agent: launchctl kickstart -k gui/$(id -u)/com.aura.localagent")
    elif args[:1] == ["roots"]:
        from local_agent.mac_permissions.check import check_roots
        print(json.dumps(check_roots(load_config()), indent=2))
    elif not args:
        from local_agent.background_service.service import main
        main()
    else:
        print(__doc__)
        sys.exit(2)


cli()
