/* eslint-disable max-lines -- action wiring: category registration, response dispatch, and result replacement are kept together beside notifications.ts. */
/**
 * Notification actions for needs-input raises: Approve, Reply, Open PR,
 * Open session.
 *
 * The categories are registered once per launch under the shared
 * `kilo-needs-input:*` contract (`@kilocode/notifications`), so a raise posted
 * by the app (s5) and the server's attention push carry the same buttons on
 * both platforms. Approve and Reply run headless — they must work with the app
 * closed — through `runNeedsInputInteraction` (the same mobile session manager
 * the in-app blocking card drives), and this module replaces the acted-on
 * notification with the result: the confirmation, the retryable failure with
 * the actions kept, or the unavailable body with no buttons. Only the
 * retryable failure keeps the raise's time-sensitive break-through — the
 * user's own action has been taken, so its confirmation stays quiet.
 */

import { z } from 'zod';

import * as Notifications from 'expo-notifications';

import {
  androidChannelIdForPushData,
  NEEDS_INPUT_ACTION_IDS,
  type NeedsInputActionId,
  needsInputCategoryDescriptors,
  type PushData,
  pushDataSchema,
} from '@kilocode/notifications';

import * as Sentry from '@sentry/react-native';

import { i18n } from '@/i18n';

import { setPendingDeepLink } from './deep-link-launch';
import {
  type NeedsInputAction,
  type NeedsInputActionOutcome,
} from './notification-action-interaction';
import { notificationPathForData, prPathForData } from './notification-path';
import {
  clearPostedNeedsInputNotification,
  notificationIdentifierForSession,
} from './needs-input-notification';

/** Register one category per (raise kind × hasPr) descriptor. */
export async function registerNeedsInputCategories(): Promise<void> {
  for (const descriptor of needsInputCategoryDescriptors()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- per-category failures stay isolated and reported
      await Notifications.setNotificationCategoryAsync(
        descriptor.id,
        descriptor.actionIds.map(actionId => needsInputActionFor(actionId))
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          'error.subsystem': 'notifications',
          'error.operation': 'register_needs_input_category',
          'notification.category': descriptor.id,
        },
      });
    }
  }
}

/** The button each action id renders; answers stay headless, opens foreground. */
function needsInputActionFor(actionId: NeedsInputActionId): Notifications.NotificationAction {
  switch (actionId) {
    case NEEDS_INPUT_ACTION_IDS.approve: {
      return {
        identifier: actionId,
        buttonTitle: i18n.t('common.approve'),
        options: { opensAppToForeground: false },
      };
    }
    case NEEDS_INPUT_ACTION_IDS.reply: {
      return {
        identifier: actionId,
        buttonTitle: i18n.t('common.reply'),
        textInput: {
          submitButtonTitle: i18n.t('common.sendMessage'),
          placeholder: i18n.t('agentChat.questionCard.typeYourOwnAnswerPlaceholder'),
        },
        options: { opensAppToForeground: false },
      };
    }
    case NEEDS_INPUT_ACTION_IDS.openPr: {
      return {
        identifier: actionId,
        buttonTitle: i18n.t('common.openPullRequest'),
        options: { opensAppToForeground: true },
      };
    }
    case NEEDS_INPUT_ACTION_IDS.openSession: {
      return {
        identifier: actionId,
        buttonTitle: i18n.t('notifications.action.openSession'),
        options: { opensAppToForeground: true },
      };
    }
    default: {
      // Exhaustiveness: a new shared action id must be rendered above.
      const _exhaustive: never = actionId;
      return _exhaustive;
    }
  }
}

/** The headless approve/reply runner, injectable so suites skip the RN graph. */
type NeedsInputInteractionRunner = (input: {
  kiloSessionId: string;
  action: NeedsInputAction;
  text?: string;
}) => Promise<NeedsInputActionOutcome>;

export type NeedsInputActionDeps = {
  /** Defaults to the s4 entry point, loaded lazily (see `defaultRunInteraction`). */
  runInteraction?: NeedsInputInteractionRunner;
  /**
   * Defaults to the glanceable tray republish, loaded lazily (see
   * `defaultRefreshGlanceableSurfaces`).
   */
  refreshGlanceableSurfaces?: () => Promise<void>;
};

/** The shape of the s4 entry point, kept as an annotation on the lazy load. */
type InteractionModule = {
  runNeedsInputInteraction: NeedsInputInteractionRunner;
};

// Lazy dynamic import: `notification-action-interaction` builds the real mobile
// session manager, so every RN / Expo / tRPC side-effect import it reaches must
// stay out of import-time graphs of modules that never answer a raise (e.g.
// the headless glanceable apply). Same pattern as deep-link-launch.
async function defaultRunInteraction(
  input: Parameters<NeedsInputInteractionRunner>[0]
): Promise<NeedsInputActionOutcome> {
  const interaction = (await import('./notification-action-interaction')) as InteractionModule;
  return interaction.runNeedsInputInteraction(input);
}

