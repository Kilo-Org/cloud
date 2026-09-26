/* eslint-disable max-lines -- notification wiring: foreground/background handlers, channels, and push-token plumbing are kept together. */
import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { z } from 'zod';

import * as Sentry from '@sentry/react-native';
import {
  agentNotificationKindForPushData,
  ANDROID_NOTIFICATION_CHANNELS,
  type AndroidNotificationChannelId,
  type PushData,
  pushDataSchema,
} from '@kilocode/notifications';
import {
  NOTIFICATION_PERMISSION_RESPONDED_EVENT,
  NOTIFICATION_TOKEN_UPDATED_EVENT,
} from '@kilocode/app-shared/analytics';
import {
  buildOpaqueScopeKey,
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { captureEvent } from '@/lib/analytics/posthog';
import { refreshActiveSessionsFromPush } from '@/lib/active-sessions-live-sync';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getTerminalBlankEpoch } from '@/lib/glanceable/cleanup';
import {
  getLastGlanceableSnapshot,
  getLocalScopeKey,
  persistGlanceableSink,
  restorePersistedGlanceable,
} from '@/lib/glanceable/persist';
import { getActiveUserId, getSelectedOrganizationId } from '@/lib/glanceable/scope';
import {
  getGlanceableSinks,
  type GlanceableSink,
  registerGlanceableSink,
} from '@/lib/glanceable/sink-registry';
import { readWaitingAsk } from '@/lib/glanceable/waiting-ask';
import { chainSave } from '@/lib/hooks/save-chain';
import { getDndAccessGranted } from '@/glanceable-android/live-update';
import { i18n } from '@/i18n';
import { setPendingDeepLink } from './deep-link-launch';
import { BACKGROUND_NOTIFICATION_TASK } from './notification-background-task';
import {
  handleNeedsInputNotificationResponse,
  isNeedsInputActionIdentifier,
  pendingDeepLinkOptionsForData,
} from './notification-actions';
import { isAgentProgressAllowedInActiveFocus } from './notification-focus-filter';
import { notificationPathForData } from './notification-path';
import {
  isAppOwnedNeedsInputNotification,
  isNeedsInputNotificationPosted,
} from './needs-input-notification';

const easConfigSchema = z.object({ projectId: z.string().min(1) });

function getProjectId(): string {
  const parsed = easConfigSchema.safeParse(expoConstants.expoConfig?.extra?.eas);
  if (!parsed.success) {
    throw new Error('Missing extra.eas.projectId in app config');
  }
  return parsed.data.projectId;
}

// Tracks which conversation screen is currently focused.
// Read by the foreground notification handler to suppress notifications
// when the user is already viewing that conversation.
// A module-level variable (not React state) because the notification handler
// is registered once and must always read the latest value without stale closures.
let activeChatLocation: { sandboxId: string; conversationId: string } | null = null;

let appBadgeWrite: Promise<void> | null = null;

// The count the last successful native write put on the launcher badge. The
// badge is shared with iOS itself: a visible push that carries its own badge
// moves the icon through the shouldSetBadge path without the app writing.
let badgeWrittenCount: number | null = null;

async function setAppBadge(count: number): Promise<void> {
  try {
    await chainSave('glanceable-app-badge', async () => {
      await Notifications.setBadgeCountAsync(count);
    });
    badgeWrittenCount = count;
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'set_glanceable_badge',
      },
    });
  }
}

function syncAppBadge(count: number): void {
  // Only a change of the needs-input count owns a badge write. Re-asserting
  // an unchanged count would undo a badge iOS applied from a visible push
  // payload (e7: foreground push badge 2 was clobbered back to needsInput 1
  // before the app was terminated).
  if (count === badgeWrittenCount) {
    return;
  }
  appBadgeWrite = setAppBadge(count);
}

const appBadgeSink: GlanceableSink = {
  publish(snapshot) {
    syncAppBadge(snapshot.needsInput);
  },
  async waitForNativeTerminal() {
    if (appBadgeWrite) {
      await appBadgeWrite;
    }
  },
  endImmediate() {
    // A terminal snapshot already published zero.
  },
  startOrUpdate() {
    // The publish operation owns every badge write.
  },
};

