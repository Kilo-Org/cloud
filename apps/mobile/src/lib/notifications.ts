/* eslint-disable max-lines -- notification wiring: foreground/background handlers, channels, and push-token plumbing are kept together. */
import expoConstants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { z } from 'zod';

import * as Sentry from '@sentry/react-native';
import {
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
  GLANCEABLE_TERMINAL_MS,
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { captureEvent } from '@/lib/analytics/posthog';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getTerminalBlankEpoch } from '@/lib/glanceable/cleanup';
import {
  getLastGlanceableSnapshot,
  getLocalScopeKey,
  persistGlanceableSink,
  restorePersistedGlanceable,
} from '@/lib/glanceable/persist';
import { getGlanceableSinks, registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { i18n } from '@/i18n';
import { setPendingDeepLink } from './deep-link-launch';
import { notificationPathForData } from './notification-path';

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

// Pending 8 s terminal end for a non-eligible remote snapshot. Mirrors the
// in-app publisher's terminal window: publish the empty counts, then end the
// Live Activity / Android ongoing after GLANCEABLE_TERMINAL_MS. A newer
// eligible snapshot cancels it, and the terminal-blank epoch gate skips a
// stale end after a logout/org switch already ended the surface.
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
      sink.endImmediate();
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
  if (data.scopeKey !== getLocalScopeKey()) {
    return false;
  }

  const { type: _type, ...fields } = data;
  const current = getLastGlanceableSnapshot();

  if (current !== null && fields.updatedAt < current.updatedAt) {
    return false;
  }

  const snapshot: GlanceableAgentsSnapshot = {
    ...fields,
    revision: current === null ? fields.revision : current.revision + 1,
    accountEpoch: currentAuthEpoch(),
  };

  const organizationId = await getSelectedOrganizationId();
  const userId = await getActiveUserId();

  const ctx = { userId, organizationId };
  if (isEligibleGlanceableWork(snapshot)) {
    cancelGlanceableTerminalEnd();
    for (const sink of getGlanceableSinks()) {
      sink.publish(snapshot);
      sink.startOrUpdate(snapshot, ctx);
    }
  } else {
    for (const sink of getGlanceableSinks()) {
      sink.publish(snapshot);
    }
    // A remote snapshot with no eligible work must end the Live Activity and
    // the Android ongoing after the terminal window; widgets keep the last
    // published counts (their endImmediate is a no-op).
    scheduleGlanceableTerminalEnd();
  }
  return true;
}

/**
 * Read the selected organization id from SecureStore. The scope-key fence above
 * already proved the incoming snapshot belongs to the current scope, so this id
 * (a string for an org scope, null for personal) keeps org-scoped APNs token
 * lookups finding the token when `startOrUpdate` re-registers it.
 */
async function getSelectedOrganizationId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Read the active-user id hint from SecureStore. Null when the hint is
 * unavailable (headless background apply before the identity resolves, or a
 * failed read). It only feeds logout reconciliation ordering, never the
 * snapshot.
 */
async function getActiveUserId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
  } catch {
    return null;
  }
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
        await applyGlanceablePushData(data);
        return suppressed;
      }

      if (
        data?.type === 'chat.message' &&
        activeChatLocation?.sandboxId === data.sandboxId &&
        activeChatLocation.conversationId === data.conversationId
      ) {
        return suppressed;
      }
      return shown;
    },
  });
}

const GLANCEABLE_BACKGROUND_TASK = 'active-agents-glanceable-background-task';

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
 * delivered while the app is backgrounded or killed. Reuses
 * `applyGlanceablePushData` so the scope-key fence, revision discard, and org
 * re-register behave identically to the foreground path.
 */
