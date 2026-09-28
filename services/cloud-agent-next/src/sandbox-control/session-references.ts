import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';

export const MAX_REFERENCE_ENTRIES = 512;
export const MAX_REFERENCE_BYTES = 96 * 1024;

export type SessionReference = {
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  worktreeId?: string;
};

export type SessionReferenceState = {
  reconciled: boolean;
  overflowed: boolean;
  entries: SessionReference[];
};

export type SessionReferenceMatch = {
  kiloSessionId: string;
  directory: string;
  worktreeId?: string;
};

export type SessionReferenceTarget = {
  worktreeId: string;
  directory: string;
  sessionIds: ReadonlySet<string>;
  releasedWorktreeIds: ReadonlySet<string>;
};

export function emptySessionReferenceState(): SessionReferenceState {
  return { reconciled: false, overflowed: false, entries: [] };
}

export function serializedReferenceBytes(entries: readonly SessionReference[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}

export function worktreeIdFromDirectory(directory: string): string | undefined {
  const parsed = cloudAgentWorktreeIdSchema.safeParse(directory.split('/').at(-1));
  return parsed.success ? parsed.data : undefined;
}

function referenceWorktreeId(entry: SessionReferenceMatch): string | undefined {
  return entry.worktreeId ?? worktreeIdFromDirectory(entry.directory);
}

export function addSessionReference(
  state: SessionReferenceState,
  entry: SessionReference
): { state: SessionReferenceState; changed: boolean } {
  if (state.overflowed || state.entries.some(existing => existing.sessionId === entry.sessionId)) {
    return { state, changed: false };
  }
  state.entries.push(entry);
  if (
    state.entries.length > MAX_REFERENCE_ENTRIES ||
    serializedReferenceBytes(state.entries) > MAX_REFERENCE_BYTES
  ) {
    state.entries.pop();
    state.overflowed = true;
  }
  return { state, changed: true };
}

export function removeWorktreeReferences(
  state: SessionReferenceState,
  worktreeId: string
): { state: SessionReferenceState; changed: boolean } {
  const retained = state.entries.filter(entry => referenceWorktreeId(entry) !== worktreeId);
  if (retained.length === state.entries.length) return { state, changed: false };
  state.entries = retained;
  return { state, changed: true };
}

export function removeSessionReference(
  state: SessionReferenceState,
  sessionId: string
): { state: SessionReferenceState; changed: boolean } {
  const retained = state.entries.filter(entry => entry.sessionId !== sessionId);
  if (retained.length === state.entries.length) return { state, changed: false };
  state.entries = retained;
  return { state, changed: true };
}

export function markReferencesReconciled(state: SessionReferenceState): SessionReferenceState {
  state.reconciled = true;
  return state;
}

export function hasForeignReference(
  state: SessionReferenceState,
  evidence: Iterable<SessionReferenceMatch>,
  target: SessionReferenceTarget
): boolean {
  if (state.overflowed) return true;
  for (const entry of evidence) {
    const worktreeId = referenceWorktreeId(entry);
    if (worktreeId !== undefined && target.releasedWorktreeIds.has(worktreeId)) continue;
    if (
      entry.directory !== target.directory ||
      !target.sessionIds.has(entry.kiloSessionId) ||
      (worktreeId !== undefined && worktreeId !== target.worktreeId)
    ) {
      return true;
    }
  }
  return false;
}
