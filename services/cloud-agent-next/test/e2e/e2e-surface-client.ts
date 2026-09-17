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

export type AllocationInspection = {
  logicalSandboxId: string;
  physicalProviderRef: string | null;
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
  if (physicalState !== null && typeof physicalState !== 'string') {
    throw new Error('allocation inspection response had an invalid physicalState');
  }
  return { logicalSandboxId, physicalProviderRef, physicalState };
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
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        const allocation = await fetchAllocation(options, input.cloudAgentSessionId);
        if (allocation.physicalProviderRef !== null) return allocation.physicalProviderRef;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return null;
    },
    currentContainer: async (input: SessionSandboxCurrentInput) => {
      const allocation = await fetchAllocation(options, input.cloudAgentSessionId);
      return allocation.physicalProviderRef;
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

  async function mint(): Promise<{ token: string; callbackUrl: string }> {
    const response = await fetch(`${base}/__e2e/callbacks`, {
      method: 'POST',
      headers: surfaceHeaders(options),
      ...(options.signal ? { signal: options.signal } : {}),
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

  async function records(token: string): Promise<CallbackPayload[]> {
    const response = await fetch(`${base}/__e2e/callbacks/${encodeURIComponent(token)}`, {
      headers: surfaceHeaders(options),
      ...(options.signal ? { signal: options.signal } : {}),
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
    open: async () => {
      const minted = await mint();
      return {
        callbackUrl: minted.callbackUrl,
        records: () => records(minted.token),
        waitFor: async (predicate, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const received = await records(minted.token);
            const match = received.find(predicate);
            if (match !== undefined) return match;
            if (Date.now() >= deadline) return null;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        },
        close: async () => {
          const response = await fetch(
            `${base}/__e2e/callbacks/${encodeURIComponent(minted.token)}`,
            {
              method: 'DELETE',
              headers: surfaceHeaders(options),
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
}): ScenarioEnvironment {
  return {
    profile: 'local-http',
    requireControlPlaneSession: true,
    sessionSandbox: createHttpSessionSandbox(options),
    callbacks: createHttpCallbacks(options),
    deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
  };
}
