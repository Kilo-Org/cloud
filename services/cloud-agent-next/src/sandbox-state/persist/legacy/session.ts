/**
 * Frozen decoder for today's bare session-message array (design §9; plan §3).
 *
 * Imported only by `persist/load.ts`. It accepts both row eras: the v2 rows that
 * own `version: 2` and an `intent`, and the pre-intent rows that carry
 * `turn`/`prompt`/`finalization`. A per-row `version: 2` is a legitimate legacy
 * field; an own `v` property is foreign residue and rejects the whole value.
 *
 * Every durable field the canonical model keeps is preserved: `queuedAt`, the
 * pending `cancellation` marker, the immutable intent on terminal rows, the full
 * operation proofs (including `error.admission`) and the wrapper identity.
 */
import { z } from 'zod';
import type {
  AcceptedTurn,
  Binding,
  Cancellation,
  RuntimeHandle,
  SessionAggregate,
  SessionMessage,
  SessionMessageIntent,
  SessionMessageTerminalSource,
  TurnFinalization,
} from '../../model/session.js';
import {
  CloudAgentAssistantFailureReasonSchema,
  CloudAgentProviderOwnershipSchema,
  acceptedTurnSchema,
  gateResultSchema,
  messageProofsSchema,
  preparationWaitSchema,
  sessionMessageIntentSchema,
  sessionMessageTerminalSourceSchema,
  turnFinalizationSchema,
} from '../../model/session.js';
import { isForeignMarker } from './allocation.js';
import { POLICY } from '../../schedule.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const legacySessionRowSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    state: z.enum(['queued', 'accepted', 'completed', 'failed', 'cancelled']),
    version: z.literal(2).optional(),
    intent: sessionMessageIntentSchema.optional(),
    turn: acceptedTurnSchema.optional(),
    prompt: z.string().optional(),
    finalization: turnFinalizationSchema.optional(),
    legacyIntentInvalid: z.literal(true).optional(),
    queuedAt: timestamp.optional(),
    acceptedAt: timestamp.optional(),
    lastActivityAt: timestamp.optional(),
    deliveryDeadlineAt: timestamp.optional(),
    deliveryRetryScope: z.enum(['message', 'runtime']).optional(),
    unresolvedDispatch: z.literal(true).optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    terminalAt: timestamp.optional(),
    terminalSource: sessionMessageTerminalSourceSchema.optional(),
    failedReason: z.string().optional(),
    failedDetail: z.string().optional(),
    attachFailures: z.number().int().nonnegative().optional(),
    promptFailures: z.number().int().nonnegative().optional(),
    preparationAttemptId: z.string().min(1).optional(),
    preparationWait: preparationWaitSchema.optional(),
    retryNotBefore: timestamp.optional(),
    executionDeadlineAt: timestamp.optional(),
    cancellation: z
      .object({ operationId: z.string().min(1), deadlineAt: timestamp })
      .strict()
      .optional(),
    operations: messageProofsSchema.optional(),
    gateResult: gateResultSchema.optional(),
    assistantReason: CloudAgentAssistantFailureReasonSchema.optional(),
    providerOwnership: CloudAgentProviderOwnershipSchema.optional(),
  })
  .passthrough();

export type LegacySessionRow = z.infer<typeof legacySessionRowSchema>;

type LegacyFreeform = {
  turn?: AcceptedTurn;
  prompt?: string;
  finalization?: TurnFinalization;
};

type IntentCarry = {
  intent: SessionMessageIntent | null;
  legacyInvalidIntent?: true;
  legacy?: LegacyFreeform;
};

