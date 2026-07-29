# `kiloclaw-docker-tcp` absent from a worktree's `dev:status` is expected when the shared 23750 bridge answers

Symptom: `pnpm dev:status --json` for a worktree whose stack started cleanly lists no `kiloclaw-docker-tcp` service row, and the `dev:start` argv named `kiloclaw` (which expands the group that includes it). Provisioning or starting a docker-local KiloClaw instance looks under-provisioned.

Cause: `kiloclaw-docker-tcp` is a stateless loopback `socat` proxy to the shared Docker socket on `127.0.0.1:23750` — the one host-wide shared port the runbook allows. When another worktree (or an earlier stack) already owns that listener, this worktree's runner reuses it and records no service row of its own.

Fix: gate on the bridge, not the row: `curl http://127.0.0.1:23750/v1.44/_ping` must print `OK`. Only if that fails, start the bridge yourself per `services/kiloclaw/README.md` (`socat TCP-LISTEN:23750,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/var/run/docker.sock`). Never kill a `socat` owned by another worktree (runbook, Host Networking Safety) — `lsof -iTCP:23750` shows the owning PID and it is shared by every docker-local instance on the host, not just yours.

Related: a plain `pnpm dev:stop` tears the shared bridge down (even when `e2e-slot.sh release` printed "Leaving Docker infrastructure running"). After a cleanup, 23750 having no listener is expected — the next `dev:start` recreates it on demand; do not "repair" it by hand. The KiloClaw sandbox container itself survives both release and `dev:stop`.