export function setActiveChatLocation(
  location: { sandboxId: string; conversationId: string } | null
) {
  activeChatLocation = location;
}

// Runtime-validates that an arbitrary notification `data` payload matches the
// shape we care about. Push producers can evolve independently of the app, so
// always parse before reading fields from the OS-provided notification content.
export function parseNotificationData(data: unknown): PushData | null {
  const parsed = pushDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

// Fallback terminal end for sinks without a native terminal contract.
// Native sinks submit dismissal during publish and never receive this later end.
// A newer eligible snapshot or terminal-blank epoch cancels the fallback.
let glanceableTerminalTimer: ReturnType<typeof setTimeout> | null = null;

function cancelGlanceableTerminalEnd(): void {
  if (glanceableTerminalTimer !== null) {
    clearTimeout(glanceableTerminalTimer);
    glanceableTerminalTimer = null;
  }
}

function scheduleGlanceableTerminalEnd(): void {
  cancelGlanceableTerminalEnd();
  const blankEpoch = getTerminalBlankEpoch();
  glanceableTerminalTimer = setTimeout(() => {
    glanceableTerminalTimer = null;
    // A terminal blank (logout/org switch) that landed during the window
    // already ended the surface; do not end the new scope's activity.
    if (getTerminalBlankEpoch() !== blankEpoch) {
      return;
    }
    // Eligible work published during the window restarted the activity (the
    // in-app publisher owns the foreground path and never cancels this timer);
    // do not end a restarted activity.
    const last = getLastGlanceableSnapshot();
    if (last !== null && isEligibleGlanceableWork(last)) {
      return;
    }
    for (const sink of getGlanceableSinks()) {
      if (!sink.waitForNativeTerminal) {
        sink.endImmediate();
      }
    }
  }, GLANCEABLE_TERMINAL_MS);
}

/**
 * Apply an `active_agents_glanceable` background push to the glanceable sinks
 * (widgets, Android ongoing, iOS Live Activity). Returns false when the push
 * must be dropped: its opaque scope key does not match the persisted local
 * scope key, or it is not newer than the last applied snapshot.
 *
 * The server builds every remote snapshot with revision 1 (it never chains
 * `previousRevision` across requests), so the revision cannot fence against the
 * local monotonic sequence. Fence on `updatedAt` instead and rebase the remote
 * revision onto the local sequence so the sinks' monotonic guards keep
 * accepting it.
 *
 * The server omits `accountEpoch`, so it is set to the current local epoch
 * before publishing. Never opens a session chat.
 */
export async function applyGlanceablePushData(
  data: Extract<PushData, { type: 'active_agents_glanceable' }>
): Promise<boolean> {
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  const scopeKey = getLocalScopeKey();
  const capturedSnapshot = getLastGlanceableSnapshot();
  if (data.scopeKey !== scopeKey) {
    return false;
  }

  const organizationId = await getSelectedOrganizationId();
  const userId = await getActiveUserId();
  if (
    currentAuthEpoch() !== authEpoch ||
    getTerminalBlankEpoch() !== blankEpoch ||
    getLocalScopeKey() !== scopeKey ||
    userId === null ||
    buildOpaqueScopeKey({ userId, organizationId }) !== scopeKey
  ) {
    return false;
  }

  // Fence and rebase against the latest publication after storage reads.
  // A publication during the reads also wins a timestamp tie.
  const { type: _type, ...fields } = data;
  const current = getLastGlanceableSnapshot();
  if (
    current !== null &&
    (fields.updatedAt < current.updatedAt ||
      (current !== capturedSnapshot && fields.updatedAt === current.updatedAt))
  ) {
    return false;
  }

  const snapshot: GlanceableAgentsSnapshot = {
    ...fields,
    revision: current === null ? fields.revision : current.revision + 1,
    accountEpoch: authEpoch,
  };

  const ctx = { userId, organizationId };
  const eligible = isEligibleGlanceableWork(snapshot);
  if (eligible) {
    cancelGlanceableTerminalEnd();
    for (const sink of getGlanceableSinks()) {
      sink.publish(snapshot);
      sink.startOrUpdate(snapshot, ctx);
    }
  } else {
    for (const sink of getGlanceableSinks()) {
      sink.publish(snapshot);
    }
    // Native sinks already submitted their terminal work during publish.
    // Keep the existing fallback for other sinks; widgets retain their timeline.
    scheduleGlanceableTerminalEnd();
  }
  if (appBadgeWrite) {
    await appBadgeWrite;
  }
  // Do not finish a background task before ActivityKit accepts a native end.
  // Idle work keeps the same card, so only ineligible snapshots wait here.
  if (!eligible) {
    await Promise.all(
      getGlanceableSinks().map((sink): Promise<void> | undefined => sink.waitForNativeTerminal?.())
    );
  }
  return true;
}

const shown = {
  shouldPlaySound: true,
  shouldSetBadge: true,
  shouldShowBanner: true,
  shouldShowList: true,
} satisfies Notifications.NotificationBehavior;

const suppressed = {
  shouldPlaySound: false,
  shouldSetBadge: false,
  shouldShowBanner: false,
  shouldShowList: false,
} satisfies Notifications.NotificationBehavior;

export function setupNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async notification => {
      const data = parseNotificationData(notification.request.content.data);

      if (data?.type === 'active_agents_glanceable') {
        // The aggregate glanceable push is a data carrier for the ongoing
        // notification/widgets, never a visible banner: the local ongoing owns
        // the display. Apply it to the sinks regardless of the discard outcome.
        const applied = await applyGlanceablePushData(data);
        if (applied) {
          refreshActiveSessionsFromPush();
        }
        if (!applied) {
          setTimeout(() => {
            // A discarded push carries no new count, so the local truth is
            // unchanged. Re-asserting it here would undo a badge iOS applied
            // from a later visible push (the same e7 clobber as an unchanged
            // re-publication), so it goes through the guarded write too.
            syncAppBadge(getLastGlanceableSnapshot()?.needsInput ?? 0);
          }, 0);
        }
        return { ...suppressed, shouldSetBadge: applied };
      }

      // A per-Focus choice covers agent progress only. The glanceable carrier
      // above already returned (it must still reach the sinks), and anything
      // the user has not excluded stays visible. This is the foreground half of
      // the choice: a background or killed-app delivery never reaches this
      // handler, so the NotificationServiceExtension target in
      // `modules/notification-focus-filter/ios` applies the same stored choice
      // on that path.
      if (
        data &&
        agentNotificationKindForPushData(data) === 'progress' &&
        !isAgentProgressAllowedInActiveFocus()
      ) {
        return suppressed;
      }

      if (
        data?.type === 'chat.message' &&
        activeChatLocation?.sandboxId === data.sandboxId &&
        activeChatLocation.conversationId === data.conversationId
      ) {
        return suppressed;
      }
      // The app's own needs-input notification is already the presentation for
      // this raise: suppressing the server's attention push keeps one OS
      // notification per raise instead of a duplicate banner. The app's own
      // post carries the same parsed payload, so it is exempted by its
      // reserved identifier — suppressing it would drop the only notification
      // the foregrounded app ever presents for the raise (the schedule
      // resolves before the handler consults the posted marker).
      if (
        data?.type === 'cloud_agent_session' &&
        data.category === 'attention' &&
        isNeedsInputNotificationPosted(data.cliSessionId) &&
        !isAppOwnedNeedsInputNotification(notification.request.identifier)
      ) {
        return suppressed;
      }
      return shown;
    },
  });
}