function resolveIntent(row: LegacySessionRow): IntentCarry {
  if (row.intent) return { intent: row.intent };
  const legacy: LegacyFreeform = {
    ...(row.turn !== undefined ? { turn: row.turn } : {}),
    ...(row.prompt !== undefined ? { prompt: row.prompt } : {}),
    ...(row.finalization !== undefined ? { finalization: row.finalization } : {}),
  };
  const hasLegacy = Object.keys(legacy).length > 0;
  // A row a previous freeze already failed on carries the permanent marker; the
  // marker wins even when the failed freeze retained its legacy payload, so a
  // later freeze with a valid model can never promote a permanently invalid row.
  if (row.legacyIntentInvalid === true) {
    return {
      intent: null,
      legacyInvalidIntent: true,
      ...(hasLegacy ? { legacy } : {}),
    };
  }
  // A row with legacy intent data and no marker is *unresolved*: a later freeze
  // may resolve it. Only a row with no payload at all is permanently invalid.
  if (hasLegacy) return { intent: null, legacy };
  return { intent: null, legacyInvalidIntent: true };
}

function queuedAtOf(row: LegacySessionRow): { queuedAt?: number } {
  return row.queuedAt !== undefined ? { queuedAt: row.queuedAt } : {};
}

function carryOf(resolved: IntentCarry): IntentCarry & { legacy?: LegacyFreeform } {
  return {
    intent: resolved.intent,
    ...(resolved.legacyInvalidIntent ? { legacyInvalidIntent: true as const } : {}),
    ...(resolved.legacy !== undefined ? { legacy: resolved.legacy } : {}),
  };
}

function terminalSource(row: LegacySessionRow): SessionMessageTerminalSource {
  return row.terminalSource ?? 'coordinator';
}

function terminalAt(row: LegacySessionRow): number {
  return row.terminalAt ?? row.acceptedAt ?? row.queuedAt ?? 0;
}

function cancellationOf(row: LegacySessionRow): { cancellation?: Cancellation } {
  return row.cancellation !== undefined ? { cancellation: row.cancellation } : {};
}

/** The retained delivery/settlement identity, when the legacy row carried it. */
function identityOf(row: LegacySessionRow): {
  wrapperInstanceId?: string;
  preparationAttemptId?: string;
} {
  return {
    ...(row.wrapperInstanceId !== undefined ? { wrapperInstanceId: row.wrapperInstanceId } : {}),
    ...(row.preparationAttemptId !== undefined
      ? { preparationAttemptId: row.preparationAttemptId }
      : {}),
  };
}

function toQueued(row: LegacySessionRow): SessionMessage {
  const resolved = resolveIntent(row);
  return {
    messageId: row.messageId,
    state: {
      kind: 'queued',
      ...carryOf(resolved),
      ...queuedAtOf(row),
      deliveryStep:
        row.deliveryRetryScope === 'runtime' || row.preparationAttemptId !== undefined
          ? 'preparing'
          : 'waiting',
      deadlineAt: row.deliveryDeadlineAt ?? null,
      attachFailures: row.attachFailures ?? 0,
      promptFailures: row.promptFailures ?? 0,
      // Preserve the original retry scope: `deliveryStep` conflates it with
      // "has a preparation attempt", so it cannot reconstruct it.
      ...(row.deliveryRetryScope !== undefined
        ? { deliveryRetryScope: row.deliveryRetryScope }
        : {}),
      ...(row.retryNotBefore !== undefined ? { retryNotBefore: row.retryNotBefore } : {}),
      ...(row.preparationAttemptId !== undefined
        ? { preparationAttemptId: row.preparationAttemptId }
        : {}),
      ...(row.preparationWait !== undefined ? { preparationWait: row.preparationWait } : {}),
      ...(row.unresolvedDispatch === true ? { unresolvedDispatch: true as const } : {}),
      ...(row.wrapperInstanceId !== undefined ? { wrapperInstanceId: row.wrapperInstanceId } : {}),
    },
    ...(row.operations !== undefined ? { proofs: row.operations } : {}),
    ...cancellationOf(row),
  };
}