async function handleBackgroundNotificationTask(
  body: TaskManager.TaskManagerTaskBody<Notifications.NotificationTaskPayload>
): Promise<Notifications.BackgroundNotificationTaskResult> {
  const { data, error } = body;
  if (error) {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
  // A notification *response* (a tap) is not a delivered push; the glanceable
  // apply runs only for a delivered data-only push.
  if ('actionIdentifier' in data) {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }

  const pushData = parseHeadlessPushData(data.data);
  if (pushData?.type !== 'active_agents_glanceable') {
    return Notifications.BackgroundNotificationTaskResult.NoData;
  }

  // The headless process is fresh: restore the persisted snapshot and scope key
  // so the fence and revision discard below compare against durable state.
  await restorePersistedGlanceable();
  const applied = await applyGlanceablePushData(pushData);
  // A successful apply delivered new sink data: report NewData so iOS does not
  // throttle later content-available wakes (repeated NoData reduces them).
  return applied
    ? Notifications.BackgroundNotificationTaskResult.NewData
    : Notifications.BackgroundNotificationTaskResult.NoData;
}

async function registerBackgroundNotificationTask(): Promise<void> {
  try {
    await Notifications.registerTaskAsync(GLANCEABLE_BACKGROUND_TASK);
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
 * killed. `defineTask` must run at module scope of the root layout, not inside
 * a React effect.
 */
export function setupNotificationBackgroundHandler(): void {
  ensureGlanceableSinksLoaded();
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    GLANCEABLE_BACKGROUND_TASK,
    handleBackgroundNotificationTask
  );
  void registerBackgroundNotificationTask();
}

export function setupNotificationResponseHandler() {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const data = parseNotificationData(response.notification.request.content.data);
    if (!data) {
      return;
    }

    const path = notificationPathForData(data);
    Notifications.clearLastNotificationResponse();
    // Always stash: the gated consumer in `_layout.tsx` owns every navigation.
    // `router.navigate` queues rather than throws when the router is unmounted,
    // so a tap while at the consent/force-update/login gate would navigate past
    // the gate and be dropped by the root redirect.
    setPendingDeepLink(path, 'notification');
  });

  return subscription;
}

// Check for notification that launched the app (cold start)
export function checkInitialNotification(): void {
  const response = Notifications.getLastNotificationResponse();
  if (!response) {
    return;
  }
  const data = parseNotificationData(response.notification.request.content.data);
  if (data) {
    setPendingDeepLink(notificationPathForData(data), 'notification');
  }
  Notifications.clearLastNotificationResponse();
}

// Single-flight promise so concurrent callers share one channel-creation pass.
// The promise never rejects: a per-channel failure is reported to Sentry and
// the remaining channels still get created.
let androidChannelsPromise: Promise<void> | null = null;

async function createAndroidNotificationChannels(): Promise<void> {
  for (const channel of ANDROID_NOTIFICATION_CHANNELS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- channels are created sequentially so a per-channel failure is isolated
      await Notifications.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        importance:
          channel.importance === 'high'
            ? Notifications.AndroidImportance.HIGH
            : Notifications.AndroidImportance.DEFAULT,
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'notifications',
          'error.operation': 'create_android_channel',
          'notification.channel': channel.id,
        },
      });
    }
  }
}

/**
 * Create the Android notification channels once. No-op on iOS. Idempotent and
 * single-flight: every call returns the same module-level promise, and a
 * per-channel failure never rejects it (reported to Sentry instead).
 */
// eslint-disable-next-line promise-function-async -- must return the same module-level promise for single-flight
export function ensureAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return Promise.resolve();
  }
  androidChannelsPromise ??= createAndroidNotificationChannels();
  return androidChannelsPromise;
}

const CHANNEL_NAME_KEYS = {
  agent: 'notifications.channel.agent',
  chat: 'notifications.channel.chat',
  kiloclaw: 'notifications.channel.kiloclaw',
  balance: 'notifications.channel.balance',
  security: 'notifications.channel.security',
  'active-agents': 'glanceable.channelName',
} as const satisfies Record<AndroidNotificationChannelId, string>;

/**
 * Re-set every Android channel name with the active catalog translation. Not
 * single-flight and never cached: a language change must always re-write the
 * names, even when `ensureAndroidNotificationChannels` already returned its
 * cached promise. No-op on iOS.
 */
export async function renameAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  for (const channel of ANDROID_NOTIFICATION_CHANNELS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- channels are renamed sequentially so a per-channel failure is isolated
      await Notifications.setNotificationChannelAsync(channel.id, {
        name: i18n.t(CHANNEL_NAME_KEYS[channel.id]),
        importance:
          channel.importance === 'high'
            ? Notifications.AndroidImportance.HIGH
            : Notifications.AndroidImportance.DEFAULT,
      });
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