// Lazy for the same reason: the glanceable republish reaches the mobile session
// manager graph, and only an answer that ends a raise needs it.
async function defaultRefreshGlanceableSurfaces(): Promise<void> {
  const { refreshGlanceableSurfacesFromTray } = await import('./glanceable/approve-front-agent');
  await refreshGlanceableSurfacesFromTray();
}

type NeedsInputRaiseData = Extract<PushData, { type: 'cloud_agent_session' }>;

const NEEDS_INPUT_ACTION_IDENTIFIER_SET: ReadonlySet<string> = new Set(
  Object.values(NEEDS_INPUT_ACTION_IDS)
);

/** Whether the action identifier is one of the four needs-input actions. */
export function isNeedsInputActionIdentifier(actionIdentifier: string): boolean {
  return NEEDS_INPUT_ACTION_IDENTIFIER_SET.has(actionIdentifier);
}

// Expo wraps the data payload in a JSON string on the headless background path
// (same envelope as the glanceable task); decode before parsing.
const headlessDataEnvelopeSchema = z.object({ dataString: z.string() });
const headlessStringDataSchema = z.string();

/**
 * Dispatch one notification response.
 *
 * Our four action ids run headless (approve/reply through the s4 entry point;
 * open-pr/open-session stash the deep link). Any other identifier — including
 * the body tap — keeps the existing tap behaviour: the destination from
 * `notificationPathForData` goes into the pending slot, the gated consumer in
 * `_layout.tsx` owns every navigation. Returns true when one of our four ids
 * dispatched, so the headless task can distinguish handled actions from taps.
 *
 * With the app alive in the background, Expo hands the same response to both
 * the JS response listener and the registered background task
 * (ExpoHandlingDelegate.handleNotificationResponse), so one tap can arrive
 * twice. Concurrent dispatches of one response share the first interaction;
 * once it settles, a later tap — on the replaced result notification — is
 * answered again.
 */
// eslint-disable-next-line promise-function-async -- passthrough dispatch: one interaction per tap shares an in-flight promise
export function handleNeedsInputNotificationResponse(
  response: Notifications.NotificationResponse,
  deps: NeedsInputActionDeps = {}
): Promise<boolean> {
  const key = actionDispatchKey(response);
  if (key === null) {
    return dispatchNeedsInputResponse(response, deps);
  }
  const inFlight = inFlightActionDispatches.get(key);
  if (inFlight) {
    return inFlight;
  }
  const dispatch = trackActionDispatch(key, dispatchNeedsInputResponse(response, deps));
  inFlightActionDispatches.set(key, dispatch);
  return dispatch;
}

// One interaction per tap: the in-flight dispatch for each OS response, keyed
// by its notification identifier and action. Entries are removed on settle so
// a retry tap on the replaced notification runs again.
const inFlightActionDispatches = new Map<string, Promise<boolean>>();