// Expo wraps the data payload of a background notification in a JSON string on
// both platforms; decode that envelope before parsing the push data itself.
const headlessTaskDataSchema = z.object({ dataString: z.string() });

// Test-only override so the background-handler suite never loads the platform
// sink register files (expo-widgets / react-native-android-widget native loads).
let glanceableSinksLoaderForTests: (() => void) | null = null;

export function _setGlanceableSinksLoaderForTests(loader: (() => void) | null): void {
  glanceableSinksLoaderForTests = loader;
}

/**
 * Register the persist sink and the platform sinks so a headless apply has
 * somewhere to publish. The root layout imports the platform register files in
 * the foreground; the headless task context loads only this module, so the
 * sinks must be registered here before `applyGlanceablePushData` runs.
 */
function ensureGlanceableSinksLoaded(): void {
  registerGlanceableSink(appBadgeSink);
  if (glanceableSinksLoaderForTests) {
    glanceableSinksLoaderForTests();
    return;
  }
  registerGlanceableSink(persistGlanceableSink);
  // Side-effect imports register the platform sinks.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy platform sink load
  require('@/glanceable-ios/register');
  try {
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy platform sink load
    require('@/glanceable-android/register');
  } catch {
    // react-native-android-widget is absent on iOS; the iOS sink still loaded.
  }
}

