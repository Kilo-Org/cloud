/* eslint-disable max-lines -- the engine owns the single-flight gate, the converging crawl, the byte budget, and the publication fence as one cohesive run */
import { type Directory, File } from 'expo-file-system';
import { z } from 'zod';

import {
  type ArtifactCrawlDeps,
  buildSessionArtifacts,
  type CrawledArtifact,
  extractSessionArtifacts,
  fetchSessionMessagesPage,
  listSessionPage,
  materializeArtifact,
  type MaterializedArtifact,
  type MirrorMessagePage,
  type MirrorSessionRow,
} from '@/lib/artifacts/artifact-crawl';
import { applyArtifactSnapshot, mirrorSessionDir } from '@/lib/artifacts/artifact-mirror';
import {
  ARTIFACT_MIRROR_MANIFEST_VERSION,
  type ArtifactMirrorManifest,
  type ArtifactMirrorSession,
  selectSessionsWithinBudget,
} from '@/lib/artifacts/artifact-mirror-manifest';
import { notifyArtifactsChanged } from '@/lib/artifacts/artifact-provider-native';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { readCachedUserId, readCacheScope } from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';

export { MIRROR_SESSION_LIMIT } from '@/lib/artifacts/artifact-crawl';

/**
 * The engine that keeps the artifact mirror in step with the signed-in user's
 * cloud-agent sessions.
 *
 * One run is bounded on every axis so it can be called from a foreground
 * refresh without a progress UI:
 *
 * - one sessions list page ({@link MIRROR_SESSION_LIMIT} newest sessions) is
 *   the whole known session set, so a session missing from it is pruned;
 * - at most {@link MAX_SESSIONS_PER_RUN} not-fully-crawled sessions advance,
 *   one stored message page each, from the cursor persisted with the run
 *   state, so a long session converges over several runs;
 * - the applied snapshot is capped at {@link MIRROR_BYTE_BUDGET}; the oldest
 *   session files over budget are dropped while their folder stays.
 *
 * Runs are single-flight and gated on the persisted `lastRunAt`
 * ({@link MIRROR_SYNC_MIN_INTERVAL_MS}) unless `force` is set. Every write is
 * fenced on the auth epoch captured at entry, so a run that resolves after
 * sign-out cannot repopulate what teardown just cleared.
 */

/** Shortest gap between two runs unless a caller forces one. */
export const MIRROR_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Sessions advanced (one message page each) in a single run. */
export const MAX_SESSIONS_PER_RUN = 3;

/** Total materialized bytes the mirror keeps; oldest session files go first. */
export const MIRROR_BYTE_BUDGET = 250 * 1024 * 1024;

// The persisted run state, validated at the KV boundary: the store is
// encrypted but still untrusted storage after a restore, so a malformed row
// reads as "no state" instead of throwing into the run.
const materializedArtifactSchema = z.object({
  filename: z.string().optional(),
  id: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
});

const sessionStateSchema = z.object({
  cursor: z.string().nullable(),
  done: z.boolean(),
  /** Artifacts already materialized into the mirror, in discovery order. */
  files: z.array(materializedArtifactSchema),
  /** `updatedAt` of the session row this crawl state was built from. */
  updatedAt: z.string(),
});

const syncStateSchema = z.object({
  lastRunAt: z.number().nullable(),
  sessions: z.record(z.string(), sessionStateSchema),
});

type MirrorSyncSessionState = z.infer<typeof sessionStateSchema>;
type MirrorSyncState = z.infer<typeof syncStateSchema>;

/**
 * The tRPC, filesystem, storage, and native work one run performs. Every
 * member has a production default; a caller overrides only what a test drives.
 */
export type ArtifactMirrorSyncDeps = Partial<ArtifactCrawlDeps> & {
  /** Applies the reconciled snapshot; the mirror's own best-effort writer. */
  applySnapshot: (manifest: ArtifactMirrorManifest) => void;
  /** The folder for one session's files, or null with no browsable container. */
  mirrorSessionDir: (sessionId: string) => Directory | null;
  /** Tells the platform provider the tree changed. */
  notify: () => void;
  readState: (scope: string, key: string) => Promise<string | null>;
  writeState: (scope: string, key: string, value: string) => Promise<void>;
  /** Current authoritative user id, or null while signed out. */
  resolveUserId: () => string | null;
  now: () => number;
};

export type ArtifactMirrorSyncOptions = {
  /** Ignores the persisted interval gate. */
  force?: boolean;
  /** Test seams; production callers omit it. */
  deps?: Partial<ArtifactMirrorSyncDeps>;
};

