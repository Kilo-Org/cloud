# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

## Orchestrator

### iOS 26.5 scheme-confirmation prompt wording breaks login.sh on a fresh install

- Symptom: on a freshly installed dev client, `apps/mobile/e2e/login.sh` fails its settle assertion with the simulator stuck on the home screen under a SpringBoard dialog `Open in "Kilo"?` (Cancel/Open).
- Cause: iOS 26.5 reworded the custom-scheme confirmation from `Open this page in "Kilo"?` to `Open in "Kilo"?`. The matchers in `e2e/flows/open-app.yaml` and `e2e/flows/settle-app.yaml` only know the old text, so the bounded optional-prompt tap never fires. The dialog appears exactly once per install (first external open of the `exp+kilo-app` scheme); iOS does not re-prompt afterwards.
- Fix: tap `Open` once yourself (a two-line temp Maestro flow with `appId: host.springboard` and `tapOn: { text: 'Open', optional: true }`, or any equivalent), then re-run `login.sh` — it is idempotent and completes. Do not reinstall afterwards: a reinstall re-arms the one-time prompt. If the flows are ever updated, add `Open in "Kilo"\?` as an alternative in the same regexes rather than replacing the old text, so older iOS versions keep working.

### Role-agent kilo run dies silently when the session payload exceeds the pruning limit

- Symptom: a dispatched `kilo run` role agent (observed: mobile-e2e-verifier) exits mid-task with no error and no final report; its transcript just stops, often right after a large tool output.
- Cause: the agent's session payload grows past the pruning limit (`opencode.log` shows `payload still large after pruning ... size=3042931` at the kill time) and the harness terminates the run. E2E agents inflate the payload fast: full `maestro hierarchy` dumps (~80 KB), full `pnpm dev:capture mobile` panes with the QR art, repeated echo of the same long command output, screenshots read into context.
- Fix: steer the redispatch with an explicit output-discipline constraint: every shell command ends in a hard cap (`| tail -c 1500` / `| tail -5`), hierarchies and captures go to files and only greps/counts are printed, screenshots are not re-read into context, docs are inlined in the handoff instead of re-read, and the final report has a line cap. A round-3 dispatch with these rules survives long enough to finish; rounds 1-2 without them died at ~4-10 minutes.

### Deterministic cloud-agent turns via fake-llm (real-provider turns stall E2E)

- Symptom: the E2E verifier starts an app-driven cloud-agent session and the turn never completes: "Considering next steps" for 9+ minutes, or `terminal-failed`, while real-provider routing burns credits and time. Round after round cannot score the turn-based acceptance criteria.
- Cause: `KILO_OPENROUTER_BASE` in `services/cloud-agent-next/.dev.vars` points at nextjs (`http://localhost:<nextjs-port>/api`), i.e. real model providers — non-deterministic and slow in dev. Three environment traps compound it: (1) `e2e/login.sh` signs out first, so a verifier that "re-runs login" mid-task strands the app on the login screen (never let it); (2) a hermetic `platform_integrations` row with a made-up repo (e.g. `kilo-stub/...`) passes the composer repo picker but fails dispatch with `GitHub token or active app installation required` — the cached repo must belong to a real, locally mintable installation (e.g. `iscekic/getel`, installation `144771093`); (3) fake-llm stock only knows model `fake-deterministic`, so worker-side `models/validate` and the sandbox CLI's catalog lookup both reject the app's `kilo-auto/*` selection (`model_missing`, classified `managed_model_configuration`).
- Fix: route the turn to fake-llm and re-apply this harness patch set (deliberately not committed — harness-local): set `KILO_OPENROUTER_BASE=http://localhost:<8811+portOffset>/api` in `services/cloud-agent-next/.dev.vars` and `pnpm dev:restart cloud-agent-next`; in `services/cloud-agent-next/test/e2e/fake-llm-server.ts` accept `kilo-auto/*` + `kilo/*` in `handleModelValidation` AND add catalog entries for `kilo-auto/frontier|balanced|efficient` (clone `FAKE_MODEL`, non-zero pricing e.g. `0.000003`/`0.000015` so cost computes non-zero); `pnpm dev:restart fake-llm`. Prompt `__fake__:echo:<text>` in the composer — the assistant replies `<text>` with usage, the session auto-titles `<text>`, and the title-model call is handled by design. A cloud turn then completes in ~30s with cost pill + model label visible. Revert the patch, restore `.dev.vars`, and delete the fixture rows when done.
