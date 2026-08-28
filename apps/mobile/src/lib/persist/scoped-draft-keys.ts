import { z } from 'zod';

import {
  type AuthenticatedOwner,
  type ContextScope,
  contextScope,
  contextScopeSchema,
  isAuthenticatedOwner,
  sameContext,
} from '@/lib/context-scope';
import {
  agentComposerDraftKey,
  clearDraftIfStill,
  draftScope,
  type DraftWriteResult,
  isStringDraft,
  loadDraftResult,
  NEW_SESSION_DRAFT_KEY,
  saveDraftConfirmed,
  SCOPED_DRAFT_KEY_PREFIX,
  SESSION_SEARCH_DRAFT_KEY,
} from './drafts';
import { listEntries } from './encrypted-kv';

const draftTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new-session') }),
  z.strictObject({ kind: z.literal('session'), sessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('search') }),
  z.strictObject({ kind: z.literal('quick-chat') }),
]);
export type DraftTarget = Readonly<z.infer<typeof draftTargetSchema>>;
const scopedKeySchema = z.tuple([contextScopeSchema, draftTargetSchema]);

/** Tagged JSON avoids Personal/organization and new/session collisions without changing draft scopes. */
export function scopedDraftKey(context: ContextScope, target: DraftTarget): string {
  return `${SCOPED_DRAFT_KEY_PREFIX}${JSON.stringify(scopedKeySchema.parse([context, target]))}`;
}
export function parseScopedDraftKey(
  key: string
): { context: ContextScope; target: DraftTarget } | null {
  if (!key.startsWith(SCOPED_DRAFT_KEY_PREFIX)) {
    return null;
  }
  try {
    const parsed = scopedKeySchema.safeParse(JSON.parse(key.slice(SCOPED_DRAFT_KEY_PREFIX.length)));
    return parsed.success ? { context: parsed.data[0], target: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

export type LegacyDraftCandidate = Readonly<{
  key: string;
  kind: 'new-or-session' | 'session' | 'search' | 'quick-chat';
  updatedAt: number;
}>;
function legacyKind(key: string): LegacyDraftCandidate['kind'] | null {
  if (key === NEW_SESSION_DRAFT_KEY) {
    return 'new-or-session';
  }
  if (key.startsWith('agent-composer:') && key.length > 'agent-composer:'.length) {
    return 'session';
  }
  if (key === SESSION_SEARCH_DRAFT_KEY) {
    return 'search';
  }
  if (/^quick-chat:\d+:.+$/s.test(key)) {
    return 'quick-chat';
  }
  return null;
}

/** Metadata only: discovering ambiguous bytes never displays text in an inferred context. */
export async function listLegacyDraftCandidates(
  owner: AuthenticatedOwner
): Promise<LegacyDraftCandidate[]> {
  if (!isAuthenticatedOwner(owner) || owner.userId === null) {
    return [];
  }
  const entries = await listEntries(draftScope(owner.userId));
  if (!isAuthenticatedOwner(owner)) {
    return [];
  }
  return entries.flatMap(entry => {
    const kind = legacyKind(entry.k);
    return kind ? [{ key: entry.k, kind, updatedAt: entry.updatedAt }] : [];
  });
}

type MigrationInput = {
  owner: AuthenticatedOwner;
  destinationKey: string;
  candidateKey: string;
  /** The activation UI must supply the exact candidate, including its epoch, after a deliberate choice. */
  selection: 'explicit';
  isCurrent: () => boolean;
};
export type DraftMigrationResult = DraftWriteResult | 'absent' | 'malformed' | 'unavailable';

async function validateLegacyDestination(
  input: MigrationInput,
  destination: NonNullable<ReturnType<typeof parseScopedDraftKey>>
): Promise<boolean> {
  const { target, context } = destination;
  if (target.kind === 'new-session') {
    return input.candidateKey === NEW_SESSION_DRAFT_KEY;
  }
  if (target.kind === 'search') {
    return input.candidateKey === SESSION_SEARCH_DRAFT_KEY;
  }
  if (target.kind === 'quick-chat') {
    const match = /^quick-chat:\d+:(.+)$/s.exec(input.candidateKey);
    // The old Personal sentinel also collides with an organization named personal. Explicit selection
    // resolves that ambiguity; an epoch alone never proves either durable user or context.
    return match?.[1] === (context.kind === 'personal' ? 'personal' : context.organizationId);
  }
  if (input.candidateKey !== agentComposerDraftKey(target.sessionId)) {
    return false;
  }
  const { trpcClient } = await import('@/lib/trpc');
  if (!isAuthenticatedOwner(input.owner) || !input.isCurrent()) {
    return false;
  }
  // cliSessionsV2.get checks kilo_user_id and organization access on the server. Route params do not.
  const session = await trpcClient.cliSessionsV2.get.query({ session_id: target.sessionId });
  return (
    session.kilo_user_id === input.owner.userId &&
    session.session_id === target.sessionId &&
    sameContext(contextScope(session.organization_id), context)
  );
}

/** Preserve the source until a same-owner/generation destination commit is confirmed. */
export async function migrateLegacyDraft(input: MigrationInput): Promise<DraftMigrationResult> {
  const { owner, destinationKey, candidateKey } = input;
  const isCurrent = () => isAuthenticatedOwner(owner) && input.isCurrent();
  if (!isCurrent() || owner.userId === null) {
    return 'stale';
  }
  const destination = parseScopedDraftKey(destinationKey);
  if (!destination || !legacyKind(candidateKey)) {
    return 'unavailable';
  }
  try {
    if (!(await validateLegacyDestination(input, destination))) {
      return 'unavailable';
    }
    if (!isCurrent()) {
      return 'stale';
    }
    const source = await loadDraftResult(owner.userId, candidateKey, isStringDraft, isCurrent);
    if (!isCurrent()) {
      return 'stale';
    }
    if (source.status !== 'present') {
      return source.status;
    }
    const target = await loadDraftResult(owner.userId, destinationKey, isStringDraft, isCurrent);
    if (!isCurrent()) {
      return 'stale';
    }
    if (target.status === 'failed' || target.status === 'malformed') {
      return target.status;
    }
    if (target.status === 'present' && target.value !== source.value) {
      return 'conflict';
    }
    if (target.status === 'absent') {
      const outcome = await saveDraftConfirmed(owner.userId, destinationKey, source.value, {
        isCurrent,
        expectedSerialized: null,
      });
      if (outcome !== 'committed') {
        return outcome;
      }
    }
    if (!isCurrent()) {
      return 'stale';
    }
    await clearDraftIfStill(owner.userId, candidateKey, source.serialized, isCurrent);
    return isCurrent() ? 'committed' : 'stale';
  } catch {
    return isCurrent() ? 'failed' : 'stale';
  }
}