export type ArtifactMirrorSyncOutcome =
  | { status: 'skipped'; reason: 'interval' | 'no-user' }
  | { status: 'discarded' }
  | { status: 'failed' }
  | { failed: number; files: number; sessions: number; status: 'synced' };

/* eslint-disable @typescript-eslint/promise-function-async -- production passthroughs hand the KV promise back untouched */
const DEFAULT_DEPS: ArtifactMirrorSyncDeps = {
  applySnapshot: applyArtifactSnapshot,
  mirrorSessionDir,
  notify: notifyArtifactsChanged,
  readState: (scope, key) => encryptedKv.getItem(scope, key),
  writeState: (scope, key, value) => encryptedKv.setItem(scope, key, value),
  resolveUserId: () => readCachedUserId(queryClient),
  now: () => Date.now(),
};
/* eslint-enable @typescript-eslint/promise-function-async */

/** What one run carries while it advances sessions. */
type SyncRun = {
  deps: ArtifactMirrorSyncDeps;
  epoch: number;
  states: Record<string, MirrorSyncSessionState>;
};

/** One session being advanced, plus the ids already proven materialized. */
type SessionAdvance = {
  deps: ArtifactMirrorSyncDeps;
  epoch: number;
  known: Set<string>;
  sessionId: string;
  state: MirrorSyncSessionState;
};

/** What advancing a session produced; `discarded` means the fence tripped. */
type AdvanceOutcome = { discarded: boolean; failed: number; files: number };

/** One artifact's share of an outcome, including whether it is retryable. */
type ArtifactNote = { discarded: boolean; failed: number; files: number; retryable: boolean };

function artifactNote(overrides: Partial<ArtifactNote> = {}): ArtifactNote {
  return { discarded: false, failed: 0, files: 0, retryable: false, ...overrides };
}

// Single-flight memo plus a generation so a reset (tests, sign-out) can drop
// the memo without the older run's completion clearing a newer run's memo.
let inFlight: Promise<ArtifactMirrorSyncOutcome> | null = null;
let inFlightGeneration = 0;

/**
 * Bring the mirror in line with the signed-in user's sessions. While a run is
 * in flight every caller gets that same promise; otherwise the run is gated on
 * the persisted `lastRunAt` unless `force`. Never rejects.
 */
// eslint-disable-next-line typescript-eslint/promise-function-async -- must return the same in-flight promise to every caller
export function syncArtifactMirror(
  options: ArtifactMirrorSyncOptions = {}
): Promise<ArtifactMirrorSyncOutcome> {
  if (inFlight === null) {
    inFlightGeneration += 1;
    inFlight = runSync(options, inFlightGeneration);
  }
  return inFlight;
}

/** Drops the single-flight memo. For tests and the sign-out teardown path. */
export function resetArtifactMirrorSyncState(): void {
  inFlightGeneration += 1;
  inFlight = null;
}

async function runSync(
  options: ArtifactMirrorSyncOptions,
  generation: number
): Promise<ArtifactMirrorSyncOutcome> {
  try {
    return await runSyncOnce(options);
  } catch {
    // Derived data: a crawl or storage failure never reaches the caller, which
    // may be a foreground refresh with no place to report it.
    return { status: 'failed' };
  } finally {
    if (inFlightGeneration === generation) {
      inFlight = null;
    }
  }
}

async function runSyncOnce(options: ArtifactMirrorSyncOptions): Promise<ArtifactMirrorSyncOutcome> {
  const deps: ArtifactMirrorSyncDeps = { ...DEFAULT_DEPS, ...options.deps };
  // Captured before the first await: every awaited step below can straddle a
  // sign-out, and the fence at each write compares against this epoch.
  const epoch = currentAuthEpoch();
  const userId = deps.resolveUserId();
  if (userId === null) {
    return { status: 'skipped', reason: 'no-user' };
  }

  const scope = readCacheScope(userId);
  const key = syncStateItemKey(userId);
  const state = parseSyncState(await deps.readState(scope, key));
  const now = deps.now();
  if (!options.force && isWithinMinInterval(state.lastRunAt, now)) {
    return { status: 'skipped', reason: 'interval' };
  }
  if (!canPublish(epoch)) {
    return { status: 'discarded' };
  }

  const page = await listSessionPage({}, deps);
  const run: SyncRun = {
    deps,
    epoch,
    states: nextSessionStates(page.sessions, state.sessions),
  };
  const advanced = await advanceSessions(page.sessions, run);
  if (advanced.discarded || !canPublish(epoch)) {
    return { status: 'discarded' };
  }

  const snapshot = applyByteBudget(page.sessions, run.states);
  deps.applySnapshot({
    version: ARTIFACT_MIRROR_MANIFEST_VERSION,
    updatedAt: new Date(now).toISOString(),
    sessions: snapshot,
  });
  await deps.writeState(scope, key, JSON.stringify({ lastRunAt: now, sessions: run.states }));
  // The state write is awaited as well, so the fence is read once more before
  // the provider is signalled: a sign-out during the write has cleared the
  // mirror, and re-announcing it would be a stale-browser signal.
  if (!canPublish(epoch)) {
    return { status: 'discarded' };
  }
  deps.notify();
  return {
    status: 'synced',
    sessions: page.sessions.length,
    files: advanced.files,
    failed: advanced.failed,
  };
}

