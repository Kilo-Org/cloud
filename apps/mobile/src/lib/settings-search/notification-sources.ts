import { type Href } from 'expo-router';

import { type NotificationCategoryKey } from '@/lib/hooks/agent-push-preference';
import {
  defineSetting,
  type SettingDefinition,
  type SettingsSearchSource,
} from '@/lib/settings-search/definitions';

/**
 * The search index for the notification surfaces: the Notifications screen and
 * the personal Spend Alerts screen.
 *
 * Every definition here is a stable preference control, and the screens render
 * their labels from these same definitions, so a row's visible name and its
 * search result cannot drift apart. Dynamic content — the rolling spend
 * amounts, the stored settings rows, notification history — has no definition:
 * nothing in it is a control, and its value changes without the person.
 *
 * Two kinds of gate are deliberately not expressed as `available`:
 * - a server capability (an organization for balance alerts, the Security
 *   Agent for its findings) or a permission (the master push gate disables the
 *   category and preview switches, `canManage` guards Spend Alerts) is only
 *   known after a request, and the target screen renders its own explanation
 *   and disabled control when it applies;
 * - the spend push channel switches to a link to Notifications while the
 *   category or this device cannot deliver, and that row is still the place the
 *   result should land.
 */

/** The Notifications screen, shared by every definition below. */
const NOTIFICATIONS_PATH = '/(app)/notifications' as Extract<Href, string>;

/** The personal Spend Alerts screen in the Profile tab. */
const SPEND_ALERTS_PATH = '/(app)/(tabs)/(3_profile)/spend-alerts' as Extract<Href, string>;

/** The screen's own name as the first breadcrumb of each source below it. */
const NOTIFICATIONS_CONTEXT = 'common.notifications';

/**
 * The device-wide push gate. Its control is the row's switch once push works,
 * and the Enable card while it does not; both are the same setting.
 */
export const NOTIFICATION_DEVICE_SETTING = defineSetting(
  'notifications.device',
  'notifications.deviceTitle',
  'notifications'
);

/**
 * The Lock Screen surface: a Live Activity on iOS, a Live Update on Android.
 * Its label is the row's label on both platforms; the section heading names the
 * platform's own surface (`notifications.liveActivities` or
 * `notifications.liveUpdates`) and is not a control.
 */
export const NOTIFICATION_GLANCEABLE_SETTING = defineSetting(
  'notifications.glanceable',
  'glanceable.channelName',
  'notifications'
);

/** The message-preview choice: the row's control is its switch. */
export const NOTIFICATION_PREVIEW_SETTING = defineSetting(
  'notifications.previews',
  'notifications.showFullPreviews',
  'notifications'
);

/** The agent brief's notification switch, one row of the category group. */
export const NOTIFICATION_AGENT_BRIEF_SETTING = defineSetting(
  'notifications.agentBrief',
  'agentBriefing.title',
  'notifications'
);

/**
 * One definition per notification category. The screen owns their order and
 * their subtitles; these carry the stable id and the visible title.
 */
export const NOTIFICATION_CATEGORY_SETTINGS = {
  agentAttention: defineSetting(
    'notifications.categories.agentAttention',
    'notifications.category.agentAttentionTitle',
    'notifications'
  ),
  agentUpdates: defineSetting(
    'notifications.categories.agentUpdates',
    'notifications.category.agentUpdatesTitle',
    'notifications'
  ),
  sessionStatus: defineSetting(
    'notifications.categories.sessionStatus',
    'notifications.category.sessionStatusTitle',
    'notifications'
  ),
  balanceAlerts: defineSetting(
    'notifications.categories.balanceAlerts',
    'notifications.channel.balance',
    'notifications'
  ),
  spendAlerts: defineSetting(
    'notifications.categories.spendAlerts',
    'notifications.channel.spend',
    'notifications'
  ),
  securityFindings: defineSetting(
    'notifications.categories.securityFindings',
    'notifications.channel.security',
    'notifications'
  ),
} satisfies Record<NotificationCategoryKey, SettingDefinition>;

/** The Spend Alerts master switch; off hides the two rule cards. */
export const SPEND_ALERT_MASTER_SETTING = defineSetting(
  'spendAlerts.master',
  'spendAlerts.sendAlerts',
  'notifications'
);

