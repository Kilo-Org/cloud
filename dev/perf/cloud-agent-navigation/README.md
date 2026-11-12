# Cloud Agent navigation benchmark

Manual, local-stack benchmark; intentionally not part of CI. Requires the repository
dependencies and Playwright Chromium (or `CHROMIUM_PATH=/usr/bin/chromium`). No deployment
or production credentials are needed. Both scripts refuse a non-loopback `BASE_URL`.

## Fixtures and login

1. Follow `DEVELOPMENT.md` and `.kilo/skills/cloud-agent-sandbox/SKILL.md` when applicable.
   Run `pnpm dev:status --json` first and reuse the reported ports. Start
   `pnpm dev:start agents fake-llm` only if there is no existing stack. Include the usage
   meter for representative billing behavior.
2. Log in to a local fixture user on the development server:

   ```sh
   BASE_URL=http://localhost:3000 EMAIL=<local-fixture-email> \
     STORAGE_STATE=/tmp/kilo2/cloud-navigation-auth.json \
     node dev/perf/cloud-agent-navigation/login.cjs
   ```

   The authentication file is written with mode `0600`. Never commit it.
3. Add the heavily populated sidebar to that existing user:

   ```sh
   pnpm dev:seed app:cloud-agent-performance <local-fixture-email>
   ```

   This creates 120 workspaces / 960 chats / 12 folders, not runtime history.
   In the local UI create two real workspaces using `kilo/fake-deterministic`, each
   with 31 completed turns and a short sibling chat. Include markdown, reasoning,
   and file/command tool output. See `services/cloud-agent-next/test/e2e/README.md`
   for fake directives and the existing API-driven fixture provider. Stop idle
   fixture containers before measuring. Use exactly the same history before/after.
4. Copy `fixtures.example.json` to `/tmp/kilo2/cloud-navigation-fixtures.json` and fill
   in the actual route, click selectors, and message IDs. Use selectors from the
   rendered UI: sidebar navigation is not necessarily an `<a>` element. Add sibling
   tab and new-chat interactions with a unique readiness selector (composer readiness
   for new chat). New-chat rounds create real chats; use a disposable local account.

## Production build

Do not compare development React with production React. Use the same build flags
on both revisions, including `--profile --no-mangling` for React attribution:

```sh
pnpm --filter web exec next build --profile --no-mangling
pnpm --filter web start
```

For a smaller debugging build, Next also supports:

```sh
pnpm --filter web exec next build --profile --no-mangling \
  --debug-build-paths='src/app/(app)/cloud/**,src/app/(app)/organizations/**/cloud/**,src/app/users/**,src/app/api/trpc/**,src/app/api/auth/**,src/app/api/cloud-agent-next/**,src/app/api/user/**,src/app/api/profile/**,src/app/api/openrouter/**,src/app/api/organizations/**'
```

Partial builds can omit unrelated routes, so record resulting 404s separately.
Do not turn off typechecking in committed configuration. Stop/replace the development
web server before binding its port; keep the backend stack running. Login can be
performed on the development server before swapping it for `next start`.

## Run

From the repository root, with the actual web port:

```sh
BASE_URL=http://localhost:3000 CHROMIUM_PATH=/usr/bin/chromium \
  STORAGE_STATE=/tmp/kilo2/cloud-navigation-auth.json \
  FIXTURES=/tmp/kilo2/cloud-navigation-fixtures.json \
  ROUNDS=4 MODE=timing BLOCK_EXTERNAL=1 IDLE_MS=65000 \
  OUT=/tmp/kilo2/navigation-after.json \
  node dev/perf/cloud-agent-navigation/benchmark.cjs
```

- Each round starts a fresh browser context. Within a round, list unopened and then
  opened workspace/tab interactions to distinguish cold and cached navigation.
- Content time starts at direct DOM click dispatch and ends at the readiness mutation
  plus an animation frame; it excludes Playwright actionability delays. Readiness
  selectors must distinguish the destination from the outgoing transcript.
- `OBSERVE_MS` (default 2000) records follow-up requests and long tasks after content.
  `IDLE_MS` adds an idle traffic window per round; use at least 65 seconds for polling.
- `MODE=react` installs a React DevTools hook to record commits and named rendered
  fibers. Durations require a profiling build; nested `actualDuration` values overlap
  and must **not** be summed as component self time. Treat counts as diagnostic, not
  a substitute for a React Profiler trace.
- `MODE=cpu` saves one Chrome `.cpuprofile` per interaction, including the observation
  window. Open it in Chrome DevTools. Timing, React, and CPU runs are separate;
  compare like with like.
- `BLOCK_EXTERNAL=1` makes analytics/CDN DNS fail fast; apply it to both revisions.
- JSON records request paths, status, relative start/first-byte/end, decoded/encoded
  bytes, long tasks, and optional React commits. It deliberately excludes query
  strings, headers, cookies, tickets, request bodies, and transcript text.
- `ENFORCE_BUDGETS=1` exits unsuccessfully when a configured median exceeds its target.
  Budgets are local-stack targets, not production SLOs. Inspect failed requests and
  transcript correctness before interpreting a fast sample as a success.

Report medians from at least four samples and the affected request table. Also check
rapid switches, deleted/denied sessions, ticket/history failures, and offline recovery.
The original investigation's ignored `.wrangler/cloud-perf-*` scripts and fixtures
were not available when this portable harness was added; it is not a byte-for-byte
copy of those scripts.

Cheap harness checks:

```sh
node --test dev/perf/cloud-agent-navigation/metrics.test.cjs
node --check dev/perf/cloud-agent-navigation/benchmark.cjs
```
