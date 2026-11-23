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
 * the actions kept, the empty-answer body with the actions kept, or the
 * unavailable body with no buttons. Only the retryable failure keeps the
 * raise's time-sensitive break-through — the user's own action has been taken,
 * so its confirmation stays quiet. Every result is posted with `sound: false`
 * for the same reason: Android replays the attention channel's sound on every
 * notify of an existing notification, and a reply result is posted under the
 * acted-on identifier while an approve result replaces an app-owned
 * notification, so both are exactly that in-place notify.
 */

import { z } from 'zod';

import * as Notifications from 'expo-notifications';

import {
  androidChannelIdForPushData,
  ANSWER_DRAFT_MAX_LENGTH,
  genericPushContentForPushData,
  NEEDS_INPUT_ACTION_IDS,
  type NeedsInputActionId,
  needsInputCategoryDescriptors,
  type PushData,
  pushDataSchema,
} from '@kilocode/notifications';

import * as Sentry from '@sentry/react-native';

import { getLanguageSnapshot, i18n } from '@/i18n';
import { hasVisibleComposerText } from '@/lib/composer-text';
import {
  peekNeedsInputReplyDraft,
  rememberNeedsInputReplyDraft,
} from '@/lib/needs-input-reply-draft';

import { type PendingDeepLinkOptions, setPendingDeepLink } from './deep-link-launch';
import {
  type NeedsInputAction,
  type NeedsInputActionOutcome,
} from './notification-action-interaction';
import { notificationPathForData, prPathForData } from './notification-path';
import {
  clearPostedNeedsInputNotification,
  markNeedsInputReplyResult,
  notificationIdentifierForSession,
} from './needs-input-presentation';
import { type NotificationPreviews } from './needs-input-notification';
import { finishHandlingNotificationResponse } from './notification-response-completion';

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
  raiseId?: string;
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
  /**
   * The user's message-preview choice, read from the notification-preferences
   * query the app already holds. Only an in-app response has it: a response
   * handled while the app is closed runs outside that cache, so it passes none
   * and the result keeps the title of the notification the user acted on,
   * which was produced under the choice at that moment.
   */
  readPreviews?: () => NotificationPreviews | undefined;
  /**
   * Defaults to the native report that ends the response on iOS (see
   * `notification-response-completion.ts`); called once the dispatch settles.
   */
  finishHandlingResponse?: (key: string) => void;
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
 * twice. Concurrent dispatches of one response share the first one — an action
 * answers once, and a body tap stashes its destination once; once it settles, a
 * later tap — on the replaced result notification — is answered again.
 *
 * When the shared dispatch settles, with a result or an error, the response is
 * reported finished: iOS keeps the app running for a background action only
 * until then.
 */
// eslint-disable-next-line promise-function-async -- passthrough dispatch: one interaction per tap shares an in-flight promise
export function handleNeedsInputNotificationResponse(
  response: Notifications.NotificationResponse,
  deps: NeedsInputActionDeps = {}
): Promise<boolean> {
  const key = responseDispatchKey(response);
  const inFlight = inFlightDispatches.get(key);
  if (inFlight) {
    return inFlight;
  }
  const dispatch = trackDispatch(
    key,
    dispatchNeedsInputResponse(response, deps),
    deps.finishHandlingResponse ?? finishHandlingNotificationResponse
  );
  inFlightDispatches.set(key, dispatch);
  return dispatch;
}

// One in-flight dispatch per OS response, keyed by its notification identifier
// and action; removed on settle so a retry tap runs again.
const inFlightDispatches = new Map<string, Promise<boolean>>();