/** Recover the typed push data from the headless payload envelope. */
function parseHeadlessPushData(data: unknown): PushData | null {
  const envelope = headlessTaskDataSchema.safeParse(data);
  if (!envelope.success) {
    return parseNotificationData(data);
  }
  try {
    return parseNotificationData(JSON.parse(envelope.data.dataString));
  } catch {
    return null;
  }
}

/**
 * Headless background-notification executor. Runs when a data-only push is
 * delivered while the app is backgrounded or killed, and when the app is closed
 * and the user taps a needs-input action button. Reuses
 * `applyGlanceablePushData` so the scope-key fence, revision discard, and org
 * re-register behave identically to the foreground path.
 *
 * One task name serves both payload shapes: the native side hands a
 * notification *response* to every registered consumer, so a second name would
 * run an Approve / Reply twice (the second run rewrites the result or answers
 * again). Keep exactly one registered name.
 */
async function handleBackgroundNotificationTask(
  body: TaskManager.TaskManagerTaskBody<Notifications.NotificationTaskPayload>
): Promise<Notifications.BackgroundNotificationTaskResult> {
  const { data, error } = body;
  if (error) {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
  // A notification *response* (an action button or a body tap) is not a
  // delivered push: dispatch it to the needs-input action handler — this is
  // the app-closed path on Android — and keep the glanceable apply for
  // delivered data-only pushes only.
  if ('actionIdentifier' in data) {
    const handled = await handleNeedsInputNotificationResponse(data);
    // An answered raise replaced its notification: report NewData so iOS does
    // not throttle later content-available wakes (repeated NoData reduces them).
    return handled
      ? Notifications.BackgroundNotificationTaskResult.NewData
      : Notifications.BackgroundNotificationTaskResult.NoData;
  }

  const pushData = parseHeadlessPushData(data.data);
  if (pushData?.type !== 'active_agents_glanceable') {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }

  // The headless process is fresh: restore the persisted snapshot and scope key
  // so the fence and revision discard below compare against durable state.
  await restorePersistedGlanceable();
  // The recorded ask is part of that durable state, and the sinks read it
  // synchronously to stamp `canApprove` on the content state. Hydrate the
  // mirror before the apply, or the sink reports no approvable ask and the
  // card hides an Approve that a tap still answers.
  await readWaitingAsk();
  const applied = await applyGlanceablePushData(pushData);
  // A successful apply delivered new sink data: report NewData so iOS does not
  // throttle later content-available wakes (repeated NoData reduces them).
  return applied
    ? Notifications.BackgroundNotificationTaskResult.NewData
    : Notifications.BackgroundNotificationTaskResult.NoData;
}

/**
 * Executor entry for the background notification task, exported for
 * `notification-background-task.ts`, whose task executor lazy-loads this module
 * when a task fires (a headless start evaluates only the app entry, so this
 * graph must not load at entry). Loads the glanceable sinks — a fresh headless
 * process has none registered — then dispatches.
 */
// eslint-disable-next-line promise-function-async -- passthrough dispatch: the executor is the async boundary
export function runBackgroundNotificationTask(
  body: TaskManager.TaskManagerTaskBody<Notifications.NotificationTaskPayload>
): Promise<Notifications.BackgroundNotificationTaskResult> {
  ensureGlanceableSinksLoaded();
  return handleBackgroundNotificationTask(body);
}

async function registerBackgroundNotificationTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        'error.subsystem': 'notifications',
        'error.operation': 'register_background_task',
      },
    });
  }
}

/**
 * Register the background notification task so a data-only
 * `active_agents_glanceable` push is applied while the app is backgrounded or
 * killed, and a notification response (an Approve / Reply tap with the app
 * closed) is dispatched headless. One name only: the native side delivers a
 * response to every registered consumer, so a second name would run the action
 * twice.
 *
 * The same task name is also defined and registered from the app entry
 * (`notification-background-task.ts`, executor lazy-loading this module): a
 * headless JS start — an action tap with the app closed — evaluates only the
 * entry and never this module, so the entry must define the task too or the
 * app-closed path never runs. Both definitions overwrite the same name, and
 * the native registration is idempotent.
 */
