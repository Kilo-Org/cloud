# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

## Orchestrator

### SpringBoard `Open in "Kilo"?` confirmation blocks `simctl openurl` (2026-07-27, PR #4697 main-merge)

- Symptom: `e2e/login.sh` fails at settle-app: after preflight's `xcrun simctl openurl` a SpringBoard dialog `Open in "Kilo"?` (curly quotes, Cancel/Open buttons) stays on screen; `settle-app.yaml` only matched the Safari wording `Open this page in "Kilo"?` and timed out.
- Cause: origin/main added `associatedDomains: ['applinks:app.kilo.ai']` (universal links) in `app.config.ts`; with the merged build installed, opening the custom scheme via `simctl openurl` surfaces a SpringBoard confirmation the flows did not handle.
- Fix: match both wordings in `e2e/flows/settle-app.yaml` and `e2e/flows/open-app.yaml` (`Open in ["“”]Kilo["“”]\?` alongside the Safari string) and tap `Open` in the same bounded optional-prompt slot; updated the stale "skips Safari's confirmation" bullet in `e2e/AGENTS.md`.
