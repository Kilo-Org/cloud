import { type KiloSessionId, type UserWebConnection } from 'cloud-agent-sdk';
// kilocode_change - K1/C2: these two runtime imports must come from their
// narrow subpaths, not the `cloud-agent-sdk` barrel. The barrel's index.ts
// also re-exports web-only transport code (`cloud-agent-connection.ts` ->
// `cloud-agent-transport.ts`) that imports a web-app `@/...` alias unresolved
// under the mobile app's own `@` alias — see the matching vitest.config.ts
// aliases for the full explanation. `user-web-connection.ts` and
// `create-session.ts` have a self-contained import graph and are safe to
// load under a plain Node vitest environment (no React Native).
//
// This pure classifier/spawner logic is deliberately kept in its own module,
// separate from `use-remote-instance-spawn.ts`'s `useRemoteInstanceSpawn`
// hook: that hook also imports `useUserWebConnection` from
// `@/components/agents/user-web-connection-provider`, a `.tsx` provider that
// transitively imports React Native / Expo config modules containing Flow
// syntax the Node vitest environment cannot parse. Splitting keeps this
// file's pure functions testable "without a React renderer" (per the
// accepted plan) while the hook itself stays UI-only and untested here.
import { CommandDeliveredError, UserWebCommandError } from 'cloud-agent-sdk/user-web-connection';
import {
  createRemoteSessionOnConnection,
  parseCreateSessionResponse,
} from 'cloud-agent-sdk/create-session';

/**
 * Pure outcome classifier for the `create_session` reply (connection-scoped
 * `kilo remote` process-per-session spawn flow).
 *
 * The classifier is intentionally pure and dependency-free so it can be unit
 * tested without a React renderer. It collapses the matrix of resolved /
 * rejected / delivered / non-delivered outcomes into the small set of states
 * the caller needs:
 *
 *   - `ready`        — a fresh `KiloSessionId` was provisioned by the CLI
 *   - `retryable`    — either a transport-level failure (timeout, destroyed
 *                      connection, socket gone) OR the DO-emitted literal
 *                      `'Session owner not found'`, which is semantically
 *                      "the instance disconnected" and should follow the
 *                      same recovery path as a transport failure
 *   - `nonRetryable` — anything else: a malformed response envelope, a
 *                      delivered CLI string error (e.g. `'failed to create
 *                      session'`), or any structured `UserWebCommandError`
 *                      (including `CLI_UPGRADE_REQUIRED`)
 *
 * Note on intentionally-unreachable structured codes: relay-sourced codes
 * that are semantically transient (`COMMAND_EXPIRED`, `PENDING_COMMAND_LIMIT`)
 * are mapped to `nonRetryable` here because they are effectively unreachable
 * for this flow:
 *   - The SDK's 30s client-side timeout fires before the DO's command TTL.
 *   - The pending-command cap is implausible for a single spawn.
 * If a future DO timing change makes them reachable, the comment is the
 * place to revisit — not a silent mislabel.
 */

/**
 * Exact-match constant for the DO's literal "instance disconnected" string
 * (`UserConnectionDO.ts:735`). Special-cased to `retryable` because
 * semantically the instance disconnected, which is the same recovery path
 * as a transport failure.
 */
export const SESSION_OWNER_NOT_FOUND_LITERAL = 'Session owner not found';

export type CreateSessionOutcome =
  | { status: 'ready'; sessionID: KiloSessionId }
  | { status: 'retryable'; reason: string; cause: unknown }
  | { status: 'nonRetryable'; reason: string; cause: unknown };

/**
 * Classify the resolved-or-rejected outcome of `createRemoteSessionOnConnection`
 * into the spawn hook's state space.
 *
 * The `cause` field preserves the original error for callers that want to
 * surface or log it; `reason` is a short, user-safe string intended for UI.
 */
export function classifyCreateSessionResult(
  result: PromiseSettledResult<unknown>
): CreateSessionOutcome {
  if (result.status === 'fulfilled') {
    const parsed = parseCreateSessionResponse(result.value);
    if (parsed.ok) {
      return { status: 'ready', sessionID: parsed.kiloSessionId };
    }
    return {
      status: 'nonRetryable',
      reason: 'unexpected response shape',
      cause: result.value,
    };
  }

  // result.status === 'rejected'
  const cause: unknown = result.reason;

  // Structured relay error: keep `.code` available; the classifier still
  // intentionally maps all such errors to `nonRetryable` (see header).
  if (cause instanceof UserWebCommandError) {
    return {
      status: 'nonRetryable',
      reason: cause.message || cause.code,
      cause,
    };
  }

  // Delivered bare-string error: special-case the DO's vanished-connection
  // literal to `retryable` (see SESSION_OWNER_NOT_FOUND_LITERAL).
  if (cause instanceof CommandDeliveredError) {
    if (cause.message === SESSION_OWNER_NOT_FOUND_LITERAL) {
      return {
        status: 'retryable',
        reason: SESSION_OWNER_NOT_FOUND_LITERAL,
        cause,
      };
    }
    return {
      status: 'nonRetryable',
      reason: cause.message,
      cause,
    };
  }

  // Anything else (plain `Error` from timeout / destroyed connection /
  // socket gone) is a transport failure: retryable.
  return {
    status: 'retryable',
    reason: cause instanceof Error ? cause.message : 'transport failure',
    cause,
  };
}

// ---------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------

/**
 * Stable per-spawner identity (UUID v4). Generated once at spawner creation.
 *
 * v1 does NOT use `creationKey` for server-side dedup — the relay/CLI has no
 * idempotency layer for `create_session` and an existing connection's race
 * is a real (but small) possibility. The key exists purely as a stable
 * per-attempt identifier for in-hook bookkeeping and tests; do not build a
 * dedupe layer on top of it without revisiting the contract.
 */
export type CreateSessionSpawner = {
  readonly creationKey: string;
  /**
   * Attempt a `create_session` against the given CLI connection. Returns
   * the classified outcome — never throws.
   */
  spawn: (connectionId: string) => Promise<CreateSessionOutcome>;
};

function generateCreationKey(): string {
  // Matches the existing repo convention (`use-agent-attachment-upload.ts`,
  // `cloud-agent-runtime.ts`): call `crypto.randomUUID()` directly, no
  // manual RFC 4122 fallback (which would need bitwise operators the repo
  // lint config forbids). iOS/Android Hermes both expose it; this key is an
  // opaque per-attempt bookkeeping identifier, never parsed as a UUID by
  // anything, so a plain random fallback string is sufficient on the rare
  // environment without it.
  const cryptoApi = Reflect.get(globalThis, 'crypto') as { randomUUID?: () => string } | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `spawn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Pure factory for a spawner. Created without React state so it can be
 * tested in isolation; the hook wires it into a `useState`-backed status for
 * UI consumption.
 */
export function createSessionSpawner(
  connection: Pick<UserWebConnection, 'sendCommandToConnection'>
): CreateSessionSpawner {
  const creationKey = generateCreationKey();
  return {
    creationKey,
    async spawn(connectionId) {
      try {
        const raw = await createRemoteSessionOnConnection(connection, connectionId);
        return classifyCreateSessionResult({ status: 'fulfilled', value: raw });
      } catch (error) {
        return classifyCreateSessionResult({ status: 'rejected', reason: error });
      }
    },
  };
}