export function setupNotificationBackgroundHandler(): void {
  ensureGlanceableSinksLoaded();
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    BACKGROUND_NOTIFICATION_TASK,
    handleBackgroundNotificationTask
  );
  void registerBackgroundNotificationTask();
}

export function setupNotificationResponseHandler() {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    // Our four action ids run headless or stash the deep link; any other
    // identifier keeps the tap path inside the handler.
    void handleNeedsInputNotificationResponse(response);
  });

  return subscription;
}

// Check for notification that launched the app (cold start)
export function checkInitialNotification(): void {
  const response = Notifications.getLastNotificationResponse();
  if (!response) {
    return;
  }
  // An action response that launched the app (Open PR / Open session
  // foreground it) goes through the same dispatch as a warm response.
  if (isNeedsInputActionIdentifier(response.actionIdentifier)) {
    void handleNeedsInputNotificationResponse(response);
    return;
  }
  const data = parseNotificationData(response.notification.request.content.data);
  if (data) {
    // Stash the session's destination the same way the warm tap paths do
    // (notification-actions.ts), so a session push that launches the app lands
    // in the session's organization instead of the previously selected one.
    setPendingDeepLink(
      notificationPathForData(data),
      'notification',
      pendingDeepLinkOptionsForData(data)
    );
  }
  Notifications.clearLastNotificationResponse();
}

// Single-flight promise so concurrent callers share one channel-creation pass.
// The promise never rejects: a per-channel failure is reported to Sentry and
// the remaining channels still get created. A pass that failed any required
// channel is not cached (see `ensureAndroidNotificationChannels`), so a later
// start retries before it posts to a channel that may not exist.
let androidChannelsPromise: Promise<void> | null = null;

// The channels the two named kinds replaced. Android keeps an app-created
// channel until the app deletes it, so a stale one would still appear in the
// system settings list after the upgrade.
const LEGACY_ANDROID_NOTIFICATION_CHANNELS = ['agent', 'chat', 'active-agents'] as const;

// Android plays a channel-based post's sound from the channel (the builder's
// `setSound(null)` is a no-op for a channel post on API 26+), and the framework
// keeps the sound a channel was created with — so the progress kind is silent
// here at creation, while needs-input keeps the default sound for its alert.
// A channel's vibration is independent of its sound: Android defaults it to
// enabled, so silence also has to disable it explicitly.
const SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS = new Set<AndroidNotificationChannelId>([
  'agent-progress',
]);

/** What one Android channel write asks the framework for. */
export type AndroidChannelWritePlan = {
  /** The Do Not Disturb override to ask the framework for. */
  bypassDnd: boolean;
};

/**
 * One channel write's Do Not Disturb override.
 *
 * The framework applies the Do Not Disturb access gate only while it *creates*
 * a channel and then keeps the value it stored. A write to an existing channel
 * updates its name and description but never its override — measured on API 35
 * on 2026-09-17: with the user's Do Not Disturb access granted, requesting
 * `true` for a needs-input channel stored with `false` still reads back
 * `mBypassDnd=false`. A channel created before the user granted access can
 * therefore never gain the override from a later write. The override cannot be
 * taken back either: a recreate of a channel that stored `true` reads back
 * `true` even while the grant is absent, because the framework un-deletes the
 * channel with its previous settings. `writeAndroidNotificationChannel`
 * recreates a channel whose stored override is still `false`, so the framework
 * applies the gate to the grant the user holds now.
 */
export function planAndroidChannelWrite(
  requestedBypassDnd: boolean,
  dndAccessGranted: boolean | null
): AndroidChannelWritePlan {
  if (!requestedBypassDnd) {
    return { bypassDnd: false };
  }
  // An unreadable access state (no native module) keeps the pre-existing
  // request: the framework still decides, and the feature is not silently lost.
  return { bypassDnd: dndAccessGranted !== false };
}

