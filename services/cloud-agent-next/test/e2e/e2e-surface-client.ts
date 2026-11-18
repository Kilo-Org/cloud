/**
 * Driver HTTP client for the e2e-only Worker surface (`/__e2e/*`).
 *
 * This is the one place the driver talks to the surface over HTTP. It provides
 * the `sessionSandbox` capability by observing physical allocation identity from
 * `GET /__e2e/inspect/allocation/:cloudAgentSessionId`, so both the deployed
 * profile and the local HTTP profile share exactly one implementation and the
 * HTTP profiles need no Docker.
 */

import type {
  CallbackObservation,
  CallbackPayload,
  ScenarioEnvironment,
  SessionSandboxCurrentInput,
  SessionSandboxObservation,
  SessionSandboxWaitInput,
} from './scenario-capabilities.js';
import { agentSandboxProviderSchema, type AgentSandboxProvider } from '../../src/types.js';
import {
  getSandboxAllocationInstance,
  getSandboxAllocationProvider,
  getSandboxAllocationResources,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  sandboxProviderConfigurationSchema,
  type SandboxProviderConfiguration,
} from '../../src/sandbox-control/provider.js';

export type AllocationInspection = {
  logicalSandboxId: string;
  physicalProviderRef: string | null;
  /**
   * The persisted provider. Optional for compatibility with a deployed Worker
   * built before this field existed: an omitted value is accepted when no
   * expected allocation is asserted. When present it must be a known provider.
   */
  provider?: AgentSandboxProvider;
  configuration?: SandboxProviderConfiguration | null;
  physicalState: string | null;
};

export type SurfaceRequestOptions = {
  surfaceUrl: string;
  bearerToken?: string;
  /**
   * The e2e-scoped `INTERNAL_API_SECRET` presented as `x-internal-api-key`.
   * Every non-exempt surface route requires it in addition to the bearer; the
   * callback ingest route (`POST /__e2e/callbacks/:token`) is the one exemption
   * and is authorized by its path token instead.
   */
  internalApiSecret: string;
  /**
   * Requires the persisted provider and instance/resources to match before
   * returning a physical reference.
   */
  expectedAllocation?: SandboxAllocation;
  signal?: AbortSignal;
};

function surfaceHeaders(options: SurfaceRequestOptions): Record<string, string> {
  return {
    ...(options.bearerToken === undefined
      ? {}
      : { Authorization: `Bearer ${options.bearerToken}` }),
    'x-internal-api-key': options.internalApiSecret,
  };
}

/** Bound for the token-release cleanup call, which runs after the scenario. */
const CLOSE_TIMEOUT_MS = 15_000;

/** A `setTimeout` that settles early when `signal` aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function allocationUrl(surfaceUrl: string, cloudAgentSessionId: string): string {
  return `${surfaceUrl.replace(/\/+$/, '')}/__e2e/inspect/allocation/${encodeURIComponent(
    cloudAgentSessionId
  )}`;
}

function parseAllocation(value: unknown): AllocationInspection {
  if (typeof value !== 'object' || value === null) {
    throw new Error('allocation inspection response was not an object');
  }
  const record = value as Record<string, unknown>;
  const { logicalSandboxId, physicalProviderRef, physicalState } = record;
  if (typeof logicalSandboxId !== 'string' || logicalSandboxId.length === 0) {
    throw new Error('allocation inspection response had no logicalSandboxId');
  }
  if (physicalProviderRef !== null && typeof physicalProviderRef !== 'string') {
    throw new Error('allocation inspection response had an invalid physicalProviderRef');
  }
  // An older deployed surface omits `provider`. It is only required when an
  // explicit allocation is asserted, so accept an omitted field; a
  // present, unknown value is always rejected.
  let provider: AgentSandboxProvider | undefined;
  if (record.provider !== undefined) {
    const parsedProvider = agentSandboxProviderSchema.safeParse(record.provider);
    if (!parsedProvider.success) {
      throw new Error('allocation inspection response had an unknown provider');
    }
    provider = parsedProvider.data;
  }
  if (physicalState !== null && typeof physicalState !== 'string') {
    throw new Error('allocation inspection response had an invalid physicalState');
  }
  let configuration: SandboxProviderConfiguration | null | undefined;
  if (record.configuration !== undefined) {
    const parsed = sandboxProviderConfigurationSchema.nullable().safeParse(record.configuration);
    if (!parsed.success) {
      throw new Error('allocation inspection response had an invalid configuration');
    }
    configuration = parsed.data;
  }
  return {
    logicalSandboxId,
    physicalProviderRef,
    ...(provider === undefined ? {} : { provider }),
    ...(configuration === undefined ? {} : { configuration }),
    physicalState,
  };
}

/**
 * Fail closed when the persisted provider configuration does not match the requested
 * allocation. `physicalState` is the authority signal: before the pin is
 * written it is `null` and `getAllocationState()` reports the default provider,
 * so a mismatch is deferred and the wait keeps polling rather than failing once.
 * Once `physicalState` is non-null the persisted provider is authoritative, and
 * a missing field on an old deployed surface or a genuine mismatch throws
 * before a reference is returned.
 */
