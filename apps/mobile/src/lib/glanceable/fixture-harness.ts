import {
  buildGlanceableSnapshot,
  GLANCEABLE_TERMINAL_MS,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { buildHomeWidgetDetails } from '@kilocode/app-shared/home-widget';
import {
  buildSessionLiveActivityContentState,
  type SessionLiveActivityContentState,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';
import { Platform } from 'react-native';

import {
  applyFixtureSessionContent,
  endAllSessionCards,
  finishFixtureSessionCard,
  followSession,
} from '@/lib/glanceable/session-follow';
import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  GLANCEABLE_FIXTURES,
  type GlanceableFixture,
  type GlanceableFixtureName,
  isGlanceableFixtureName,
} from './fixture-catalog';
import { getTerminalBlankEpoch } from './cleanup';
import {
  holdGlanceableFixture,
  isGlanceableFixtureHeld,
  releaseGlanceableFixtureHold,
} from './fixture-hold';
import {
  clearHomeWidgetData,
  rememberHomeWidgetData,
  setHomeWidgetDetails,
} from './home-widget-data';
import {
  clearHomeWidgetRefresh,
  HomeWidgetRefresh,
  syncFixtureWidgetLocale,
} from './home-widget-refresh';
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
/** Shape-valid hex approval key (`homeWidgetDetailsSchema`); it matches no live permission. */
const FIXTURE_APPROVAL_KEY = 'a'.repeat(64);
/**
 * The request the fixture's permission row is bound to. A fixture session has
 * no control-plane row, so its ask is recorded already bound instead of reading
 * one; the id names no live request, so a fixture tap ends `gone` at the read.
 */
const FIXTURE_PERMISSION_ID = 'perm_fixture';

/** The signed-in scope the publisher mount runs under, or null while none. */
let scope: GlanceablePublisherContext | null = null;
/** A fixture requested before a scope existed (cold launch, restore in flight). */
let pendingName: GlanceableFixtureName | null = null;
let terminalTimer: ReturnType<typeof setTimeout> | null = null;
let fixtureGeneration = 0;

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

/**
 * Follow the fixture's row through the Follow path on either platform (the
 * shim picks the Live Activity or the Android notification), so the aggregate card
 * counts it out and the card is drawn from production content. A permission
 * fixture then applies the content a server push would carry (the same
 * builder, with the approval key the server mints); a finished fixture
 * follows the row while it works and then reports it idle.
 */
async function applySessionCardFixture(input: {
  fixture: GlanceableFixture;
  rows: readonly SessionLiveActivityRow[];
  ctx: GlanceablePublisherContext;
  now: number;
}): Promise<void> {
  const { fixture, rows, ctx, now } = input;
  // The fixture's follow replaces any real one: one session card surface at a time.
  endAllSessionCards();
  const follow = fixture.follow;
  const row = follow === undefined ? undefined : rows[follow.index];
  if (follow === undefined || row === undefined) {
    return;
  }
  const at = new Date(now).toISOString();
  const working = {
    ...row,
    status: 'busy',
    statusUpdatedAt: new Date(now - 20 * 60_000).toISOString(),
  };
  log(`session card ${followSession(follow.finish === true ? working : row, ctx, now)}`);
  const facts = follow.card;
  // The richer facts a server push carries, applied through the production
  // builder, so no fixture ever hands the card hand-made props. A quiet fixture
  // moves the last activity past the quiet window, which is what the card
  // reaches its warning from.
  const content: SessionLiveActivityContentState | null =
    follow.approvalKey !== true && facts === undefined
      ? null
      : buildSessionLiveActivityContentState(
          {
            ...row,
            statusUpdatedAt:
              facts?.activityAgo === undefined
                ? row.statusUpdatedAt
                : new Date(now - facts.activityAgo * 60_000).toISOString(),
            currentStep: facts?.step ?? null,
            plan: facts?.plan ?? null,
            changes: facts?.changes ?? null,
            permissionCommand: facts?.permissionCommand ?? null,
            lastActivityAt:
              facts?.activityAgo === undefined
                ? null
                : new Date(now - facts.activityAgo * 60_000).toISOString(),
            costMicrodollars: facts?.costMicrodollars ?? null,
            outcome: facts?.outcome ?? null,
            failure: facts?.failure ?? null,
            prOpened: facts?.outcome === 'pr_opened',
            startedAt:
              facts?.startedAgo === undefined
                ? null
                : new Date(now - facts.startedAgo * 60_000).toISOString(),
          },
          {
            approvalKey: follow.approvalKey === true ? FIXTURE_APPROVAL_KEY : null,
            updatedAt: at,
            statusSinceFallback: row.statusUpdatedAt ?? at,
          }
        );
  if (follow.finish === true) {
    finishFixtureSessionCard({ ...row, statusUpdatedAt: at }, content, now);
  } else if (content !== null) {
    // Await the platform path: the Android branch goes through the real push
    // apply, and the iOS branch settles a card update. Awaiting means the
    // harness's own "applied" line only prints once the card is laid down.
    await applyFixtureSessionContent(content);
  }
}

async function apply(name: GlanceableFixtureName, ctx: GlanceablePublisherContext): Promise<void> {
  fixtureGeneration += 1;
  const generation = fixtureGeneration;
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  await HomeWidgetRefresh?.setFixtureMode(true);
  // Fixture mode blocks `syncHomeWidgetRefresh`, so the app-group locale the
  // widget chrome mirrors its direction from is written here instead: without
  // this the extension keeps the direction of the last real configure and draws
  // Arabic copy inside left-to-right chrome.
  await syncFixtureWidgetLocale();
  const superseded = () =>
    generation !== fixtureGeneration ||
    !isGlanceableFixtureHeld() ||
    currentAuthEpoch() !== authEpoch ||
    getTerminalBlankEpoch() !== blankEpoch ||
    scope?.userId !== ctx.userId ||
    scope.organizationId !== ctx.organizationId;
  if (superseded()) {
    return;
  }
  const fixture: GlanceableFixture = GLANCEABLE_FIXTURES[name];
  cancelTerminal();
  clearHomeWidgetData();
  await clearHomeWidgetRefresh();
  if (superseded()) {
    return;
  }
  const now = Date.now();
  // Ids and the cloud connection let the waiting-ask selection name a session,
  // so the Live Activity and the ongoing card offer Approve like a real ask.
  // A recorded ask also carries an approval key, which is what makes the Home
  // widget draw Approve; the key grants nothing and the press still has to
  // match a live permission.
  const fixtureRows = fixture.rows?.(now) ?? [];
  const approvableIndex = fixtureRows.findIndex(row => row.status === 'permission');
  const rows = fixtureRows.map((row, index) => ({
    id: `glanceable-fixture-${index}`,
    connectionId: CLOUD_AGENT_CONNECTION_ID,
    status: row.status,
    statusUpdatedAt: new Date(now - row.ago * 60_000).toISOString(),
    scheduledAt: row.scheduledAt,
    title: row.title,
    approvalKey: index === approvableIndex ? FIXTURE_APPROVAL_KEY : undefined,
  }));
  // Seeded from the persisted revision, which is never below what any sink
  // accepted, so the native surfaces take the frame instead of discarding it.
  const homeSnapshot = buildGlanceableSnapshot({
    sessions: rows,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    now: now - (fixture.checkedAgo ?? 0) * 60_000,
    previousRevision: getLastGlanceableSnapshot()?.revision ?? 0,
  });
  const details = buildHomeWidgetDetails(rows);
  setHomeWidgetDetails(details);
  const snapshot =
    fixture.status === 'expired'
      ? buildGlanceableSnapshot({
          sessions: [],
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          now,
          previousRevision: homeSnapshot.revision,
          status: 'expired',
        })
      : { ...homeSnapshot, status: fixture.status ?? homeSnapshot.status };
  // The Home card retains last-known work across the delayed and expiry frames, so
  // the record it keeps is the confirmed (happy/empty) snapshot the fixture's rows
  // imply — not the fixture's display override, which `rememberHomeWidgetData`
  // rejects as an unconfirmed state. The waiting fixture has no confirmed work at
  // all, so it retains nothing: an empty record would draw the empty copy instead
  // of "Checking agents". Every other fixture remembers the same snapshot the
  // sinks receive, so `home.status` matches what the widget draws.
  const retained =
    fixture.status === 'stale' || fixture.status === 'expired' ? homeSnapshot : snapshot;
  rememberHomeWidgetData({ snapshot: retained, details });
  const eligible = isEligibleGlanceableWork(snapshot);
  setSurfaceExtras({
    newestSessionTitle: newestSessionTitle(rows),
    actionFeedback: fixture.actionFeedback ?? null,
  });
  const selectedAsk = eligible ? selectWaitingAsk(rows, ctx, now) : null;
  // The fixture row is drawn as the request it names, the state production
  // reaches once its binding lands: a fixture session has no control-plane row
  // to read one from.
  recordWaitingAsk(
    selectedAsk?.status === 'permission' && selectedAsk.isCloudAgent
      ? { ...selectedAsk, boundPermissionId: FIXTURE_PERMISSION_ID }
      : selectedAsk
  );
  // Before the frame: the aggregate card counts a followed row out.
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    await applySessionCardFixture({ fixture, rows, ctx, now });
  }
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

async function release(): Promise<void> {
  fixtureGeneration += 1;
  const generation = fixtureGeneration;
  pendingName = null;
  cancelTerminal();
  clearHomeWidgetData();
  await clearHomeWidgetRefresh();
  if (generation !== fixtureGeneration) {
    return;
  }
  await HomeWidgetRefresh?.setFixtureMode(false);
  if (generation !== fixtureGeneration) {
    return;
  }
  // The rebuilt publisher spreads the current extras, so the fixture's action
  // feedback must not survive into the live surface.
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
  recordWaitingAsk(null);
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    endAllSessionCards();
  }
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
    void release();
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
  void apply(name, scope);
  return true;
}

/** The publisher mount reports its scope; a queued fixture applies on arrival. */
export function setGlanceableFixtureScope(next: GlanceablePublisherContext | null): void {
  scope = next;
  if (next !== null && pendingName !== null) {
    const name = pendingName;
    pendingName = null;
    void apply(name, next);
  }
}
