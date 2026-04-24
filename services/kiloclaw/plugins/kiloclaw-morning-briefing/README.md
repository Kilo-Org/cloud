# KiloClaw Morning Briefing

Bundled OpenClaw plugin for daily issue/news briefings in KiloClaw instances.

## Commands

- `/briefing enable`
- `/briefing status`
- `/briefing run`
- `/briefing today`
- `/briefing yesterday`
- `/briefing disable`

## Tooling

- `morning_briefing_generate`
- `morning_briefing_read`
- `morning_briefing_handle_command`

## Storage

Writes Markdown files under:

- `<OPENCLAW_STATE_DIR>/morning-briefing/briefings/YYYY-MM-DD.md`

Plus metadata under:

- `<OPENCLAW_STATE_DIR>/morning-briefing/config.json`
- `<OPENCLAW_STATE_DIR>/morning-briefing/status.json`