/** The OS identity of a response: its notification identifier and action id. */
function responseDispatchKey(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

/**
 * Forget the in-flight dispatch once it settles, without disturbing its result,
 * and report the response finished.
 */
async function trackDispatch(
  key: string,
  dispatch: Promise<boolean>,
  finishHandlingResponse: (key: string) => void
): Promise<boolean> {
  try {
    return await dispatch;
  } finally {
    inFlightDispatches.delete(key);
    finishHandlingResponse(key);
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
      restoreReplyDraftFromData(data);
      // An unparseable PR URL falls back to the session route: the user still
      // lands on the raise instead of nowhere.
      setPendingDeepLink(
        prPathForData(data) ?? notificationPathForData(data),
        'notification',
        pendingDeepLinkOptionsForData(data)
      );
      return true;
    }
    case NEEDS_INPUT_ACTION_IDS.openSession: {
      if (!isRaiseData(data)) {
        await dismissResponseNotification(response);
        return true;
      }
      restoreReplyDraftFromData(data);
      setPendingDeepLink(
        notificationPathForData(data),
        'notification',
        pendingDeepLinkOptionsForData(data)
      );
      return true;
    }
    default: {
      break;
    }
  }

  if (data === null) {
    return false;
  }
  const href = notificationPathForData(data);
  if (href === null) {
    return false;
  }
  Notifications.clearLastNotificationResponse();
  restoreReplyDraftFromData(data);
  // Always stash: the gated consumer in `_layout.tsx` owns every navigation.
  // `router.navigate` queues rather than throws when the router is unmounted,
  // so a tap while at the consent/force-update/login gate would navigate past
  // the gate and be dropped by the root redirect.
  setPendingDeepLink(href, 'notification', pendingDeepLinkOptionsForData(data));
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
 * The pending-slot options a push's destination rides with.
 *
 * A session notification names one session of one account, so its destination
 * is never account-independent: `sessionBound` keeps it for the account that
 * captured it and drops a capture made with no account identity (a signed-out
 * launch), so one account's session notification can never restore and switch
 * the organization for another. The session's organization rides along so the
 * gated consumer switches before it navigates; it is null for a Personal
 * session. A push that names no session carries neither.
 *
 * Shared so the cold-start body tap (notifications.ts) stashes the same
 * destination as the warm tap paths here.
 */
export function pendingDeepLinkOptionsForData(data: PushData): PendingDeepLinkOptions {
  if (data.type !== 'cloud_agent_session') {
    return {};
  }
  return { organizationId: data.organizationId ?? null, sessionBound: true };
}

/**
 * Hand the answer an undelivered reply parked in the result's payload to the
 * session's composer, so the tap opens the raise with the person's text
 * already typed instead of losing it. Only a retryable reply carries a draft;
 * every other result has none, and the tap changes nothing. A reply already
 * held in the slot wins over the payload.
 */
export function restoreReplyDraftFromData(data: PushData): void {
  if (data.type !== 'cloud_agent_session' || data.answerDraft === undefined) {
    return;
  }
  // A held answer is newer than any payload: a payload draft is written when its
  // result post lands, and the slot is written when one does not, so a payload
  // can only predate the held text.
  if (peekNeedsInputReplyDraft(data.cliSessionId) !== null) {
    return;
  }
  rememberNeedsInputReplyDraft(data.cliSessionId, data.answerDraft);
}

/** Dismiss one notification, reporting a failure and never rejecting. */
async function dismissNotificationContaining(identifier: string): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch (error) {
    reportActionFailure('dismiss', error);
  }
}

/**
 * Whether the OS still shows this notification. An unreadable tray counts as
 * not shown, which keeps the other identifier: one duplicate is better than
 * clearing the only carrier left.
 */
async function isStillPresented(identifier: string): Promise<boolean> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    return presented.some(notification => notification.request.identifier === identifier);
  } catch {
    return false;
  }
}