export function requireExpectedAllocation(
  allocation: AllocationInspection,
  expectedAllocation: SandboxAllocation | undefined
): string | null {
  if (expectedAllocation !== undefined && allocation.physicalState !== null) {
    const expectedProvider = getSandboxAllocationProvider(expectedAllocation);
    if (allocation.provider === undefined) {
      throw new Error(
        'surface did not report a provider; redeploy the E2E Worker to assert an explicit allocation'
      );
    }
    if (allocation.provider !== expectedProvider) {
      throw new Error(
        `allocation provider "${allocation.provider}" did not match the requested "${expectedProvider}"`
      );
    }
    const configuration = allocation.configuration;
    if (configuration == null) {
      throw new Error(
        'surface did not report a configuration; redeploy the E2E Worker to assert an explicit allocation'
      );
    }
    const resources = getSandboxAllocationResources(expectedAllocation);
    const instance = getSandboxAllocationInstance(expectedAllocation);
    if (
      configuration.provider !== expectedProvider ||
      (resources !== undefined &&
        (configuration.provider !== 'vercel' ||
          configuration.resources?.vcpus !== resources.vcpus ||
          configuration.resources?.memory !== resources.memory)) ||
      (instance !== undefined &&
        (configuration.provider !== 'cloudflare-containers' || configuration.instance !== instance))
    ) {
      throw new Error(
        `allocation configuration ${JSON.stringify(configuration)} did not match the requested "${expectedAllocation}"`
      );
    }
  }
  return allocation.physicalProviderRef;
}

/** One authenticated allocation read. A non-2xx response is an error, never null. */
export async function fetchAllocation(
  options: SurfaceRequestOptions,
  cloudAgentSessionId: string
): Promise<AllocationInspection> {
  const response = await fetch(allocationUrl(options.surfaceUrl, cloudAgentSessionId), {
    headers: surfaceHeaders(options),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `allocation inspect failed for ${cloudAgentSessionId}: ${response.status} ${response.statusText}`
    );
  }
  return parseAllocation(await response.json());
}

/**
 * Observe container identity through the surface. `waitForContainer` polls until
 * a physical provider reference exists or the timeout elapses; `currentContainer`
 * is a single read.
 *
 * This is the persisted control-plane allocation reference, not a live runtime
 * observation: it proves the session has an allocation with that provider
 * reference, not that the container is currently running. It also cannot
 * enumerate containers, so a "new container appeared" check is not expressible
 * over HTTP.
 */
export function createHttpSessionSandbox(
  options: SurfaceRequestOptions
): SessionSandboxObservation {
  return {
    waitForContainer: async (input: SessionSandboxWaitInput) => {
      const signal = input.signal ?? options.signal;
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) return null;
        const allocation = await fetchAllocation({ ...options, signal }, input.cloudAgentSessionId);
        const ref = requireExpectedAllocation(allocation, options.expectedAllocation);
        if (ref !== null) return ref;
        await abortableDelay(500, signal);
      }
      return null;
    },
    currentContainer: async (input: SessionSandboxCurrentInput) => {
      const allocation = await fetchAllocation(
        { ...options, signal: input.signal ?? options.signal },
        input.cloudAgentSessionId
      );
      return requireExpectedAllocation(allocation, options.expectedAllocation);
    },
  };
}