/** Every channel re-write (create and rename) must pass the same sound policy. */
function androidChannelConfiguration(
  channel: (typeof ANDROID_NOTIFICATION_CHANNELS)[number],
  name: string,
  bypassDnd: boolean
): Notifications.NotificationChannelInput {
  return {
    name,
    importance:
      channel.importance === 'high'
        ? Notifications.AndroidImportance.HIGH
        : Notifications.AndroidImportance.DEFAULT,
    bypassDnd,
    // An absent sound is the system default; an explicit null is silence, and a
    // silent channel must not vibrate either (the default is enabled).
    ...(SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS.has(channel.id)
      ? { sound: null, enableVibrate: false }
      : {}),
  };
}

/** The user's Do Not Disturb grant as the native module reports it. */
function androidDndAccessGranted(): boolean | null {
  try {
    return getDndAccessGranted();
  } catch {
    return null;
  }
}

/**
 * Whether a channel's stored override is a stale `false` that this write must
 * replace by recreating the channel.
 *
 * Only the raise needs a recreate: the framework restores the stored override
 * when the app recreates a channel it previously deleted, so a recreate
 * installs an override that was never applied but cannot take one back, and the
 * delete would cost the user the ongoing card for nothing.
 */
export function shouldRecreateAndroidChannel(
  storedBypassDnd: boolean | null,
  desiredBypassDnd: boolean
): boolean {
  return desiredBypassDnd && storedBypassDnd === false;
}

/** The override the framework stores for a channel, or null when it has none. */
async function storedAndroidChannelBypassDnd(
  channelId: AndroidNotificationChannelId
): Promise<boolean | null> {
  try {
    const channel = await Notifications.getNotificationChannelAsync(channelId);
    return channel?.bypassDnd ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one channel with the override the user's grant allows. A channel whose
 * stored override is still `false` while the plan asks for `true` is deleted
 * first, so the framework's create-time gate applies the user's grant; that
 * delete also cancels an ongoing card posted to the channel, so it happens only
 * for the one-time upgrade of a channel created before the user granted access.
 */
async function writeAndroidNotificationChannel(
  channel: (typeof ANDROID_NOTIFICATION_CHANNELS)[number],
  name: string,
  dndAccessGranted: boolean | null
): Promise<void> {
  const plan = planAndroidChannelWrite(channel.bypassDnd, dndAccessGranted);
  const stored = await storedAndroidChannelBypassDnd(channel.id);
  if (shouldRecreateAndroidChannel(stored, plan.bypassDnd)) {
    await Notifications.deleteNotificationChannelAsync(channel.id);
  }
  await Notifications.setNotificationChannelAsync(
    channel.id,
    androidChannelConfiguration(channel, name, plan.bypassDnd)
  );
}

async function createAndroidNotificationChannels(): Promise<boolean> {
  const dndAccessGranted = androidDndAccessGranted();
  let allChannelsWritten = true;
  for (const channel of ANDROID_NOTIFICATION_CHANNELS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- channels are created sequentially so a per-channel failure is isolated
      await writeAndroidNotificationChannel(channel, channel.name, dndAccessGranted);
    } catch (error) {
      allChannelsWritten = false;
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'notifications',
          'error.operation': 'create_android_channel',
          'notification.channel': channel.id,
        },
      });
    }
  }
  for (const legacy of LEGACY_ANDROID_NOTIFICATION_CHANNELS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- channels are deleted sequentially so a per-channel failure is isolated
      await Notifications.deleteNotificationChannelAsync(legacy);
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'notifications',
          'error.operation': 'delete_android_channel',
          'notification.channel': legacy,
        },
      });
    }
  }
  return allChannelsWritten;
}

/**
 * Create the Android notification channels once. No-op on iOS. Idempotent and
 * single-flight: every call returns the same module-level promise, and a
 * per-channel failure never rejects it (reported to Sentry instead).
 *
 * A pass that failed a required channel write is not cached: the framework
 * drops a post addressed to a channel the app never created, so the next start
 * must retry the channels before it posts. Channel writes are idempotent, so a
 * retry is safe, and a fully successful pass is cached again.
 */
// eslint-disable-next-line promise-function-async -- must return the same module-level promise for single-flight
export function ensureAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return Promise.resolve();
  }
  androidChannelsPromise ??= (async () => {
    const allChannelsWritten = await createAndroidNotificationChannels();
    if (!allChannelsWritten) {
      androidChannelsPromise = null;
    }
  })();
  return androidChannelsPromise;
}

