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
 *   state, so a long session converges over several runs. The slots go to the
 *   sessions that waited longest, so a session that keeps changing cannot
 *   hold one while the sessions behind it starve;
 * - an artifact that can never arrive (a missing object, an over-cap size) is
 *   recorded so the crawl moves past it, and a temporary failure is counted up
 *   to {@link MAX_ARTIFACT_ATTEMPTS} before it is written off the same way;
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

/** Temporary failures one artifact gets before it is written off for this session revision. */
export const MAX_ARTIFACT_ATTEMPTS = 3;

/** Total materialized bytes the mirror keeps; oldest session files go first. */
export const MIRROR_BYTE_BUDGET = 250 * 1024 * 1024;

// The persisted run state, validated at the KV boundary: the store is
// encrypted but still untrusted storage after a restore, so a malformed row
// reads as "no state" instead of throwing into the run. The artifact `url` is
// deliberately not part of the row: it can be a `data:` URL holding the whole
// payload, and nothing ever reads it back (`known` keys on `id`, the manifest on
// `id`/`filename`/`mime`/`size`).
const materializedArtifactSchema = z.object({
  filename: z.string().optional(),
  id: z.string(),
  mime: z.string(),
  size: z.number(),
});

/**
 * Why an artifact never produced bytes. Two of these are facts about the
 * artifact that no later run can change (an over-cap size, a missing object);
 * the third is the temporary-failure budget running out, which is a fact about
 * this session revision only.
 */
const terminalCauseSchema = z.enum(['attempts-exhausted', 'missing', 'too-large']);

/** Causes that survive the session starting a new revision. */
const PERMANENT_TERMINAL_CAUSES = {
  'attempts-exhausted': false,
  missing: true,
  'too-large': true,
} satisfies Record<TerminalCause, boolean>;

const sessionStateSchema = z.object({
  cursor: z.string().nullable(),
  done: z.boolean(),
  /** Artifacts already materialized into the mirror, in discovery order. */
  files: z.array(materializedArtifactSchema),
  /**
   * Ids the crawl will not attempt again in this session revision, mapped to
   * why. Skipping them is what lets the cursor move past a page whose artifact
   * can never arrive.
   */
  terminal: z.record(z.string(), terminalCauseSchema).default({}),
  /** Temporary failures counted against {@link MAX_ARTIFACT_ATTEMPTS}. */
  attempts: z.record(z.string(), z.number().int().positive()).default({}),
  /** `updatedAt` of the session row this crawl state was built from. */
  updatedAt: z.string(),
  /**
   * When this session last got one of {@link MAX_SESSIONS_PER_RUN}'s slots.
   * The budget goes to the sessions that waited longest, so a session that
   * keeps changing cannot hold a slot while the ones behind it starve.
   */
  lastAdvancedAt: z.number().nullable().default(null),
});

const syncStateSchema = z.object({
  lastRunAt: z.number().nullable(),
  sessions: z.record(z.string(), sessionStateSchema),
});

type MirrorSyncSessionState = z.infer<typeof sessionStateSchema>;
type MirrorSyncState = z.infer<typeof syncStateSchema>;
type TerminalCause = z.infer<typeof terminalCauseSchema>;

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
  /** Identity of this run, used to name the staging bytes it alone owns. */
  generation: number;
  /** The run's clock reading, stamped on each session it advances. */
  now: number;
  states: Record<string, MirrorSyncSessionState>;
};

