# `dev:start` refuses on `kiloclaw-docker-tcp:23750` even though the shared bridge is healthy — retry once

Symptom: `pnpm dev:start` fails with `Refusing to share occupied worktree service ports: kiloclaw-docker-tcp:23750`, while `curl http://127.0.0.1:23750/_ping` (and even `/v1.44/_ping`) returns `OK` with an `Api-Version` header — the exact thing the runner's own probe requires.

Cause: the reuse branch in `dev/local/cli.ts` only runs when `probeDockerApi(23750)` (`dev/local/docker-api-probe.ts`) succeeds inside a 500 ms window. A momentarily slow Docker daemon or a freshly (re)started `socat` makes that one probe time out, and the runner then reads the occupied port as a foreign conflict instead of a reusable bridge. The port is host-wide and offset-independent, so no `KILO_PORT_OFFSET` change can clear this refusal.

Fix: retry the same `dev:start` command once — the probe is re-run and the second attempt typically prints `Reusing host kiloclaw-docker-tcp on 23750` and proceeds. Only if the refusal repeats, investigate the bridge itself per `kiloclaw-docker-tcp-absent-from-worktree-status.md` (`curl` the unversioned `/_ping`, check `lsof -iTCP:23750`); never kill a foreign-owned `socat`, and never "fix" this by picking another offset.