/**
 * Advance up to {@link MAX_SESSIONS_PER_RUN} sessions that are not fully
 * crawled, one stored message page each, from their saved cursors. Bounded and
 * sequential: each page's cursor is the previous advance's state, so the await
 * is deliberately serial.
 */
async function advanceSessions(rows: MirrorSessionRow[], run: SyncRun): Promise<AdvanceOutcome> {
  const outcome: AdvanceOutcome = { discarded: false, failed: 0, files: 0 };
  let advanced = 0;
  for (const row of rows) {
    if (advanced >= MAX_SESSIONS_PER_RUN) {
      break;
    }
    const state = run.states[row.id];
    if (state !== undefined && !state.done) {
      advanced += 1;
      if (!canPublish(run.epoch)) {
        return { ...outcome, discarded: true };
      }
      // eslint-disable-next-line no-await-in-loop -- sessions advance one page at a time, in list order
      const materialized = await advanceSession(row, state, run);
      outcome.failed += materialized.failed;
      outcome.files += materialized.files;
      if (materialized.discarded) {
        return { ...outcome, discarded: true };
      }
    }
  }
  return outcome;
}

/** Read one session's next stored page and materialize what it adds. */
async function advanceSession(
  row: MirrorSessionRow,
  state: MirrorSyncSessionState,
  run: SyncRun
): Promise<AdvanceOutcome> {
  const page = await fetchSessionMessagesPage(
    { cursor: state.cursor, sessionId: row.id },
    run.deps
  );
  const advance: SessionAdvance = {
    deps: run.deps,
    epoch: run.epoch,
    known: new Set(state.files.map(file => file.id)),
    sessionId: row.id,
    state,
  };
  return materializePage(page, advance);
}

/**
 * Materialize one page's new artifacts into their session folder. An artifact
 * already in the mirror is never re-fetched, an over-cap one is dropped, and a
 * failed download holds the cursor so the same page is re-read next run and the
 * artifact retried.
 *
 * A page the worker returned as a typed failure never moves the crawl state
 * either. There are no messages to materialize and no cursor the worker
 * produced, so recording the unchanged cursor as progress would mark the
 * session crawled -- done, or resuming from a cursor that skips ahead -- with
 * none of its artifacts read. The next run re-reads this page, the same bounded
 * retry a failed download gets.
 */
async function materializePage(
  page: MirrorMessagePage,
  advance: SessionAdvance
): Promise<AdvanceOutcome> {
  const outcome: AdvanceOutcome = { discarded: false, failed: 0, files: 0 };
  if (page.failure !== null) {
    return { ...outcome, failed: 1 };
  }
  let retryable = false;

  for (const artifact of extractSessionArtifacts(page.messages)) {
    // eslint-disable-next-line no-await-in-loop -- each artifact is checked against the byte cap and the fence before the next
    const note = await materializeOne(artifact, advance);
    if (note.discarded) {
      return { ...outcome, discarded: true, failed: outcome.failed + note.failed };
    }
    retryable = retryable || note.retryable;
    outcome.failed += note.failed;
    outcome.files += note.files;
  }

  if (!retryable) {
    advance.state.cursor = page.nextCursor;
    advance.state.done = page.nextCursor === null;
  }
  return outcome;
}

/**
 * Materialize one artifact: skip what is already mirrored, honor the byte cap
 * through {@link materializeArtifact}, and report a failed download as
 * retryable so the caller holds the cursor.
 */
async function materializeOne(
  artifact: CrawledArtifact,
  advance: SessionAdvance
): Promise<ArtifactNote> {
  if (advance.known.has(artifact.id)) {
    return artifactNote();
  }
  if (!canPublish(advance.epoch)) {
    return artifactNote({ discarded: true });
  }
  const target = mirrorTarget(advance.sessionId, artifact, advance.deps);
  if (target === null) {
    return artifactNote();
  }

  const result = await materializeArtifact(artifact, target, advance.deps);
  // The download is the run's longest await, and sign-out can land inside it:
  // teardown has already cleared the mirror by then, so the fence is read again
  // before the bytes that just arrived join the run's state or the disk.
  if (!canPublish(advance.epoch)) {
    deleteQuietly(target);
    return artifactNote({ discarded: true });
  }
  if (result.ok) {
    advance.state.files.push({ ...artifact, size: result.size });
    advance.known.add(artifact.id);
    return artifactNote({ files: 1 });
  }
  deleteQuietly(target);
  return result.reason === 'download-failed'
    ? artifactNote({ failed: 1, retryable: true })
    : artifactNote();
}