/** The threshold rule's enable switch, in its card header. */
export const SPEND_ALERT_THRESHOLD_SETTING = defineSetting(
  'spendAlerts.threshold.enabled',
  'spendAlerts.thresholdTitle',
  'notifications'
);

/** The threshold rule's rolling-window choice list. */
export const SPEND_ALERT_WINDOW_SETTING = defineSetting(
  'spendAlerts.threshold.window',
  'spendAlerts.windowLabel',
  'notifications'
);

/** The threshold rule's email channel row. */
export const SPEND_ALERT_THRESHOLD_EMAIL_SETTING = defineSetting(
  'spendAlerts.threshold.email',
  'common.email',
  'notifications'
);

/** The threshold rule's push channel row. */
export const SPEND_ALERT_THRESHOLD_PUSH_SETTING = defineSetting(
  'spendAlerts.threshold.push',
  'notifications.push',
  'notifications'
);

/** The hourly-spike rule's enable switch, in its card header. */
export const SPEND_ALERT_ANOMALY_SETTING = defineSetting(
  'spendAlerts.anomaly.enabled',
  'spendAlerts.anomalyTitle',
  'notifications'
);

/** The hourly-spike rule's email channel row. */
export const SPEND_ALERT_ANOMALY_EMAIL_SETTING = defineSetting(
  'spendAlerts.anomaly.email',
  'common.email',
  'notifications'
);

/** The hourly-spike rule's push channel row. */
export const SPEND_ALERT_ANOMALY_PUSH_SETTING = defineSetting(
  'spendAlerts.anomaly.push',
  'notifications.push',
  'notifications'
);

/**
 * The index sources, in screen order. A source is one section of one screen:
 * the search result can name the section the person is heading for, and the
 * two Spend Alerts rules stay apart even though both carry an Email and a Push
 * row with the same label.
 */
export const NOTIFICATION_SETTINGS_SOURCES: readonly SettingsSearchSource[] = [
  {
    context: [NOTIFICATIONS_CONTEXT],
    path: NOTIFICATIONS_PATH,
    settings: [NOTIFICATION_GLANCEABLE_SETTING],
  },
  {
    context: [NOTIFICATIONS_CONTEXT, 'notifications.push'],
    path: NOTIFICATIONS_PATH,
    settings: [NOTIFICATION_DEVICE_SETTING],
  },
  {
    context: [NOTIFICATIONS_CONTEXT, 'notifications.categories'],
    path: NOTIFICATIONS_PATH,
    settings: [
      NOTIFICATION_CATEGORY_SETTINGS.agentAttention,
      NOTIFICATION_CATEGORY_SETTINGS.agentUpdates,
      NOTIFICATION_CATEGORY_SETTINGS.sessionStatus,
      NOTIFICATION_CATEGORY_SETTINGS.balanceAlerts,
      NOTIFICATION_CATEGORY_SETTINGS.spendAlerts,
      NOTIFICATION_CATEGORY_SETTINGS.securityFindings,
      NOTIFICATION_AGENT_BRIEF_SETTING,
    ],
  },
  {
    context: [NOTIFICATIONS_CONTEXT, 'notifications.messagePreviews'],
    path: NOTIFICATIONS_PATH,
    settings: [NOTIFICATION_PREVIEW_SETTING],
  },
  {
    context: ['notifications.channel.spend'],
    path: SPEND_ALERTS_PATH,
    settings: [SPEND_ALERT_MASTER_SETTING],
  },
  {
    context: ['notifications.channel.spend', 'spendAlerts.thresholdTitle'],
    path: SPEND_ALERTS_PATH,
    settings: [
      SPEND_ALERT_THRESHOLD_SETTING,
      SPEND_ALERT_WINDOW_SETTING,
      SPEND_ALERT_THRESHOLD_EMAIL_SETTING,
      SPEND_ALERT_THRESHOLD_PUSH_SETTING,
    ],
  },
  {
    context: ['notifications.channel.spend', 'spendAlerts.anomalyTitle'],
    path: SPEND_ALERTS_PATH,
    settings: [
      SPEND_ALERT_ANOMALY_SETTING,
      SPEND_ALERT_ANOMALY_EMAIL_SETTING,
      SPEND_ALERT_ANOMALY_PUSH_SETTING,
    ],
  },
];