/**
 * The `callbacks` capability over HTTP: mint a token at
 * `POST /__e2e/callbacks`, register the returned URL as the session's
 * callback target, then poll `GET /__e2e/callbacks/:token` for deliveries and
 * release the token with `DELETE`. The Worker's callback delivery sends no
 * credential, so the token ingest route authorizes by its own unguessable path
 * token while mint/read/delete carry the driver bearer.
 */
export function createHttpCallbacks(options: SurfaceRequestOptions): CallbackObservation {
  const base = options.surfaceUrl.replace(/\/+$/, '');

  async function mint(signal?: AbortSignal): Promise<{ token: string; callbackUrl: string }> {
    const response = await fetch(`${base}/__e2e/callbacks`, {
      method: 'POST',
      headers: surfaceHeaders(options),
      ...((signal ?? options.signal) ? { signal: signal ?? options.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`callback mint failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.token !== 'string' || typeof body.callbackUrl !== 'string') {
      throw new Error('callback mint response had no token/callbackUrl');
    }
    return { token: body.token, callbackUrl: body.callbackUrl };
  }

  async function records(token: string, signal?: AbortSignal): Promise<CallbackPayload[]> {
    const effective = signal ?? options.signal;
    const response = await fetch(`${base}/__e2e/callbacks/${encodeURIComponent(token)}`, {
      headers: surfaceHeaders(options),
      ...(effective ? { signal: effective } : {}),
    });
    if (!response.ok) {
      throw new Error(`callback read failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { records?: unknown };
    if (!Array.isArray(body.records)) {
      throw new Error('callback read response had no records array');
    }
    return body.records as CallbackPayload[];
  }

  return {
    open: async signal => {
      const minted = await mint(signal);
      return {
        callbackUrl: minted.callbackUrl,
        records: recordsSignal => records(minted.token, recordsSignal ?? signal),
        waitFor: async (predicate, timeoutMs, waitSignal) => {
          const effective = waitSignal ?? signal ?? options.signal;
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (effective?.aborted) return null;
            const received = await records(minted.token, effective);
            const match = received.find(predicate);
            if (match !== undefined) return match;
            if (Date.now() >= deadline) return null;
            await abortableDelay(500, effective);
          }
        },
        close: async () => {
          // Cleanup runs after the scenario, so it must not inherit the
          // scenario signal (which may already be aborted); bound it separately.
          const response = await fetch(
            `${base}/__e2e/callbacks/${encodeURIComponent(minted.token)}`,
            {
              method: 'DELETE',
              headers: surfaceHeaders(options),
              signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
            }
          );
          // An expired token is already gone; cleanup is not a scenario step.
          if (!response.ok && response.status !== 404) {
            throw new Error(`callback delete failed: ${response.status} ${response.statusText}`);
          }
        },
      };
    },
  };
}

/**
 * The `local-http` profile: an e2e surface running on the local stack, driven
 * over HTTP with a bearer token and no Docker fallback. It provides
 * `sessionSandbox`, `callbacks`, and the deployed-style HTTP auth boundary.
 */
export function createLocalHttpScenarioEnvironment(options: {
  surfaceUrl: string;
  bearerToken?: string;
  internalApiSecret: string;
  /** Read from the Worker `.dev.vars` by the driver, not a second flag. */
  credentialContainmentEnabled?: boolean;
  expectedAllocation?: SandboxAllocation;
}): ScenarioEnvironment {
  return {
    profile: 'local-http',
    requireControlPlaneSession: true,
    sessionSandbox: createHttpSessionSandbox(options),
    callbacks: createHttpCallbacks(options),
    deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
    // V2 is inert until C1; the operator opts in explicitly, exactly as the
    // Docker profile does. Without the flag V2 scenarios report `unsupported`.
    // This profile has no Docker, so it never provides `controlPlaneRuntime`.
    ...(process.env.E2E_CONTROL_PLANE_V2 === '1' ? { controlPlaneV2: { ready: true } } : {}),
    ...(options.credentialContainmentEnabled ? { credentialContainment: { enabled: true } } : {}),
  };
}