/**
 * The target file for one artifact, with its session folder created first
 * because a run materializes before the snapshot creates the layout. Null
 * means this build has nowhere browsable to put the bytes.
 */
function mirrorTarget(
  sessionId: string,
  artifact: CrawledArtifact,
  deps: ArtifactMirrorSyncDeps
): File | null {
  const directory = deps.mirrorSessionDir(sessionId);
  if (directory === null) {
    return null;
  }
  try {
    directory.create({ idempotent: true, intermediates: true });
  } catch {
    return null;
  }
  return new File(directory, artifact.id);
}

/**
 * Carry each known session's crawl state forward. A session missing from the
 * list page is dropped here and pruned by the snapshot; a session that changed
 * since its state was recorded restarts from its first page (already
 * materialized files are skipped), and one still mid-crawl on an unchanged
 * session keeps its cursor.
 *
 * The restart keys on `updatedAt` alone, `done` or not: refreshing the recorded
 * `updatedAt` on a run that only advanced a mid-crawl session would hide that
 * session's change for good, because the run that finally finishes the crawl
 * records the already-changed value and a restart gated on `done` can no longer
 * fire. Messages added behind the saved cursor would then never be read, and
 * neither would the artifacts they carry.
 */
function nextSessionStates(
  rows: MirrorSessionRow[],
  previous: Record<string, MirrorSyncSessionState>
) {
  const next: Record<string, MirrorSyncSessionState> = {};
  for (const row of rows) {
    const prior = previous[row.id];
    if (prior === undefined) {
      next[row.id] = { cursor: null, done: false, files: [], updatedAt: row.updatedAt };
    } else {
      const restart = prior.updatedAt !== row.updatedAt;
      next[row.id] = {
        cursor: restart ? null : prior.cursor,
        done: restart ? false : prior.done,
        files: prior.files,
        updatedAt: row.updatedAt,
      };
    }
  }
  return next;
}

/** The snapshot the run applies, and the crawl state after the budget's eviction. */
function applyByteBudget(
  rows: MirrorSessionRow[],
  states: Record<string, MirrorSyncSessionState>
): ArtifactMirrorSession[] {
  const artifactsBySession = new Map<string, MaterializedArtifact[]>();
  for (const [id, state] of Object.entries(states)) {
    if (state.files.length > 0) {
      artifactsBySession.set(id, state.files);
    }
  }

  const snapshot = selectSessionsWithinBudget(
    buildSessionArtifacts(rows, artifactsBySession),
    MIRROR_BYTE_BUDGET
  );
  // A file the budget dropped must leave the crawl state too: the state is what
  // the next run rebuilds the manifest from, and the evicted bytes are gone
  // from disk.
  for (const session of snapshot) {
    const state = states[session.id];
    if (state !== undefined && state.files.length !== session.files.length) {
      const kept = new Set(session.files.map(file => file.id));
      state.files = state.files.filter(file => kept.has(file.id));
    }
  }
  return snapshot;
}

/** The publication fence: no sign-out in progress and the epoch still current. */
function canPublish(epoch: number): boolean {
  return !isSignOutActive() && isCurrentAuthEpoch(epoch);
}

function isWithinMinInterval(lastRunAt: number | null, now: number): boolean {
  if (lastRunAt === null) {
    return false;
  }
  const elapsed = now - lastRunAt;
  // A clock that moved backwards is not a reason to lock the mirror out.
  return elapsed >= 0 && elapsed < MIRROR_SYNC_MIN_INTERVAL_MS;
}

/** Item key of the sync state inside the user's read-cache scope. */
function syncStateItemKey(userId: string): string {
  return `artifact-mirror:${userId}`;
}

function parseSyncState(raw: string | null): MirrorSyncState {
  if (raw === null) {
    return { lastRunAt: null, sessions: {} };
  }
  try {
    const parsed = syncStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { lastRunAt: null, sessions: {} };
  } catch {
    return { lastRunAt: null, sessions: {} };
  }
}

function deleteQuietly(file: File): void {
  try {
    file.delete();
  } catch {
    // The next run's prune removes a file the filesystem would not delete.
  }
}
