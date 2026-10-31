# Local Kilo v2 runtime

The local Kilo v2 image installs the `kilo2` executable from the npm
`@kilocode/cli` dist-tag `kilo-v2`. The default development image still runs Kilo v1.

From this Cloud service directory, prepare the local image configuration:

```sh
node scripts/prepare-kilo2-local.mjs
```

Pass an npm dist-tag to select another published v2 channel, for example
`node scripts/prepare-kilo2-local.mjs kilo-v2`.

Then start this worktree's normal `cloud-agent` development stack. The development
launcher selects the generated configuration and builds the v2 image. Production
configuration is unchanged. Remove `wrangler.kilo2-local.json` and restart the local
Worker to select the default image again.

Native v2 history uses the sandbox's isolated `kilo2` database. The local Session
Durable Object stores native v2 messages with an explicit source version. The
Cloud Agent SDK reads v1 or v2 sources and builds the shared display model.
A replacement sandbox imports native messages from local history before accepting
another prompt. V2 does not publish to v1 session-ingest.

Run the local acceptance driver from the repository root:

```sh
pnpm --filter cloud-agent-next run e2e:kilo2:local
```

The driver uses this worktree's ports and the funded local test account. It uses
`kilo/fake-deterministic` through the local gateway. It records the runtime version,
wrapper hash, history reads, tools, questions, Stop recovery, native process
replacement, and sandbox replacement under `dev/logs/`.

The sandbox replacement step also restarts this worktree's local Worker. This
clears stopped container references in the local Containers emulator. The Worker
keeps its local Durable Object storage. The test then checks earlier message IDs
inside the replacement native database.

Recovery requires native replay data recorded by this adapter. Existing v1 history
needs a separate migration. A restore fails when history is incomplete or exceeds
1,000 messages or 32 MiB. Standard Cloud event-size limits also apply. This local
proof does not qualify production providers, billing, or deployment.
The native adapter returns empty todo and suggestion lists. This v2 server does
not expose matching read endpoints. Local browser verification is recorded in
`docs/plans/2026-10-23-cloud-conversation-sources.md` at the repository root.

Native schemas live in `packages/session-ingest-contracts`. The wrapper's Docker
build uses a generated copy because its context contains only this service.
After changing the schemas, run `node scripts/sync-kilo2-contracts.mjs` here.
The service typecheck rejects an outdated copy.
