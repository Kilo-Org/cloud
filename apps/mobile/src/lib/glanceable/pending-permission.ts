import { type ConnectionConfig, createConnection } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { fetchCloudAgentStreamTicket } from '@/lib/cloud-agent-stream-ticket';
import { CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';

/**
 * The one read of the cloud-agent pending permission's id. The id lives only in
 * the control plane's pending-interaction projection and is sent on stream
 * connect, so this reuses the shipped stream transport for one frame and closes
 * it. It is split out of `approve-ask` because answering a permission and
 * reading the projection are different concerns, and the answer path's timeout
 * classification is the only thing the two share.
 *
 * Its cases live in `approve-ask.test.ts`, beside the flow that calls it.
 */

/** The interaction identity the control plane's projection guarantees. */
const pendingPermissionSchema = z.object({ id: z.string().min(1) });

/** The `connected` frame's interaction projection; absent means none pending. */
const connectedInteractionsSchema = z.object({
  pendingInteractions: z.object({ permissions: z.array(pendingPermissionSchema) }).optional(),
});

type StreamConnectionLike = { connect: () => void; destroy: () => void };

export type PendingPermissionResolverDeps = {
  getTicket?: (
    cloudAgentSessionId: string,
    organizationId?: string
  ) => Promise<{ ticket: string; expiresAt: number }>;
  createConnection?: (config: ConnectionConfig) => StreamConnectionLike;
  now?: () => number;
  /**
   * Schedule the deadline and return its cancel function. Injectable so the
   * pure suite fires the deadline by hand and no opaque timer handle leaks.
   */
  setTimeout?: (handler: () => void, timeoutMs: number) => () => void;
};

export type ResolvePendingPermissionIdInput = {
  cloudAgentSessionId: string;
  organizationId?: string | null;
  timeoutMs?: number;
};

/** Flat budget for one control-plane stream open. */
const PENDING_PERMISSION_TIMEOUT_MS = 15_000;

/**
 * The control plane answered neither with the projection nor within the flat
 * budget: the ticket fetch stalled, or the stream connected and stayed silent.
 * The ask may still be pending, so this is a retryable failure — never the
 * `null` that means "no pending permission" and drops the recorded ask.
 */
export class PendingPermissionTimeoutError extends Error {
  constructor() {
    super('Timed out reading the cloud-agent pending permission');
    this.name = 'PendingPermissionTimeoutError';
  }
}

export async function resolvePendingPermissionId(
  input: ResolvePendingPermissionIdInput,
  deps?: PendingPermissionResolverDeps
): Promise<string | null> {
  const getTicket = deps?.getTicket ?? fetchCloudAgentStreamTicket;
  const openConnection = deps?.createConnection ?? createConnection;
  const now = deps?.now ?? (() => Date.now());
  const setTimer =
    deps?.setTimeout ??
    ((handler: () => void, timeoutMs: number) => {
      const handle = setTimeout(handler, timeoutMs);
      return () => {
        clearTimeout(handle);
      };
    });
  const organizationId =
    input.organizationId && input.organizationId.length > 0 ? input.organizationId : undefined;
  const timeoutMs = input.timeoutMs ?? PENDING_PERMISSION_TIMEOUT_MS;
  const deadlineAt = now() + timeoutMs;

  const pending = new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let cancelDeadline: (() => void) | null = null;
    let connection: StreamConnectionLike | null = null;
    const close = (): void => {
      settled = true;
      cancelDeadline?.();
      connection?.destroy();
    };
    const settle = (permissionId: string | null): void => {
      if (settled) {
        return;
      }
      close();
      resolve(permissionId);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    cancelDeadline = setTimer(() => {
      fail(new PendingPermissionTimeoutError());
    }, timeoutMs);
    // The ticket fetch is inside the deadline: a route that never answers must
    // end the ask as retryable rather than hold the worker for its full stop.
    const open = async (): Promise<void> => {
      try {
        const ticket = await getTicket(input.cloudAgentSessionId, organizationId);
        if (settled) {
          return;
        }
        const url = new URL('/stream', CLOUD_AGENT_WS_URL);
        url.searchParams.set('cloudAgentSessionId', input.cloudAgentSessionId);
        connection = openConnection({
          websocketUrl: url.toString(),
          ticket,
          websocketHeaders: { Origin: WEB_BASE_URL },
          lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
          onEvent: event => {
            if (event.streamEventType !== 'connected') {
              return;
            }
            // A frame that lands after the deadline is not an answer.
            if (now() >= deadlineAt) {
              fail(new PendingPermissionTimeoutError());
              return;
            }
            const parsed = connectedInteractionsSchema.safeParse(event.data);
            const permissionId = parsed.success
              ? (parsed.data.pendingInteractions?.permissions[0]?.id ?? null)
              : null;
            settle(permissionId);
          },
          onConnected: () => undefined,
          onDisconnected: () => undefined,
          onError: () => undefined,
        });
        // `createConnection` builds the transport; the caller opens it.
        connection.connect();
      } catch (error) {
        // A rejected ticket keeps its own error so the answer path classifies
        // the HTTP status; a stalled ticket is the deadline's business above.
        fail(error);
      }
    };
    void open();
  });
  const permissionId = await pending;
  return permissionId;
}
