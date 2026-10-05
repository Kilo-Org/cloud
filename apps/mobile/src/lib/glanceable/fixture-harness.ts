import {
  buildGlanceableSnapshot,
  GLANCEABLE_TERMINAL_MS,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';

import {
  GLANCEABLE_FIXTURES,
  type GlanceableFixture,
  type GlanceableFixtureName,
  isGlanceableFixtureName,
} from './fixture-catalog';
import { holdGlanceableFixture, releaseGlanceableFixtureHold } from './fixture-hold';
import { newestSessionTitle } from './newest-session';
import { getLastGlanceableSnapshot } from './persist';
import { type GlanceablePublisherContext } from './publisher';
import { forEachSink, getGlanceableSinks, writeGlanceableFrame } from './sink-registry';
import { setSurfaceExtras } from './surface-extras';
import { recordWaitingAsk, selectWaitingAsk } from './waiting-ask';

/**
 * Dev-only glanceable fixture harness. `kiloapp:///dev/glanceable-fixture/<name>`
 * pushes a catalog fixture (`fixture-catalog.ts`) into every placed surface and
 * holds the live publisher; `.../release` drops the hold and the publisher
 * mount rebuilds its publisher, which republishes the live tray. The only entry
 * points are `+native-intent.tsx` and the publisher mount, both behind
 * `__DEV__`.
 */

const FIXTURE_PATH = /(?:^|\/)dev\/glanceable-fixture\/([\w-]+)\/?(?:[?#].*)?$/;
const RELEASE = 'release';

/** The signed-in scope the publisher mount runs under, or null while none. */
let scope: GlanceablePublisherContext | null = null;
/** A fixture requested before a scope existed (cold launch, restore in flight). */
let pendingName: GlanceableFixtureName | null = null;
let terminalTimer: ReturnType<typeof setTimeout> | null = null;

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[glanceable-fixture] ${message}`);
}

function cancelTerminal(): void {
  if (terminalTimer !== null) {
    clearTimeout(terminalTimer);
    terminalTimer = null;
  }
}

function apply(name: GlanceableFixtureName, ctx: GlanceablePublisherContext): void {
  const fixture: GlanceableFixture = GLANCEABLE_FIXTURES[name];
  cancelTerminal();
  const now = Date.now();
  // Ids and the cloud connection let the waiting-ask selection name a session,
  // so the Live Activity and the ongoing card offer Approve like a real ask.
  const rows = (fixture.rows?.(now) ?? []).map((row, index) => ({
    id: `glanceable-fixture-${index}`,
    connectionId: CLOUD_AGENT_CONNECTION_ID,
    status: row.status,
    statusUpdatedAt: new Date(now - row.ago * 60_000).toISOString(),
    scheduledAt: row.scheduledAt,
    title: row.title,
  }));
  // Seeded from the persisted revision, which is never below what any sink
  // accepted, so the native surfaces take the frame instead of discarding it.
  const snapshot = buildGlanceableSnapshot({
    sessions: rows,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    now,
    previousRevision: getLastGlanceableSnapshot()?.revision ?? 0,
    status: fixture.status,
  });
  const eligible = isEligibleGlanceableWork(snapshot);
  setSurfaceExtras({
    newestSessionTitle: newestSessionTitle(rows),
    actionFeedback: fixture.actionFeedback ?? null,
  });
  recordWaitingAsk(eligible ? selectWaitingAsk(rows, ctx, now) : null);
  writeGlanceableFrame(getGlanceableSinks(), snapshot, ctx);
  if (!eligible) {
    // The publisher's happy → empty terminal: a sink that does not own its
    // native dismissal (the Android ongoing card) is ended after the window.
    terminalTimer = setTimeout(() => {
      terminalTimer = null;
      forEachSink('fixture_terminal_end', sink => {
        if (!sink.waitForNativeTerminal) {
          sink.endImmediate();
        }
      });
    }, GLANCEABLE_TERMINAL_MS);
  }
  log(`applied ${name} (revision ${snapshot.revision})`);
}

function release(): void {
  pendingName = null;
  cancelTerminal();
  // The rebuilt publisher spreads the current extras, so the fixture's action
  // feedback must not survive into the live surface.
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  recordWaitingAsk(null);
  releaseGlanceableFixtureHold();
  log('released');
}

/**
 * Handle a fixture link. True when the path is a fixture link (handled, even
 * when the name is unknown), so the caller returns falsy and nothing navigates.
 */
export function handleGlanceableFixturePath(path: string): boolean {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === RELEASE) {
    release();
    return true;
  }
  if (!isGlanceableFixtureName(name)) {
    log(`unknown fixture ${name}`);
    return true;
  }
  // Hold first, so the live publisher stays silent while a cold launch waits
  // for the scope.
  holdGlanceableFixture();
  if (scope === null) {
    pendingName = name;
    log(`queued ${name} until a signed-in scope publishes`);
    return true;
  }
  apply(name, scope);
  return true;
}

/** The publisher mount reports its scope; a queued fixture applies on arrival. */
export function setGlanceableFixtureScope(next: GlanceablePublisherContext | null): void {
  scope = next;
  if (next !== null && pendingName !== null) {
    const name = pendingName;
    pendingName = null;
    apply(name, next);
  }
}