/** One session being advanced, plus the ids already proven materialized. */
type SessionAdvance = {
  deps: ArtifactMirrorSyncDeps;
  epoch: number;
  generation: number;
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
    return await runSyncOnce(options, generation);
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

async function runSyncOnce(
  options: ArtifactMirrorSyncOptions,
  generation: number
): Promise<ArtifactMirrorSyncOutcome> {
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
  const stored = parseSyncState(await deps.readState(scope, key));
  const now = deps.now();
  if (!options.force && isWithinMinInterval(stored.lastRunAt, now)) {
    return { status: 'skipped', reason: 'interval' };
  }
  if (!canPublish(epoch)) {
    return { status: 'discarded' };
  }
  // Reconcile only once the run is going ahead: the probe stats the mirror, and
  // a run the interval gate skips must not pay for that on the JS thread.
  const page = await listSessionPage({}, deps);
  const run: SyncRun = {
    deps,
    epoch,
    generation,
    now,
    states: nextSessionStates(page.sessions, reconcileWithDisk(stored, deps).sessions),
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
 * Advance up to {@link MAX_SESSIONS_PER_RUN} not-fully-crawled sessions, one
 * stored message page each, from their saved cursors. The budget goes to the
 * sessions that waited longest (`lastAdvancedAt` ascending, list order breaking
 * ties), so a session that keeps changing cannot hold a slot while the ones
 * behind it starve. Bounded and sequential: each page's cursor is the previous
 * advance's state, so the await is deliberately serial.
 */
async function advanceSessions(rows: MirrorSessionRow[], run: SyncRun): Promise<AdvanceOutcome> {
  const outcome: AdvanceOutcome = { discarded: false, failed: 0, files: 0 };
  const candidates: { index: number; row: MirrorSessionRow; state: MirrorSyncSessionState }[] = [];
  for (const [index, row] of rows.entries()) {
    const state = run.states[row.id];
    if (state !== undefined && !state.done) {
      candidates.push({ index, row, state });
    }
  }
  // Hermes lacks `toSorted()`; this array is the walk's own, so sorting it in
  // place cannot reach the caller's list page.
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes lacks toSorted()
  const waitedLongestFirst = candidates.sort(
    (a, b) => (a.state.lastAdvancedAt ?? 0) - (b.state.lastAdvancedAt ?? 0) || a.index - b.index
  );

  for (const { row, state } of waitedLongestFirst.slice(0, MAX_SESSIONS_PER_RUN)) {
    if (!canPublish(run.epoch)) {
      return { ...outcome, discarded: true };
    }
    // Stamped before the await: an aborted run still spent this session's slot,
    // so it must not be first in line again next run.
    state.lastAdvancedAt = run.now;
    // eslint-disable-next-line no-await-in-loop -- sessions advance one page at a time
    const materialized = await advanceSession(row, state, run);
    outcome.failed += materialized.failed;
    outcome.files += materialized.files;
    if (materialized.discarded) {
      return { ...outcome, discarded: true };
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
    generation: run.generation,
    known: new Set(state.files.map(file => file.id)),
    sessionId: row.id,
    state,
  };
  return materializePage(page, advance);
}

/**
 * Materialize one page's new artifacts into their session folder. An artifact
 * already in the mirror, or already written off, is never re-fetched; an
 * over-cap one is recorded as terminal; and a temporary failure is counted
 * against {@link MAX_ARTIFACT_ATTEMPTS}.
 *
 * A temporary failure under the cap holds the cursor so the same page is
 * re-read next run and the artifact retried. A terminal artifact (a missing
 * object, an over-cap size) and an exhausted attempt budget do not: both are
 * recorded so the cursor advances, because holding it would re-read the page
 * forever and spend one of {@link MAX_SESSIONS_PER_RUN}'s slots on every run.
 *
 * A page the worker returned as a retryable failure never moves the crawl state
 * either. There are no messages to materialize and no cursor the worker
 * produced, so recording the unchanged cursor as progress would mark the
 * session crawled -- done, or resuming from a cursor that skips ahead -- with
 * none of its artifacts read. The next run re-reads this page, the same bounded
 * retry a failed download gets.
 *
 * A `terminal` page failure is different: the worker cannot page that stored
 * history at all (`invalid_data`, `too_large`), so it can never succeed on a
 * later run. Holding the cursor there would re-read it forever and spend one of
 * {@link MAX_SESSIONS_PER_RUN}'s slots on every run, starving the sessions
 * behind it. That session is recorded as crawled instead, with whatever was
 * already materialized, so the budget reaches the sessions that can advance.
 */
async function materializePage(
  page: MirrorMessagePage,
  advance: SessionAdvance
): Promise<AdvanceOutcome> {
  const outcome: AdvanceOutcome = { discarded: false, failed: 0, files: 0 };
  if (page.failure !== null) {
    if (page.failure === 'terminal') {
      advance.state.cursor = page.nextCursor;
      advance.state.done = true;
    }
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
 * Materialize one artifact: skip what is already mirrored or already written
 * off, honor the byte cap through {@link materializeArtifact}, and classify a
 * failure into one of three outcomes.
 *
 * - **Skipped**: already in the mirror, or recorded in `terminal` by an earlier
 *   run, so no network request and no staging file is made.
 * - **Terminal**: the origin said the object is missing, or its size is over the
 *   cap. The cause is recorded so the page cursor may advance; without that the
 *   page would be re-read and the artifact re-probed on every run.
 * - **Temporary**: a transport or origin moment. The attempt is counted, and
 *   only once {@link MAX_ARTIFACT_ATTEMPTS} is spent does the artifact become
 *   terminal (`attempts-exhausted`) instead of holding the cursor forever.
 *
 * The bytes land in a staging file named for this run and are promoted onto the
 * canonical path only once the fence still holds. A discarded run therefore
 * only ever removes bytes it wrote itself: the canonical path may already hold
 * what a later generation wrote for the same artifact after sign-out/sign-in,
 * and a stale cleanup there would delete that newer file under a manifest that
 * still lists it.
 */
async function materializeOne(
  artifact: CrawledArtifact,
  advance: SessionAdvance
): Promise<ArtifactNote> {
  if (advance.known.has(artifact.id) || advance.state.terminal[artifact.id] !== undefined) {
    return artifactNote();
  }
  if (!canPublish(advance.epoch)) {
    return artifactNote({ discarded: true });
  }
  let staged: StagedTarget | null = null;
  try {
    staged = mirrorStagedTarget(advance.sessionId, artifact, advance);
  } catch {
    return artifactNote({ failed: 1, retryable: true });
  }
  if (staged === null) {
    return artifactNote();
  }

  const result = await materializeArtifact(artifact, staged.staging, advance.deps);
  // The download is the run's longest await, and sign-out can land inside it:
  // teardown has already cleared the mirror by then, so the fence is read again
  // before the bytes that just arrived are promoted to the canonical path.
  if (!canPublish(advance.epoch)) {
    deleteQuietly(staged.staging);
    return artifactNote({ discarded: true });
  }
  if (!result.ok) {
    deleteQuietly(staged.staging);
    if (result.reason.kind === 'terminal') {
      advance.state.terminal[artifact.id] = result.reason.cause;
      return artifactNote({ failed: 1 });
    }
    const attempts = (advance.state.attempts[artifact.id] ?? 0) + 1;
    advance.state.attempts[artifact.id] = attempts;
    if (attempts >= MAX_ARTIFACT_ATTEMPTS) {
      advance.state.terminal[artifact.id] = 'attempts-exhausted';
      return artifactNote({ failed: 1 });
    }
    return artifactNote({ failed: 1, retryable: true });
  }
  if (!promote(staged.staging, staged.canonical)) {
    // A filesystem failure says nothing about the artifact, so it is retried
    // without counting against the budget.
    deleteQuietly(staged.staging);
    return artifactNote({ failed: 1, retryable: true });
  }
  advance.state.attempts = withoutAttempts(advance.state.attempts, artifact.id);
  advance.state.files.push({
    id: artifact.id,
    mime: artifact.mime,
    size: result.size,
    ...(artifact.filename === undefined ? {} : { filename: artifact.filename }),
  });
  advance.known.add(artifact.id);
  return artifactNote({ files: 1 });
}

/** This run's private staging file, plus the canonical path it becomes. */
type StagedTarget = { canonical: File; staging: File };

/**
 * The target files for one artifact, with its session folder created first
 * because a run materializes before the snapshot creates the layout. Null means
 * this build has nowhere browsable to put the bytes. Filesystem errors throw so
 * the caller holds the page for a retry instead of treating it as a no-op.
 */
function mirrorStagedTarget(
  sessionId: string,
  artifact: CrawledArtifact,
  advance: SessionAdvance
): StagedTarget | null {
  const directory = advance.deps.mirrorSessionDir(sessionId);
  if (directory === null) {
    return null;
  }
  directory.create({ idempotent: true, intermediates: true });
  return {
    canonical: new File(directory, artifact.id),
    staging: new File(directory, stagingFileName(artifact.id, advance.generation)),
  };
}

/**
 * Name of a run's staging file. The generation makes the name the run's own: a
 * cleanup can only match bytes this run wrote, and a leftover from a crashed run
 * is pruned by the next applied snapshot, which keeps only the manifest's ids.
 */
function stagingFileName(artifactId: string, generation: number): string {
  return `${artifactId}.part-${generation}`;
}

/** Move a run's staged bytes onto the canonical path. False means retry it. */
function promote(staging: File, canonical: File): boolean {
  try {
    staging.moveSync(canonical, { overwrite: true });
    return true;
  } catch {
    return false;
  }
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
 *
 * A restart keeps the terminal causes that are facts about the artifact (a
 * missing object, an over-cap size) and drops `attempts-exhausted`, which is a
 * fact about one session revision: the artifact deserves a fresh budget in the
 * new revision, but re-probing an absent object or a known-oversized one would
 * cost a request that cannot change its answer. The attempt counts go with the
 * exhausted cause, so the new revision starts clean.
 */
function nextSessionStates(
  rows: MirrorSessionRow[],
  previous: Record<string, MirrorSyncSessionState>
) {
  const next: Record<string, MirrorSyncSessionState> = {};
  for (const row of rows) {
    const prior = previous[row.id];
    if (prior === undefined) {
      next[row.id] = {
        cursor: null,
        done: false,
        files: [],
        terminal: {},
        attempts: {},
        updatedAt: row.updatedAt,
        lastAdvancedAt: null,
      };
    } else if (prior.updatedAt === row.updatedAt) {
      next[row.id] = {
        cursor: prior.cursor,
        done: prior.done,
        files: prior.files,
        terminal: prior.terminal,
        attempts: prior.attempts,
        updatedAt: row.updatedAt,
        lastAdvancedAt: prior.lastAdvancedAt,
      };
    } else {
      next[row.id] = {
        cursor: null,
        done: false,
        files: prior.files,
        terminal: permanentTerminalCauses(prior.terminal),
        attempts: {},
        updatedAt: row.updatedAt,
        lastAdvancedAt: prior.lastAdvancedAt,
      };
    }
  }
  return next;
}

/** The recorded causes that outlive the session revision they were found in. */
function permanentTerminalCauses(terminal: MirrorSyncSessionState['terminal']) {
  return Object.fromEntries(
    Object.entries(terminal).filter(([, cause]) => PERMANENT_TERMINAL_CAUSES[cause])
  );
}

/** The attempt counts without one artifact's entry, so a later failure starts at zero. */
function withoutAttempts(attempts: MirrorSyncSessionState['attempts'], artifactId: string) {
  if (attempts[artifactId] === undefined) {
    return attempts;
  }
  return Object.fromEntries(Object.entries(attempts).filter(([id]) => id !== artifactId));
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

/**
 * Reconcile the stored crawl state with the bytes actually in the mirror.
 *
 * The mirror is derived data, and the device can remove it: the file browser
 * can delete a folder and the OS can sweep the cache. A stored state that still
 * names a file whose byte is gone would skip re-materializing it and publish it
 * in the index anyway, so the state is checked against the disk first.
 *
 * A session that lost bytes keeps the files it still has and restarts its crawl
 * from the first page: the lost artifact may sit behind an earlier cursor, so
 * the cursor must go for the crawl to reach it again, while the files that
 * survived stay in the index and are never fetched a second time. The walk is
 * one existence check per stored file, and a session it cannot inspect keeps
 * its stored state, because this probe reads the filesystem and must not fail a
 * run.
 */
function reconcileWithDisk(state: MirrorSyncState, deps: ArtifactMirrorSyncDeps): MirrorSyncState {
  const sessions: Record<string, MirrorSyncSessionState> = {};
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    sessions[sessionId] = reconcileSession(sessionId, session, deps);
  }
  return { lastRunAt: state.lastRunAt, sessions };
}

/**
 * One session's state after the disk check. A session the probe cannot read
 * keeps its stored state, so one unreadable folder never costs the other
 * sessions their reconciliation or fails the run.
 *
 * The lost-bytes state is a restart, so it takes {@link nextSessionStates}'s
 * restart rule: a fresh attempt budget, while the causes that are facts about
 * the artifact survive (an over-cap or missing object is not worth re-probing).
 */
function reconcileSession(
  sessionId: string,
  session: MirrorSyncSessionState,
  deps: ArtifactMirrorSyncDeps
): MirrorSyncSessionState {
  try {
    const directory = deps.mirrorSessionDir(sessionId);
    // No browsable container means nothing was ever materialized there, so the
    // state is kept as it is.
    const present =
      directory === null
        ? session.files
        : session.files.filter(file => new File(directory, file.id).exists);
    return present.length === session.files.length
      ? session
      : {
          cursor: null,
          done: false,
          files: present,
          terminal: permanentTerminalCauses(session.terminal),
          attempts: {},
          updatedAt: session.updatedAt,
          lastAdvancedAt: session.lastAdvancedAt,
        };
  } catch {
    return session;
  }
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