function toAccepted(row: LegacySessionRow): SessionMessage {
  const resolved = resolveIntent(row);
  const acceptedAt = row.acceptedAt ?? terminalAt(row);
  // A legacy row without an execution deadline still gets a bounded one; the
  // session machine never carries accepted work with no scheduled deadline.
  const executionDeadlineAt =
    row.executionDeadlineAt ?? acceptedAt + POLICY.acceptedExecutionBoundMs;
  return {
    messageId: row.messageId,
    state: {
      kind: 'accepted',
      ...carryOf(resolved),
      ...queuedAtOf(row),
      acceptedAt,
      ...(row.lastActivityAt !== undefined ? { lastActivityAt: row.lastActivityAt } : {}),
      executionDeadlineAt,
      ...identityOf(row),
    },
    ...(row.operations !== undefined ? { proofs: row.operations } : {}),
    ...cancellationOf(row),
  };
}

function toTerminal(row: LegacySessionRow): SessionMessage {
  const resolved = resolveIntent(row);
  const at = terminalAt(row);
  const source = terminalSource(row);
  const carry = carryOf(resolved);
  // `acceptedAt` is preserved verbatim when the legacy row carried it; it must
  // not reuse `terminalAt`, which collapses the two timestamps.
  const acceptedAt = row.acceptedAt === undefined ? {} : { acceptedAt: row.acceptedAt };
  const identity = identityOf(row);
  const state =
    row.state === 'completed'
      ? {
          kind: 'completed' as const,
          ...carry,
          ...queuedAtOf(row),
          ...acceptedAt,
          ...identity,
          at,
          source,
          ...(row.gateResult !== undefined ? { gateResult: row.gateResult } : {}),
        }
      : row.state === 'cancelled'
        ? {
            kind: 'cancelled' as const,
            ...carry,
            ...queuedAtOf(row),
            ...acceptedAt,
            ...identity,
            at,
            source,
            ...(row.failedReason !== undefined ? { reason: row.failedReason } : {}),
          }
        : {
            kind: 'failed' as const,
            ...carry,
            ...queuedAtOf(row),
            ...acceptedAt,
            ...identity,
            at,
            source,
            ...(row.failedReason !== undefined ? { reason: row.failedReason } : {}),
            ...(row.failedDetail !== undefined ? { detail: row.failedDetail } : {}),
            ...(row.assistantReason !== undefined ? { assistantReason: row.assistantReason } : {}),
            ...(row.providerOwnership !== undefined
              ? { providerOwnership: row.providerOwnership }
              : {}),
          };
  return {
    messageId: row.messageId,
    state,
    ...(row.operations !== undefined ? { proofs: row.operations } : {}),
    ...cancellationOf(row),
  };
}

export function convertLegacySessionRow(row: LegacySessionRow): SessionMessage {
  switch (row.state) {
    case 'queued':
      return toQueued(row);
    case 'accepted':
      return toAccepted(row);
    case 'completed':
    case 'failed':
    case 'cancelled':
      return toTerminal(row);
  }
}

/**
 * Legacy rows carry no session-level binding. A session with accepted messages must
 * still carry a binding, but the rows hold only the wrapper identity, not the
 * allocation incarnation — the value a real allocation-loss proof is fenced to.
 * The binding is therefore `unresolved` unless the caller supplies the
 * authoritative handle from the migration context (the decoded allocation).
 */
export function convertLegacySession(
  rows: readonly LegacySessionRow[],
  handle?: RuntimeHandle
): SessionAggregate {
  const messages = rows.map(convertLegacySessionRow);
  if (messages.some(message => message.state.kind === 'accepted')) {
    const binding: Binding =
      handle !== undefined ? { kind: 'bound', handle } : { kind: 'unresolved' };
    return { binding, messages };
  }
  return { binding: { kind: 'unbound' }, messages };
}

/** Frozen legacy decode. Returns `undefined` on a foreign marker or malformed row. */
export function decodeLegacySession(
  value: unknown,
  handle?: RuntimeHandle
): SessionAggregate | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: LegacySessionRow[] = [];
  for (const row of value) {
    if (isForeignMarker(row)) return undefined;
    const parsed = legacySessionRowSchema.safeParse(row);
    if (!parsed.success) return undefined;
    rows.push(parsed.data);
  }
  return convertLegacySession(rows, handle);
}