/** The OS identity of a response, or null for identifiers outside our four actions. */
function actionDispatchKey(response: Notifications.NotificationResponse): string | null {
  if (!isNeedsInputActionIdentifier(response.actionIdentifier)) {
    return null;
  }
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

/** Forget the in-flight dispatch once it settles, without disturbing its result. */
async function trackActionDispatch(key: string, dispatch: Promise<boolean>): Promise<boolean> {
  try {
    const result = await dispatch;
    inFlightActionDispatches.delete(key);
    return result;
  } catch (error) {
    inFlightActionDispatches.delete(key);
    throw error;
  }
}

async function dispatchNeedsInputResponse(
  response: Notifications.NotificationResponse,
  deps: NeedsInputActionDeps
): Promise<boolean> {
  const data = parseResponseData(response);

  // Our four ids are answered here, never replayed: `checkInitialNotification`
  // dispatches whatever `getLastNotificationResponse()` still holds on a later
  // cold start, so an uncleared Approve/Reply would answer the same raise a
  // second time, and an uncleared Open PR/Open session would navigate again.
  // Any other identifier keeps the tap path, which clears below once it knows
  // there is a destination to stash.
  if (isNeedsInputActionIdentifier(response.actionIdentifier)) {
    Notifications.clearLastNotificationResponse();
  }

  switch (response.actionIdentifier) {
    case NEEDS_INPUT_ACTION_IDS.approve:
    case NEEDS_INPUT_ACTION_IDS.reply: {
      if (!isRaiseData(data)) {
        // The actionable notification cannot act (no session behind it):
        // nothing is left to show.
        await dismissResponseNotification(response);
        return true;
      }
      await runAnswerAction({ response, data, deps });
      return true;
    }
    case NEEDS_INPUT_ACTION_IDS.openPr: {
      if (!isRaiseData(data)) {
        await dismissResponseNotification(response);
        return true;
      }
      // An unparseable PR URL falls back to the session route: the user still
      // lands on the raise instead of nowhere.
      setPendingDeepLink(prPathForData(data) ?? notificationPathForData(data), 'notification', {
        organizationId: organizationIdForData(data),
      });
      return true;
    }
    case NEEDS_INPUT_ACTION_IDS.openSession: {
      if (!isRaiseData(data)) {
        await dismissResponseNotification(response);
        return true;
      }
      setPendingDeepLink(notificationPathForData(data), 'notification', {
        organizationId: organizationIdForData(data),
      });
      return true;
    }
    default: {
      break;
    }
  }

  // Any other identifier keeps the existing tap behaviour.
  if (data === null) {
    return false;
  }
  Notifications.clearLastNotificationResponse();
  // Always stash: the gated consumer in `_layout.tsx` owns every navigation.
  // `router.navigate` queues rather than throws when the router is unmounted,
  // so a tap while at the consent/force-update/login gate would navigate past
  // the gate and be dropped by the root redirect.
  setPendingDeepLink(notificationPathForData(data), 'notification', {
    organizationId: organizationIdForData(data),
  });
  return false;
}

function parseResponseData(response: Notifications.NotificationResponse): PushData | null {
  // The Android headless (app-closed) task payload is the raw serialized
  // content bundle: Expo's JS mapper, which folds the native `dataString`
  // into `data`, only runs on the foreground emitter paths. So the Expo push
  // body can sit in three places — `data` itself (mapped foreground), a JSON
  // string inside `data` (the rehydrated envelope), or `dataString` beside
  // `data` on the unmapped headless bundle (`NotificationSerializer.toBundle`
  // never emits a content `data` bundle for an Expo push).
  const content: Notifications.NotificationContent & { dataString?: unknown } =
    response.notification.request.content;
  const raw: unknown = content.data;
  const envelope = headlessDataEnvelopeSchema.safeParse(raw);
  if (envelope.success) {
    return parseEncodedPayload(envelope.data.dataString);
  }
  // A bare JSON string is the rehydrated data payload itself.
  const stringPayload = headlessStringDataSchema.safeParse(raw);
  if (stringPayload.success) {
    return parseEncodedPayload(stringPayload.data);
  }
  const mapped = parseNotificationPayload(raw);
  if (mapped) {
    return mapped;
  }
  const headlessString = headlessStringDataSchema.safeParse(content.dataString);
  return headlessString.success ? parseEncodedPayload(headlessString.data) : null;
}

function parseEncodedPayload(dataString: string): PushData | null {
  try {
    return parseNotificationPayload(JSON.parse(dataString));
  } catch {
    return null;
  }
}

/** Runtime-validates the OS-provided notification data before reading fields. */
function parseNotificationPayload(data: unknown): PushData | null {
  const parsed = pushDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function isRaiseData(data: PushData | null): data is NeedsInputRaiseData {
  return data?.type === 'cloud_agent_session';
}

/**
 * The organization the tapped notification's session belongs to, or null when
 * it carries none (a Personal session, or any other push type). Rides into the
 * pending deep link so the gated consumer switches before it navigates. Shared
 * so the cold-start body tap (notifications.ts) stashes the same organization
 * as the warm tap paths here.
 */
export function organizationIdForData(data: PushData): string | null {
  return data.type === 'cloud_agent_session' ? (data.organizationId ?? null) : null;
}

async function dismissResponseNotification(
  response: Notifications.NotificationResponse
): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(response.notification.request.identifier);
  } catch (error) {
    reportActionFailure('dismiss', error);
  }
}

type ResultPresentation = {
  body: string;
  /** Null means the result carries no action buttons. */
  categoryIdentifier: string | null;
  /** Whether the raise's presentation is over (release the foreground suppression). */
  raiseCleared: boolean;
  /**
   * The raise's Focus break-through, kept only while the result still needs
   * the user (the retryable failure). A confirmation of the user's own action
   * (`ok` / `unavailable`) is ordinary progress and must not break through.
   */
  interruptionLevel: 'timeSensitive' | null;
};

