# `kiloclaw-docker-tcp` absent from a worktree's `dev:status` is expected when the shared 23750 bridge answers

Symptom: `pnpm dev:status --json` for a worktree whose stack started cleanly lists no `kiloclaw-docker-tcp` service row, and the `dev:start` argv named `kiloclaw` (which expands the group that includes it). Provisioning or starting a docker-local KiloClaw instance looks under-provisioned.

Cause: `kiloclaw-docker-tcp` is a stateless loopback `socat` proxy to the shared Docker socket on `127.0.0.1:23750` — the one host-wide shared port the runbook allows. When another worktree (or an earlier stack) already owns that listener, this worktree's runner reuses it and records no service row of its own.

Fix: gate on the bridge, not the row: `curl http://127.0.0.1:23750/v1.44/_ping` must print `OK`. If it fails, rerun `.kilo_workflow/e2e-start-resource.sh stack kiloclaw`; the runner probes and recreates the bridge. Never start or kill `socat` by hand — the listener is shared by every docker-local instance on the host.

Related: `.kilo_workflow/e2e-stop-resource.sh stack` runs `pnpm dev:stop`, which tears the shared bridge down. After cleanup, 23750 having no listener is expected — the next resource start recreates it on demand; do not "repair" it by hand. The KiloClaw sandbox container itself survives `dev:stop`.
