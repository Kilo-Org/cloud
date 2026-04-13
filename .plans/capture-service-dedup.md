# Plan: Deduplicate Tunnel/Capture Service Infrastructure

## Problem

Capture services (kiloclaw-tunnel, kiloclaw-stripe, app-builder-tunnel) share significant
duplicated code across four layers:

1. **Tunnel startup scripts** — `start-tunnel.ts` and `start-app-builder-tunnel.ts` share ~60
   lines of identical code (updateEnvValue, cloudflared check, signal handling, capture loop).
2. **CLI orchestration** — `cli.ts` has three copy-pasted blocks for reading old env values,
   waiting for capture, and logging results — differing only in service name, env path, and key.
3. **Dashboard gating** — `dashboard.tsx` reimplements the CLI's tunnel gating logic in 150 lines,
   but only for kiloclaw-tunnel (not stripe or app-builder-tunnel), creating an inconsistency.
4. **Hardcoded service names** — Both `cli.ts` and `dashboard.tsx` hardcode which services are
   capture services and which services depend on them, duplicating knowledge already encoded in
   the `dependsOn` graph in `services.ts`.

Additionally, PR #2209 introduced a bypass bug: the dashboard gating condition
`toStart.includes('kiloclaw') && toStart.includes('kiloclaw-tunnel')` only fires when both
services are newly starting. If `kiloclaw-tunnel` was already running from a prior timeout, the
gate is skipped and `kiloclaw` starts with a stale env.

## Goals

- Single source of truth for capture service metadata in `services.ts`.
- Startup gating derived from the existing `dependsOn` graph, not hardcoded service names.
- Shared tunnel script logic extracted into a reusable module.
- Dashboard and CLI both use the same generic capture-and-gate function.
- Fix the bypass bug where already-running tunnels skip the gate.

## Design

### 1. Add `capture` metadata to `ServiceMeta` in `services.ts`

```ts
// New optional field on ServiceMeta
type CaptureSpec = {
  envFile: string; // relative to repo root
  envKey: string; // env var name to watch
  gatesDependents: boolean; // if true, downstream services wait for capture
};

type ServiceMeta = {
  group: string;
  dependsOn: string[];
  dir?: string;
  useLanIp?: boolean;
  capture?: CaptureSpec; // NEW
};
```

Update the three capture service definitions:

```ts
'kiloclaw-tunnel': {
  group: 'kiloclaw',
  dependsOn: [],
  capture: {
    envFile: 'services/kiloclaw/.dev.vars',
    envKey: 'KILOCODE_API_BASE_URL',
    gatesDependents: true,
  },
},
'kiloclaw-stripe': {
  group: 'kiloclaw',
  dependsOn: [],
  capture: {
    envFile: 'apps/web/.env.development.local',
    envKey: 'STRIPE_WEBHOOK_SECRET',
    gatesDependents: false,
  },
},
'app-builder-tunnel': {
  group: 'app-builder',
  dependsOn: [],
  capture: {
    envFile: 'services/app-builder/.dev.vars',
    envKey: 'BUILDER_HOSTNAME',
    gatesDependents: false,
  },
},
```

Export a helper:

```ts
export function getCaptureSpec(name: string): CaptureSpec | undefined {
  return SERVICE_META[name]?.capture;
}

/** Returns true if `serviceName` transitively depends on any capture service with gatesDependents. */
export function isGatedByCaptureService(serviceName: string): string | undefined {
  // Walk dependsOn chain; return the capture service name if found
}
```

### 2. Extract shared cloudflared module: `dev/local/scripts/cloudflared-tunnel.ts`

Extract from the two tunnel scripts into a shared module:

```ts
// dev/local/scripts/cloudflared-tunnel.ts

export function updateEnvValue(filePath: string, key: string, value: string): void {
  /* ... */
}
export function ensureCloudflared(): void {
  /* check + error message + exit */
}

type TunnelOptions = {
  port: number;
  onCapture: (url: string) => void;
  namedTunnel?: { name: string; hostname: string };
};

export function startTunnel(opts: TunnelOptions): void {
  // - spawn cloudflared (quick or named mode)
  // - pipe stderr, capture URL with regex
  // - call onCapture once
  // - forward SIGINT/SIGTERM
  // - exit on close
}
```