async function dismissResponseNotification(
  response: Notifications.NotificationResponse
): Promise<void> {
  await dismissNotificationContaining(response.notification.request.identifier);
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
   * (`ok` / `unavailable`) and a non-answer (`empty`) are ordinary progress and
   * must not break through.
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
    case 'empty': {
      return {
        body: i18n.t('notifications.needsInputAction.empty'),
        // The raise still waits for an answer, so the actions stay and the
        // person can tap Reply again.
        categoryIdentifier: originalCategoryIdentifier ?? null,
        raiseCleared: false,
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

/**
 * The title the result notification carries. It is the copy already on screen,
 * except when the app knows the user chose `generic` previews: the result then
 * uses the shared generic title, so the result follows the same preview rule as
 * the raise. Without a preference source (a response handled while the app is
 * closed) the acted-on title passes through unchanged — it was produced under
 * the choice at post time.
 */
function resultTitleFor(args: {
  previews: NotificationPreviews | undefined;
  actedOnTitle: string | null | undefined;
  data: NeedsInputRaiseData;
}): string {
  if (args.previews === 'generic') {
    return genericPushContentForPushData(args.data, getLanguageSnapshot()).title;
  }
  return args.actedOnTitle ?? i18n.t('notifications.category.agentAttentionTitle');
}

/**
 * The typed answer a failed reply still owes the person, or undefined for every
 * other result. A retryable reply that had visible text keeps it, capped at the
 * length the push schema admits.
 */
function undeliveredReplyDraft(args: {
  outcome: NeedsInputActionOutcome;
  action: NeedsInputAction;
  text: string | undefined;
}): string | undefined {
  const { outcome, action, text } = args;
  return outcome === 'retryable' &&
    action === 'reply' &&
    text !== undefined &&
    hasVisibleComposerText(text)
    ? text.slice(0, ANSWER_DRAFT_MAX_LENGTH)
    : undefined;
}

/**
 * The payload the posted result carries.
 *
 * A reply that failed retryably keeps the text the person typed in the result's
 * own payload, so a tap on that result hands the text back to the composer: the
 * failure is the only outcome where the raise still waits for the answer, and
 * the typed text would otherwise be lost with the tray row. The text stays out
 * of the body — the result is visible wherever the raise was — and is capped at
 * the length the push schema admits.
 */
function resumeAnswerDraft(
  data: NeedsInputRaiseData,
  args: { outcome: NeedsInputActionOutcome; action: NeedsInputAction; text: string | undefined }
): NeedsInputRaiseData {
  // The acted-on payload may already carry an earlier attempt's draft, because
  // a retryable result is the notification the next tap reads. Only the failure
  // of a reply that had text may carry one, so every other result drops the
  // field instead of inheriting a stale answer.
  const carried = undeliveredReplyDraft(args);
  if (carried === undefined) {
    const { answerDraft: _previousDraft, ...rest } = data;
    return rest;
  }
  return { ...data, answerDraft: carried };
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
      // The raise this notification presented. The interaction answers only
      // that raise; a payload posted before the field existed omits it and
      // keeps the earlier behaviour.
      ...(data.raiseId === undefined ? {} : { raiseId: data.raiseId }),
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

  const identities = resultIdentities(response, data);
  const posted = await replaceNotification({
    ...identities,
    title: resultTitleFor({
      previews: deps.readPreviews?.(),
      actedOnTitle: response.notification.request.content.title,
      data,
    }),
    body: presentation.body,
    data: resumeAnswerDraft(data, { outcome, action, text: response.userText }),
    categoryIdentifier: presentation.categoryIdentifier,
    interruptionLevel: presentation.interruptionLevel,
  });
  if (!posted) {
    const undelivered = undeliveredReplyDraft({ outcome, action, text: response.userText });
    if (undelivered !== undefined) {
      // The result that would carry the text never landed, and the notification
      // that stays still holds its earlier payload, so the slot is the only
      // carrier left.
      rememberNeedsInputReplyDraft(data.cliSessionId, undelivered);
    }
  }

  if (
    posted &&
    identities.resultIdentifier !== notificationIdentifierForSession(data.cliSessionId)
  ) {
    // The result sits under a push's identifier, which the session's plan does
    // not name: it is recorded so the plan retires it with the raise. A post
    // that never landed leaves nothing to retire, and recording it there would
    // make the plan dismiss the acted-on push the failure has to keep.
    markNeedsInputReplyResult(data.cliSessionId, identities.resultIdentifier);
  }

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
 * Where the result goes, which notification it replaces, and which one must
 * survive a failed post.
 *
 * The result is normally posted under `notificationIdentifierForSession` — the
 * identifier the next sync's plan dismisses — and the notification the user
 * acted on is dismissed when it is a different one (a server push carries an
 * OS-assigned identifier).
 *
 * An inline Reply is the exception. Android keeps the replied notification on
 * screen for the reply (`LIFETIME_EXTENDED_BY_DIRECT_REPLY`) and ignores a
 * dismissal of it, so the raise would end with two notifications. Only a post
 * under its own identifier ends that, so the result replaces it in place, and
 * the session's identifier is the one dismissed. iOS removes a replied
 * notification itself, and a post under its identifier is an ordinary post, so
 * both platforms take the same path.
 *
 * `keptIdentifier` is the notification the user tapped. It is the only carrier
 * of the outcome when the result post fails, so it is never dismissed — though
 * it may already be gone on iOS, where the OS removes a replied notification
 * itself, which is why a failed post weighs the other identifier against what
 * the OS still presents. That other identifier may go, because in the
 * inline-reply shape it is the app-owned session raise, and leaving it on
 * screen duplicates the session.
 */
function resultIdentities(
  response: Notifications.NotificationResponse,
  data: NeedsInputRaiseData
): { resultIdentifier: string; replacedIdentifier: string; keptIdentifier: string } {
  const actedOn = response.notification.request.identifier;
  const session = notificationIdentifierForSession(data.cliSessionId);
  return response.userText === undefined
    ? { resultIdentifier: session, replacedIdentifier: actedOn, keptIdentifier: actedOn }
    : { resultIdentifier: actedOn, replacedIdentifier: session, keptIdentifier: actedOn };
}

/**
 * Replace a notification with the action's result: post the result under
 * `resultIdentifier`, and dismiss `replacedIdentifier` when it is a different
 * one, so one raise never ends with two notifications.
 *
 * The dismissal of `replacedIdentifier` follows a post that landed. After a
 * rejected post the acted-on notification (`keptIdentifier`) is always kept —
 * with no result in existence it carries the outcome and, for a retryable
 * result, the Approve/Reply actions the user retries with — and the other
 * identifier is dismissed only while the acted-on one is still presented: iOS
 * removes a replied notification itself, while Android keeps it, so there the
 * acted-on push is the retry carrier and the app-owned session raise is the
 * duplicate that goes.
 *
 * Resolves to whether the result post landed, so the caller records a reply
 * result only for a notification that exists.
 *
 * The result is posted with `sound: false`. Android replays the attention
 * channel's sound on every notify of a notification that already exists, and a
 * reply result is posted under the acted-on identifier while an approve result
 * replaces an app-owned notification — both are exactly that in-place notify,
 * so a sound here would announce the user's own tap back to them. iOS replaces
 * silently when the request carries no sound, which matches.
 */
async function replaceNotification(args: {
  resultIdentifier: string;
  replacedIdentifier: string;
  keptIdentifier: string;
  title: string;
  body: string;
  data: NeedsInputRaiseData;
  categoryIdentifier: string | null;
  interruptionLevel: 'timeSensitive' | null;
}): Promise<boolean> {
  const {
    resultIdentifier,
    replacedIdentifier,
    keptIdentifier,
    title,
    body,
    data,
    categoryIdentifier,
    interruptionLevel,
  } = args;
  let posted = false;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: resultIdentifier,
      content: {
        title,
        body,
        data,
        sound: false,
        ...(categoryIdentifier === null ? {} : { categoryIdentifier }),
        ...(interruptionLevel === null ? {} : { interruptionLevel }),
      },
      // A channel-aware trigger delivers immediately on both platforms: Android
      // routes to the shared attention channel, iOS reads it as a null trigger.
      trigger: { channelId: androidChannelIdForPushData(data) },
    });
    posted = true;
  } catch (error) {
    reportActionFailure('publish', error);
  }
  if (posted) {
    if (replacedIdentifier !== resultIdentifier) {
      await dismissNotificationContaining(replacedIdentifier);
    }
    return true;
  }
  // No result exists. The notification the user acted on carries the outcome and,
  // for a retryable result, the Approve/Reply actions the user retries with, so a
  // failed post never dismisses it. The other identifier is the app-owned session
  // raise in the inline-reply shape; it goes too only while the OS confirms the
  // acted-on notification is still on screen. iOS removes a replied notification
  // itself, so there the session raise is the only carrier left and stays.
  if (
    replacedIdentifier !== resultIdentifier &&
    replacedIdentifier !== keptIdentifier &&
    (await isStillPresented(keptIdentifier))
  ) {
    await dismissNotificationContaining(replacedIdentifier);
  }
  return false;
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