function resultPresentationFor(
  outcome: NeedsInputActionOutcome,
  action: NeedsInputAction,
  originalCategoryIdentifier: string | undefined | null
): ResultPresentation {
  switch (outcome) {
    case 'ok': {
      return {
        body: i18n.t(
          action === 'approve'
            ? 'notifications.needsInputAction.approved'
            : 'notifications.needsInputAction.replied'
        ),
        categoryIdentifier: null,
        raiseCleared: true,
        interruptionLevel: null,
      };
    }
    case 'unavailable': {
      return {
        body: i18n.t('notifications.needsInputAction.unavailable'),
        categoryIdentifier: null,
        raiseCleared: true,
        interruptionLevel: null,
      };
    }
    case 'retryable': {
      return {
        body: i18n.t('notifications.needsInputAction.failed'),
        categoryIdentifier: originalCategoryIdentifier ?? null,
        raiseCleared: false,
        interruptionLevel: 'timeSensitive',
      };
    }
    default: {
      // Exhaustiveness: a new outcome must map to a presentation above.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

async function runAnswerAction(args: {
  response: Notifications.NotificationResponse;
  data: NeedsInputRaiseData;
  deps: NeedsInputActionDeps;
}): Promise<void> {
  const { response, data, deps } = args;
  const action: NeedsInputAction =
    response.actionIdentifier === NEEDS_INPUT_ACTION_IDS.approve ? 'approve' : 'reply';
  let outcome: NeedsInputActionOutcome = 'retryable';
  try {
    outcome = await (deps.runInteraction ?? defaultRunInteraction)({
      kiloSessionId: data.cliSessionId,
      action,
      ...(action === 'reply' ? { text: response.userText } : {}),
    });
  } catch (error) {
    reportActionFailure('run_interaction', error);
    outcome = 'retryable';
  }

  const presentation = resultPresentationFor(
    outcome,
    action,
    response.notification.request.content.categoryIdentifier
  );
  if (presentation.raiseCleared) {
    // The raise is answered headless and stays answered: drop the posted marker
    // so the foreground handler no longer suppresses a newer attention push.
    clearPostedNeedsInputNotification(data.cliSessionId);
  }

  await replaceNotification({
    resultIdentifier: notificationIdentifierForSession(data.cliSessionId),
    originalIdentifier: response.notification.request.identifier,
    title:
      response.notification.request.content.title ??
      i18n.t('notifications.category.agentAttentionTitle'),
    body: presentation.body,
    data,
    categoryIdentifier: presentation.categoryIdentifier,
    interruptionLevel: presentation.interruptionLevel,
  });

  if (presentation.raiseCleared) {
    // The raise is over for the user. The glanceable surfaces count the tray
    // rows, and the ack only hides the raise from the in-app list, so a
    // surface already showing it must be republished now — a status-only raise
    // never pushes the count that would do it.
    await refreshGlanceableAfterAnswer(deps);
  }
}

/** Republish the glanceable surfaces, containing any failure to reporting. */
async function refreshGlanceableAfterAnswer(deps: NeedsInputActionDeps): Promise<void> {
  try {
    await (deps.refreshGlanceableSurfaces ?? defaultRefreshGlanceableSurfaces)();
  } catch (error) {
    reportActionFailure('glanceable_refresh', error);
  }
}

/**
 * Replace the acted-on notification with the action's result. The result is
 * posted under `notificationIdentifierForSession` — the identifier the next
 * sync's plan dismisses — and the notification the user actually acted on is
 * dismissed when it is a different one (a server push carries an OS-assigned
 * identifier), so one raise never ends with two notifications.
 *
 * `interruptionLevel` is outcome-derived: the retryable failure keeps the
 * raise's time-sensitive break-through because it still needs the user; the
 * `ok` / `unavailable` confirmations are quiet.
 */
async function replaceNotification(args: {
  resultIdentifier: string;
  originalIdentifier: string;
  title: string;
  body: string;
  data: NeedsInputRaiseData;
  categoryIdentifier: string | null;
  interruptionLevel: 'timeSensitive' | null;
}): Promise<void> {
  const {
    resultIdentifier,
    originalIdentifier,
    title,
    body,
    data,
    categoryIdentifier,
    interruptionLevel,
  } = args;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: resultIdentifier,
      content: {
        title,
        body,
        data,
        ...(categoryIdentifier === null ? {} : { categoryIdentifier }),
        ...(interruptionLevel === null ? {} : { interruptionLevel }),
      },
      // A channel-aware trigger delivers immediately on both platforms: Android
      // routes to the shared attention channel, iOS reads it as a null trigger.
      trigger: { channelId: androidChannelIdForPushData(data) },
    });
  } catch (error) {
    reportActionFailure('publish', error);
  }
  if (originalIdentifier !== resultIdentifier) {
    try {
      await Notifications.dismissNotificationAsync(originalIdentifier);
    } catch (error) {
      reportActionFailure('dismiss', error);
    }
  }
}

function reportActionFailure(
  operation: 'publish' | 'dismiss' | 'run_interaction' | 'glanceable_refresh',
  error: unknown
): void {
  Sentry.captureException(error, {
    tags: {
      'error.subsystem': 'notifications',
      'error.operation': `needs_input_action_${operation}`,
    },
  });
}