Rewrite `start-tunnel.ts` (~25 lines):

```ts
import { ensureCloudflared, startTunnel, updateEnvValue } from './cloudflared-tunnel';
// load named tunnel config (parseConfFile + loadTunnelConfig stay here — kiloclaw-specific)
// call startTunnel({ port, onCapture: url => updateEnvValue(..., 'KILOCODE_API_BASE_URL', ...) })
```

Rewrite `start-app-builder-tunnel.ts` (~15 lines):

```ts
import { ensureCloudflared, startTunnel, updateEnvValue } from './cloudflared-tunnel';
// call startTunnel({ port, onCapture: url => {
//   updateEnvValue(devVarsPath, 'BUILDER_HOSTNAME', hostname);
//   updateEnvValue(envDevLocalPath, 'APP_BUILDER_URL', url);
// }})
```

### 3. Extract generic capture orchestration into `runner.ts`

Add to `runner.ts`:

```ts
import { getCaptureSpec, isGatedByCaptureService } from './services';

type CaptureResult = {
  serviceName: string;
  captured: boolean;
};

/**
 * Given a list of service names that are about to start, identify which are
 * capture services, snapshot their current env values, and return a function
 * that waits for all captures to complete.
 */
export function prepareCaptureWaits(
  serviceNames: string[],
  repoRoot: string
): {
  captureServices: string[];
  otherServices: string[];
  waitForCaptures: (timeoutMs: number) => Promise<CaptureResult[]>;
} {
  // For each service with a capture spec:
  //   - snapshot old env value + mtime
  //   - add to captureServices list
  // Return waitForCaptures that calls waitForEnvValueChange for each
}

/**
 * Partition a list of services into those that can start immediately
 * and those that must wait for a gating capture service's env var to be fresh.
 *
 * Uses the dependsOn graph — no hardcoded service names.
 * Checks the CURRENT env file state, not just whether the tunnel was in this batch.
 * This fixes the bypass bug where an already-running tunnel skips the gate.
 */
export function partitionByGate(
  serviceNames: string[],
  captureResults: CaptureResult[],
  repoRoot: string
): {
  immediate: string[];
  gated: Map<string, string[]>; // gating capture service -> dependent services
} {
  // For each service, walk dependsOn to find if it depends on a capture service
  // with gatesDependents: true. If that capture failed, it's gated.
}
```

### 4. Simplify `cli.ts` capture orchestration

Replace lines 158-274 with:

```ts
const { captureServices, otherServices, waitForCaptures } = prepareCaptureWaits(
  serviceNames,
  repoRoot
);

// Start capture services
for (const name of captureServices) {
  startServiceInTmux(sessionName, name);
  startedServices.push(name);
  await sleep(300);
}

// Wait for captures
console.log(`${BOLD}Waiting for capture services...${RESET}`);
const captureResults = await waitForCaptures(CAPTURE_TIMEOUT_MS);
for (const r of captureResults) {
  if (r.captured) console.log(`  ${r.serviceName} captured`);
  else console.warn(`  ${r.serviceName} not captured after timeout`);
}

// Start remaining services, skipping gated ones
const { immediate, gated } = partitionByGate(otherServices, captureResults, repoRoot);
for (const name of immediate) {
  startServiceInTmux(sessionName, name);
  startedServices.push(name);
  await sleep(300);
}
if (gated.size > 0) {
  const skipped = [...gated.values()].flat();
  console.warn(`Skipped: ${skipped.join(', ')} — waiting for capture services.`);
}
```

### 5. Simplify `dashboard.tsx` toggleGroupOn

Replace the 150-line two-phase implementation with:

```ts
const toggleGroupOn = useCallback((groupId: string) => {
  if (togglingRef.current) return;
  togglingRef.current = true;

  void (async () => {
    try {
      const allGroupIds = resolveGroupTransitiveDeps([groupId]);
      const allNeeded = resolveGroups(allGroupIds);
      const toStart = allNeeded.filter(name => !runningServices.has(name));

      const { captureServices, otherServices, waitForCaptures } = prepareCaptureWaits(toStart, repoRoot);

      // Start capture + immediate services
      const immediateNames = [...captureServices, ...otherServices.filter(n => {
        // Use partitionByGate to determine if this service needs to wait
        // ... or start non-gated services immediately
      })];

      // ... start immediateNames, update state, show group ...

      togglingRef.current = false; // release lock for UI responsiveness

      // Wait for captures in background
      const results = await waitForCaptures(CAPTURE_TIMEOUT_MS);
      const { immediate: _, gated } = partitionByGate(/* remaining */, results, repoRoot);

      // Start gated services that captured successfully
      // ... (same pattern, but 15 lines instead of 100) ...
    } finally {
      if (togglingRef.current) togglingRef.current = false;
    }
  })();
}, [runningServices]);
```

The key fix for the bypass bug: `partitionByGate` checks the **current env file state**
(is the value fresh?), not whether the tunnel service is in `toStart`. So even if
`kiloclaw-tunnel` is already running, `kiloclaw` is still gated until the env var is confirmed
fresh.

## File Change Summary

| File                                            | Change                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `dev/local/services.ts`                         | Add `CaptureSpec` type, `capture` field to 3 services, export `getCaptureSpec` + `isGatedByCaptureService` helpers |
| `dev/local/scripts/cloudflared-tunnel.ts`       | **New file** — shared cloudflared utilities (~60 lines)                                                            |
| `dev/local/scripts/start-tunnel.ts`             | Rewrite to use shared module (~25 lines, down from 125)                                                            |
| `dev/local/scripts/start-app-builder-tunnel.ts` | Rewrite to use shared module (~15 lines, down from 76)                                                             |
| `dev/local/runner.ts`                           | Add `prepareCaptureWaits` + `partitionByGate` (~60 lines)                                                          |
| `dev/local/cli.ts`                              | Replace ~110 lines of repetitive capture blocks with ~25 lines using generic helpers                               |
| `dev/local/dashboard.tsx`                       | Replace ~150 lines of reimplemented gating with ~30 lines using shared helpers; fix bypass bug                     |

## Execution Order

1. **`services.ts`** — Add types and capture metadata (no consumers yet, safe).
2. **`cloudflared-tunnel.ts`** — New shared module (no consumers yet).
3. **`start-tunnel.ts` + `start-app-builder-tunnel.ts`** — Rewrite to use shared module (can be done in parallel, touch different files).
4. **`runner.ts`** — Add `prepareCaptureWaits` + `partitionByGate` (depends on step 1).
5. **`cli.ts`** — Refactor capture orchestration (depends on step 4).
6. **`dashboard.tsx`** — Refactor toggleGroupOn (depends on step 4).
7. **Typecheck + smoke test** — `pnpm typecheck`, then `pnpm dev:stop && pnpm dev:start`.

Steps 2-3 are independent of steps 4-6 and can be done in parallel waves.

## Risks

- The `parseConfFile` / `loadTunnelConfig` logic for named tunnels is kiloclaw-specific and stays
  in `start-tunnel.ts`. If app-builder ever needs named tunnels, it would call the same shared
  `startTunnel()` with a `namedTunnel` option.
- The dashboard's `toggleGroupOn` has complex React state updates interleaved with async capture
  waiting. Care must be taken to preserve the two-phase pattern (release `togglingRef` after
  immediate starts, re-check `mouseStateRef` after async capture).
- `partitionByGate`'s env-freshness check needs to handle the case where the env file doesn't
  exist yet (first-ever startup). The existing `readEnvValue` already returns `undefined` for
  missing files, which is correct.
