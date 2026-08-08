import {
  type KiloSessionId,
  type ModelSelection,
  type UserWebConnection,
} from '@kilocode/cloud-agent-sdk';
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
import {
  CommandDeliveredError,
  UserWebCommandError,
} from '@kilocode/cloud-agent-sdk/user-web-connection';
import {
  type CreateRemoteSessionInput,
  createRemoteSessionOnConnection,
  parseCreateSessionResponse,
} from '@kilocode/cloud-agent-sdk/create-session';

export type { CreateRemoteSessionInput };

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
// Screen → wire input
// ---------------------------------------------------------------------------

/**
 * Map the new-session screen's picker state into the SDK
 * `CreateRemoteSessionInput` shape. The caller resolves the picker's model
 * choice into a `ModelSelection` (provider + model + optional variant); this
 * builder forwards the selected provider and model as-is, without any
 * hard-coded provider mapping. Empty strings are omitted.
 */
export function buildCreateRemoteSessionInput(fields: {
  mode?: string;
  selection?: ModelSelection;
  organizationId?: string | null;
}): CreateRemoteSessionInput | undefined {
  const input: CreateRemoteSessionInput = {};
  if (fields.mode) {
    input.agent = fields.mode;
  }
  if (fields.selection) {
    input.model = {
      providerID: fields.selection.model.providerID,
      modelID: fields.selection.model.modelID,
      ...(fields.selection.variant ? { variant: fields.selection.variant } : {}),
    };
  }
  if (fields.organizationId) {
    input.orgId = fields.organizationId;
  }
  return input.agent !== undefined || input.model !== undefined || input.orgId !== undefined
    ? input
    : undefined;
}

/**
 * Resolve the spawn hook's org arg against live organization context.
 *
 *   - `explicit === undefined` (zero-arg / omitted) → inherit `context`
 *   - `explicit === null` → personal; do not inherit context
 *   - `explicit` string → that org
 *
 * Pure so the tri-state is unit-testable without a React renderer.
 */
export function resolveSpawnOrganizationId(
  explicit: string | null | undefined,
  context: string | null | undefined
): string | null | undefined {
  return explicit !== undefined ? explicit : context;
}

/**
 * Merge an optional explicit org id (hook arg) into spawn opts when the
 * caller did not already set `orgId`. Pure so hook defaulting is unit-testable
 * without a React renderer.
 */
export function mergeSpawnOrganizationId(
  opts: CreateRemoteSessionInput | undefined,
  organizationId: string | null | undefined
): CreateRemoteSessionInput | undefined {
  if (opts?.orgId !== undefined) {
    return opts;
  }
  if (!organizationId) {
    return opts;
  }
  return { ...opts, orgId: organizationId };
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
  spawn: (connectionId: string, opts?: CreateRemoteSessionInput) => Promise<CreateSessionOutcome>;
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
    async spawn(connectionId, opts) {
      try {
        const raw = await createRemoteSessionOnConnection(connection, connectionId, opts);
        return classifyCreateSessionResult({ status: 'fulfilled', value: raw });
      } catch (error) {
        return classifyCreateSessionResult({ status: 'rejected', reason: error });
      }
    },
  };
}
