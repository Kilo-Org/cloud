import { type ConnectionConfig, createConnection } from '@kilocode/cloud-agent-sdk';
import type * as ExpoCrypto from 'expo-crypto';
import { z } from 'zod';

import {
  fetchCloudAgentStreamTicket,
  type FetchStreamTicketOptions,
} from '@/lib/cloud-agent-stream-ticket';
import { CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';

/**
 * The one read of the cloud-agent pending interactions. The ids live only in the
 * control plane's pending-interaction projection and are sent on stream connect,
 * so this reuses the shipped stream transport for one frame and closes it. It is
 * split out of `approve-ask` because answering a permission and reading the
 * projection are different concerns, and the answer path's timeout
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
    organizationId?: string,
    options?: FetchStreamTicketOptions
  ) => Promise<{ ticket: string; expiresAt: number }>;
  createConnection?: (config: ConnectionConfig) => StreamConnectionLike;
  now?: () => number;
  /**
   * The approval key of one pending request, as the web backend mints it.
   * Injectable so the pure suite matches keys without the native digest.
   */
  approvalKey?: (kiloSessionId: string, permissionId: string) => Promise<string>;
  /**
   * Schedule the deadline and return its cancel function. Injectable so the
   * pure suite fires the deadline by hand and no opaque timer handle leaks.
   */
  setTimeout?: (handler: () => void, timeoutMs: number) => () => void;
};

export type PendingPermissionReadInput = {
  cloudAgentSessionId: string;
  organizationId?: string | null;
  timeoutMs?: number;
};

/**
 * The request a surface drew, in the identity that surface carries: a session
 * card's approval key (SHA-256 hex of `JSON.stringify([kiloSessionId, permissionId])`,
 * as the web backend mints it), or the aggregate ask's bound permission id.
 */
export type PendingPermissionTarget =
  | { kind: 'approvalKey'; kiloSessionId: string; approvalKey: string }
  | { kind: 'permissionId'; permissionId: string };

/**
 * What matching the drawn request against the projection found. `none` means no
 * request is pending at all, `stale` means requests are pending but none is the
 * drawn one, and `ambiguous` means more than one request answers the drawn
 * identity. Only `matched` names a request an answer may submit.
 */
export type PendingPermissionMatch =
  | { kind: 'matched'; permissionId: string }
  | { kind: 'none' }
  | { kind: 'stale' }
  | { kind: 'ambiguous' };

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

/**
 * The pending permission ids the connected frame carries, in the projection's
 * order. A frame with no projection, or one this module cannot decode, reads as
 * no pending request: the caller then has nothing it may answer.
 */
function readPendingPermissionIds(
  input: PendingPermissionReadInput,
  deps?: PendingPermissionResolverDeps
): Promise<readonly string[]> {
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

  const { promise, resolve, reject } = Promise.withResolvers<readonly string[]>();
  let settled = false;
  let cancelDeadline: (() => void) | null = null;
  let connection: StreamConnectionLike | null = null;
  // The budget covers the ticket POST as well as the stream: closing the read
  // cancels whatever is still in flight, so no request outlives the settled
  // promise and a second tap cannot stack another one behind it.
  const ticketAbort = new AbortController();
  const close = (): void => {
    settled = true;
    cancelDeadline?.();
    ticketAbort.abort();
    connection?.destroy();
  };
  const settle = (permissionIds: readonly string[]): void => {
    if (settled) {
      return;
    }
    close();
    resolve(permissionIds);
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
      const ticket = await getTicket(input.cloudAgentSessionId, organizationId, {
        signal: ticketAbort.signal,
      });
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
          settle(
            parsed.success
              ? (parsed.data.pendingInteractions?.permissions.map(permission => permission.id) ??
                  [])
              : []
          );
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
  return promise;
}

/** The approval key of one pending request, as the web backend mints it. */
function approvalKeyOf(kiloSessionId: string, permissionId: string): Promise<string> {
  // Lazy require keeps the native digest out of the pure test graph.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { CryptoDigestAlgorithm, digestStringAsync } = require('expo-crypto') as typeof ExpoCrypto;
  return digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    JSON.stringify([kiloSessionId, permissionId])
  );
}

/** Whether one projected request is the one the target names. */
async function matchesTarget(
  permissionId: string,
  target: PendingPermissionTarget,
  keyOf: (kiloSessionId: string, permissionId: string) => Promise<string>
): Promise<boolean> {
  if (target.kind === 'permissionId') {
    return permissionId === target.permissionId;
  }
  return (await keyOf(target.kiloSessionId, permissionId)) === target.approvalKey;
}

/**
 * Match the request a surface drew against every entry of the projection, so an
 * approval answers exactly that request. Two entries naming one request are one
 * request; two different requests that both answer the drawn identity are
 * ambiguous, and an ambiguous read names no request at all.
 */
export async function resolvePendingPermissionId(
  input: PendingPermissionReadInput & { target: PendingPermissionTarget },
  deps?: PendingPermissionResolverDeps
): Promise<PendingPermissionMatch> {
  const ids = [...new Set(await readPendingPermissionIds(input, deps))];
  if (ids.length === 0) {
    return { kind: 'none' };
  }
  const keyOf = deps?.approvalKey ?? approvalKeyOf;
  let matched: string | null = null;
  for (const permissionId of ids) {
    // eslint-disable-next-line no-await-in-loop -- one candidate at a time, and a second match ends the read
    const answers = await matchesTarget(permissionId, input.target, keyOf);
    if (answers && matched !== null) {
      return { kind: 'ambiguous' };
    }
    if (answers) {
      matched = permissionId;
    }
  }
  return matched === null ? { kind: 'stale' } : { kind: 'matched', permissionId: matched };
}

/**
 * The projection's oldest pending request, or null when nothing is pending. The
 * aggregate ask's binding read: it names the request that ask will answer, and
 * the control plane keeps permissions in arrival order. It grants nothing — the
 * answer path re-reads the projection and matches that id again.
 */
export async function resolveLeadingPendingPermissionId(
  input: PendingPermissionReadInput,
  deps?: PendingPermissionResolverDeps
): Promise<string | null> {
  const ids = await readPendingPermissionIds(input, deps);
  return ids[0] ?? null;
}
