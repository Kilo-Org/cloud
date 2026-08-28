import { type MobileRouter } from '@kilocode/trpc/mobile';
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  type Operation,
  TRPCClientError,
  type TRPCLink,
} from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL, E2E_LATENCY_MESSAGES_MS, E2E_LATENCY_SESSION_MS } from '@/lib/config';
import { performRefresh, REFRESH_MARGIN_MS } from '@/lib/auth/credentials';
import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import { shouldRefreshBeforeRequest } from '@/lib/auth/native-auth-contract';
import {
  getActiveToken,
  getActiveTokenSnapshot,
  getAuthTokenForRequest,
  publishActiveTokenExpiry,
} from '@/lib/auth/token-owner';
import { TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';
import { type AuthenticatedOwner } from '@/lib/context-scope';
import { LocalAccessDeniedError } from '@/lib/local-access';
import {
  assertTransportOwner,
  captureTransportOperation,
  isTransportOwner,
  type TransportOperation,
} from '@/lib/local-access-transport';

export const { TRPCProvider, useTRPC } = createTRPCContext<MobileRouter>();
const trpcUrl = `${API_BASE_URL}/api/trpc`;

/** E2E-only latency remains inside the extended deadline, before final admission. */
const E2E_LATENCY_RULES: readonly (readonly [procedure: string, delayMs: number])[] = [
  ['cliSessionsV2.get', E2E_LATENCY_SESSION_MS],
  ['cliSessionsV2.getSessionMessagesPage', E2E_LATENCY_MESSAGES_MS],
];

function requestUrlString(url: RequestInfo | URL): string {
  if (url instanceof URL) {
    return url.href;
  }
  if (url instanceof Request) {
    return url.url;
  }
  return url;
}

function e2eLatencyForUrl(url: string): number {
  let delayMs = 0;
  for (const [procedure, procedureDelayMs] of E2E_LATENCY_RULES) {
    if (procedureDelayMs > delayMs && url.includes(procedure)) {
      delayMs = procedureDelayMs;
    }
  }
  return delayMs;
}

function guardedDeadlineFetch(assertDispatch: () => void): typeof fetch {
  return async (url, init) => {
    const delayMs = e2eLatencyForUrl(requestUrlString(url));
    const response = await withDeadline(
      CONTROL_PLANE_DEADLINE_MS + delayMs,
      async signal => {
        if (delayMs > 0) {
          await new Promise(resolve => {
            setTimeout(resolve, delayMs);
          });
        }
        // Hermes signals lack throwIfAborted; withDeadline already preserves the caller's reason.
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        assertDispatch();
        const result = await fetch(url, { ...init, signal });
        return result;
      },
      init?.signal ?? undefined
    );
    return response;
  };
}

/** Retain the standalone deadline helper; transport delegates always install their own assertion. */
export const deadlineFetch: typeof fetch = guardedDeadlineFetch(() => undefined);

async function getAuthHeaders(owner: AuthenticatedOwner, allowCleanup: boolean) {
  const assertOwner = () => {
    assertTransportOwner(owner, allowCleanup);
  };
  assertOwner();
  const token = await getAuthTokenForRequest();
  assertOwner();
  if (!token) {
    return { ...buildAuthHeaders(token), ...buildClientMetadataHeaders() };
  }

  const active = getActiveTokenSnapshot();
  let expiresAtMs = active?.expiresAtMs ?? null;
  if (expiresAtMs === null) {
    assertOwner();
    const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
    assertOwner();
    const resolvedExpiresAtMs = expiresAtStr ? Number(expiresAtStr) : null;
    if (active) {
      publishActiveTokenExpiry(active, resolvedExpiresAtMs);
    }
    expiresAtMs = resolvedExpiresAtMs;
  }
  // A refresh can rotate the token within this credential generation, never across accounts.
  const newest = getActiveToken();
  const currentToken = newest?.token ?? token;
  const currentExpiresAtMs = newest ? newest.expiresAtMs : expiresAtMs;
  if (
    currentExpiresAtMs !== null &&
    shouldRefreshBeforeRequest(currentExpiresAtMs, Date.now(), REFRESH_MARGIN_MS)
  ) {
    assertOwner();
    await performRefresh();
    assertOwner();
    const refreshedToken = getActiveToken()?.token ?? (await getAuthTokenForRequest());
    assertOwner();
    return { ...buildAuthHeaders(refreshedToken), ...buildClientMetadataHeaders() };
  }
  assertOwner();
  return { ...buildAuthHeaders(currentToken), ...buildClientMetadataHeaders() };
}

type Delegate = ReturnType<TRPCLink<MobileRouter>>;
type Bucket = { owner: AuthenticatedOwner; delegate: Delegate; pending: Set<Operation> };

const transportLink: TRPCLink<MobileRouter> = runtime => {
  const buckets = new Map<string, Bucket>();
  // Keep cancelled members identifiable until the batch releases them; WeakMap owns no lifetime.
  const operations = new WeakMap<Operation, TransportOperation>();
  return operationOptions => {
    const { op } = operationOptions;
    // Capture before any token, header, batch scheduling, or connection wait.
    const admission = captureTransportOperation(op);
    operations.set(op, admission);
    const { owner, allowCleanup } = admission;
    const bucketKey = `${owner.authEpoch}:${owner.generation}`;
    for (const [key, bucket] of buckets) {
      if (key !== bucketKey && bucket.pending.size === 0) {
        buckets.delete(key);
      }
    }
    let bucket: Bucket | undefined = undefined;
    let result: ReturnType<Delegate> | undefined = undefined;
    if (op.type === 'mutation' || op.context.skipBatch === true) {
      // One supported delegate per operation keeps its closure out of wire headers and input.
      result = httpLink<MobileRouter>({
        url: trpcUrl,
        methodOverride: 'POST',
        headers: async () => {
          const headers = await getAuthHeaders(owner, allowCleanup);
          return headers;
        },
        fetch: guardedDeadlineFetch(admission.assertDispatch),
      })(runtime)(operationOptions);
    } else {
      bucket = buckets.get(bucketKey);
      if (!bucket) {
        const delegate = httpBatchLink<MobileRouter>({
          url: trpcUrl,
          methodOverride: 'POST',
          headers: async ({ opList }) => {
            for (const batchedOp of opList) {
              const captured = operations.get(batchedOp);
              if (
                captured?.type !== 'query' ||
                captured.owner.authEpoch !== owner.authEpoch ||
                captured.owner.generation !== owner.generation
              ) {
                throw new LocalAccessDeniedError('owner');
              }
              assertTransportOwner(captured.owner);
            }
            const headers = await getAuthHeaders(owner, false);
            return headers;
          },
          fetch: guardedDeadlineFetch(() => {
            assertTransportOwner(owner);
          }),
        })(runtime);
        bucket = { owner, delegate, pending: new Set() };
        buckets.set(bucketKey, bucket);
      }
      bucket.pending.add(op);
      result = bucket.delegate(operationOptions);
    }
    const finish = () => {
      bucket?.pending.delete(op);
      if (bucket?.pending.size === 0 && !isTransportOwner(bucket.owner)) {
        buckets.delete(bucketKey);
      }
    };
    // Decorate this operation's library observable, retaining its pipe and teardown implementation.
    const subscribe = result.subscribe.bind(result);
    result.subscribe = observer => {
      const subscription = subscribe({
        next(value) {
          if (isTransportOwner(owner, allowCleanup)) {
            observer.next?.(value);
          } else {
            observer.error?.(TRPCClientError.from(new LocalAccessDeniedError('owner')));
          }
        },
        error(error) {
          finish();
          observer.error?.(
            isTransportOwner(owner, allowCleanup)
              ? error
              : TRPCClientError.from(new LocalAccessDeniedError('owner'))
          );
        },
        complete() {
          finish();
          observer.complete?.();
        },
      });
      return {
        unsubscribe() {
          subscription.unsubscribe();
          finish();
        },
      };
    };
    return result;
  };
};

export const trpcClient = createTRPCClient<MobileRouter>({ links: [transportLink] });
