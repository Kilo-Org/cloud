# Cloud Agent idle / resume UX

**Date**: 2026-08-14
**Sessions**: `ses_0000fc8c8fffAarkAyzQxETLgR`, `ses_0006d963bfff1VGhJQpsOaVMd7`, `ses_00ac914f1ffclGfN1TUIxElpsn`
**Scope**: Make completed / resumed Cloud Agent sessions look finished and continueable. Do not treat this as a sandbox crash problem.

## What actually happened

None of the three sessions died from Worker 5xx, hung-execution, SIGTERM, or OOM-kill.

| Session | User-visible complaint | What the logs + message history show |
|---|---|---|
| `ses_0000fc8c8fff` | Stopped randomly; cannot resume | Turn 1 finished with `finish=stop` at 11:31:49. Keep-warm then tore the wrapper down at 11:37. Resume `continue` at 11:42 worked on a warm workspace and also finished with `finish=stop` at 12:27:25. Follow-up at 12:29:53 (`please reset to the first commit`) started, then was aborted 18s later (`MessageAbortedError` / `user-interrupt`). |
| `ses_0006d963bfff` | Unspecified / also broken | Turn 1 finished with `finish=stop` at 10:06:51 (PR #5270). Keep-warm cleanup at 10:12. Resume at 11:47 was a **cold** restore: 7/8 snapshot diffs failed (`git apply` 128). Follow-up started, spawned a `@general` subagent, then was aborted at 11:54:52 (`MessageAbortedError` / `user-interrupt`). |
| `ses_00ac914f1fff` | Hangs forever | Original Aug 12 turn finished with `finish=stop` at 09:47:42 (PR #5219). Later turns on Aug 14 08:05 and 14:08 also finished with `finish=stop`. Today's resume was cold: 11/13 diffs failed. Wrapper idled at 14:08:19, auto-committed, and never sent `sending complete event`. |

Message history agrees with the wrapper/Axiom theory, with one correction:

- The “random stop” on session 1 was a **real completed turn**, not a crash. The user then typed `continue` because the UI still looked unfinished.
- The “cannot resume” / “hangs forever” cases are **completion not being published to the client**, plus **cold restore dropping workspace files**.
- The later hard stops on sessions 1 and 2 are **user-interrupt / abort**, not sandbox death. Session 1’s last user text (`what the flying fuck did you do`) is the user reacting to a resume that kept going after they thought the session had already stopped.

## Root causes to fix

### 1. Idle is not treated as complete

Wrapper receives `session.idle`, may auto-commit, closes ingest, and **does not send `complete`**.

Evidence:

- Session 1: `session.idle` 12:27:32, then `SSE transport timeout` / `skipping restored network resume: no kiloSessionId`. No `sending complete event`.
- Session 3: `session.idle` 14:08:19, auto-commit + push succeeded. No `sending complete event`.
- Message history already has `finish=stop` on those turns. The Kilo transcript knows the turn ended; Cloud Agent / the web UI do not.

User effect: spinner forever, session looks running after the agent is done, Resume looks like it does nothing or continues a “still running” turn.

### 2. Keep-warm teardown looks like a crash

After a completed turn the wrapper stays up. ~5 minutes later:

`Keep-warm deadline expired` → `Stopping idle kilo server` → `idle-timeout`.

The execution was already done. The client still thinks it is live, so the teardown reads as “it stopped randomly”.

### 3. Cold snapshot restore drops the workspace

On cold resume (`workspaceWasWarm=false`):

- Snapshot download + `kilo import` succeed.
- File diffs then fail with `git apply` exit 128.
- Session 2: 1/8 applied, 7 skipped.
- Session 3: 2/13 applied, 11 skipped.
- Restore still logs `completed successfully`.

Warm resume (session 1 at 11:42) kept the workspace and worked.

User effect: resume starts, then the agent cannot see the files it just wrote. Follow-up looks insane (`what the flying fuck did you do`). That is a restore bug, not a model bug.

### 4. Child / subagent idle is easy to misread

Session 1 ignored `session.idle` for child `ses_fffdbba9fffe…`. Session 2’s resume was mostly a `@general` subagent when it was aborted. Parent completion and child completion must not be conflated, but parent idle after the parent `finish=stop` **must** still complete the Cloud Agent turn.

### 5. Abort / interrupt is silent in the transcript

Sessions 1 and 2 end a follow-up with `MessageAbortedError` and no assistant text. The UI should show “stopped” / “interrupted”, not leave the last tool-call hanging.

## Work to do

Priority is user-visible correctness, smallest coherent diffs.

### P0 — Publish completion on parent `session.idle`

When the **current** kilo session goes idle after a real turn (`finish=stop` or equivalent), the wrapper must emit the same completion path as a healthy finish (`sending complete event`, `completionSource` that the UI already understands).

Do not wait for keep-warm expiry. Do not require a later user interrupt.

Check:

- Parent idle after `finish=stop` → client leaves busy state.
- Child idle is still ignored (existing `ignoring session.idle for child session` behavior).
- Auto-commit can still run; it must not block or replace the complete event.

### P0 — Surface restore loss instead of pretending success

`restore-session: diffs applied=N skipped=M` with `M > 0` is not success.

Preserve successfully restored files and continue the session, but surface the
partial result visibly (“cold restore incomplete, N/M files restored”). Retry or
fall back when a skipped file can be written another way, and never log
`completed successfully` when diffs were skipped.

Until this is honest, users will resume into a lie.

### P0 — Show aborted follow-ups as interrupted

`MessageAbortedError` / `user-interrupt` should flip the turn to interrupted in the transcript and session status. Empty reasoning + spinner is the current UX.

### P1 — Do not look dead during keep-warm

If the turn is already complete, keep-warm teardown is maintenance. The session list / thread should already be idle. If we cannot emit complete in P0, at least map `keep-warm-expired` / `idle-timeout` after a `finish=stop` to idle, not failed/running.

### P1 — Make resume status explicit

On resume, tell the user which path ran:

- warm workspace reused
- cold restore, snapshot applied, N/M files restored
- cold restore incomplete

Session 1’s successful warm `continue` vs sessions 2/3’s cold partial restore is the difference between “resume works” and “resume is broken”.

### P2 — Title report 502

Session 1 spammed `session title report failed` / `http_502` for the whole first turn. Not the hang, but it is noisy and may hide real errors. Separate follow-up.

## Out of scope

- Raising container lifetime / keep-warm as the fix. These sessions completed before teardown.
- Treating `user-interrupt` as a platform bug. After a hung-looking UI, users (or the client) will hit stop.
- Changing model / prompt behavior. Transcripts show the agent did the asked work when the workspace was intact.

## How to verify

Re-use these sessions’ shapes rather than inventing new scenarios:

1. Long turn that ends with `finish=stop` and no further prompt. UI must go idle within seconds of `session.idle`, before keep-warm (~5 min).
2. Same session, wait for keep-warm, send `continue`. Warm path should restore files and accept the prompt.
3. Cold resume of a session whose snapshot has several file diffs. Either all diffs apply, or the UI shows a restore failure. `completed successfully` with skipped diffs is a fail.
4. Start a follow-up and stop it. Transcript shows interrupted, not an endless last tool call.
5. Parent + child session: child idle must not complete the parent; parent idle must.

## Evidence

- Axiom `cloudflare-logpush` / `cloud-agent-next` for the three `agent_*` IDs.
- R2 wrapper logs under `/tmp/cloud-agent-cli-logs/agent_{2a6081d0,76e90819,9eb90c41}-…/`
- Admin message dumps:
  - `session-messages-ses_0000fc8c8fffAarkAyzQxETLgR.json`
  - `session-messages-ses_0006d963bfff1VGhJQpsOaVMd7.json`
  - `session-messages-ses_00ac914f1ffclGfN1TUIxElpsn.json`