const CHANNEL_NAME_KEYS = {
  'needs-input': 'glanceable.needsInput',
  'agent-progress': 'notifications.channel.agentProgress',
  kiloclaw: 'notifications.channel.kiloclaw',
  balance: 'notifications.channel.balance',
  security: 'notifications.channel.security',
} as const satisfies Record<AndroidNotificationChannelId, string>;

/**
 * Re-set every Android channel name with the active catalog translation. Not
 * single-flight and never cached: a language change must always re-write the
 * names, even when `ensureAndroidNotificationChannels` already returned its
 * cached promise. No-op on iOS.
 *
 * The re-write also reconciles the Do Not Disturb override: a channel still
 * stored without it is recreated, so access the user granted after the channel
 * was first created is applied on the next app start.
 */
export async function renameAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const dndAccessGranted = androidDndAccessGranted();
  for (const channel of ANDROID_NOTIFICATION_CHANNELS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- channels are renamed sequentially so a per-channel failure is isolated
      await writeAndroidNotificationChannel(
        channel,
        i18n.t(CHANNEL_NAME_KEYS[channel.id]),
        dndAccessGranted
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'notifications',
          'error.operation': 'rename_android_channel',
          'notification.channel': channel.id,
        },
      });
    }
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  await ensureAndroidNotificationChannels();

  const { status: existingStatus } = await Notifications.getPermissionsAsync();

  let finalStatus = existingStatus;
  if (existingStatus !== Notifications.PermissionStatus.GRANTED) {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
    // Only a live permission request emits an outcome; a pre-granted status
    // does not. Any non-granted result maps to denied.
    emitNotificationPermissionResponded(finalStatus === Notifications.PermissionStatus.GRANTED);
  }

  if (finalStatus !== Notifications.PermissionStatus.GRANTED) {
    return null;
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({
    projectId: getProjectId(),
  });

  return tokenResponse.data;
}

/** Emit the permission-request outcome as an accepted-phase event. */
export function emitNotificationPermissionResponded(granted: boolean): void {
  captureEvent(NOTIFICATION_PERMISSION_RESPONDED_EVENT, {
    outcome: granted ? 'granted' : 'denied',
  });
}

/** Emit a token register/unregister outcome as an accepted-phase event. */
export function emitNotificationTokenUpdated(action: 'registered' | 'unregistered'): void {
  captureEvent(NOTIFICATION_TOKEN_UPDATED_EVENT, { action });
}

/**
 * The stable per-device Expo push token, or null when the permission is not
 * granted (denied or undetermined), so the device never obtained a token this
 * install. Rejects when either expo call throws — the caller decides how to
 * treat a failed lookup.
 */
export async function getDevicePushToken(): Promise<string | null> {
  await ensureAndroidNotificationChannels();

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== Notifications.PermissionStatus.GRANTED) {
    return null;
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({
    projectId: getProjectId(),
  });
  return tokenResponse.data;
}

export type DevicePushTokenOutcome =
  | { kind: 'none' }
  | { kind: 'token'; token: string }
  | { kind: 'lookup-failed' };

/**
 * Three-outcome device push token read for sign-out cleanup. `'none'` means
 * the permission is not granted (denied or undetermined), so the device never
 * obtained a token this install and there is nothing to unregister. `'token'`
 * is the stable per-device Expo push token. `'lookup-failed'` means either
 * expo call threw, so a server row may exist and reconciliation must re-read.
 */
export async function getDevicePushTokenOutcome(): Promise<DevicePushTokenOutcome> {
  try {
    const token = await getDevicePushToken();
    return token === null ? { kind: 'none' } : { kind: 'token', token };
  } catch {
    return { kind: 'lookup-failed' };
  }
}

export async function getNotificationPermissionStatus(): Promise<
  'granted' | 'denied' | 'undetermined'
> {
  const { status } = await Notifications.getPermissionsAsync();
  return status;
}

export function getPlatform(): 'ios' | 'android' {
  if (Platform.OS === 'ios') {
    return 'ios';
  }
  if (Platform.OS === 'android') {
    return 'android';
  }

  throw new Error('Unsupported platform for push notifications');
}
