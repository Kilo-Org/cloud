import {
  glanceableSessionTitle,
  type HomeWidgetPresentation,
} from '@kilocode/app-shared/home-widget';
import { parseTimestamp } from '@kilocode/app-shared/utils';

import { type GlanceableCountFormat } from '@/lib/glanceable/count-format';
import { type GlanceableCountKind } from '@/lib/glanceable/presentation';
import { type GlanceableActionFeedback } from '@/lib/glanceable/surface-extras';

export type AndroidWidgetCount = { label: string; kind: GlanceableCountKind; count: string };
/** A clock time, with the date added when `at` is not today. */
export type GlanceableClockFormat = (at: string) => string;

/** Translated Home widget copy; the layout never translates or formats on its own. */
export type AndroidWidgetHomeCopy = {
  /** The presented state: privacy/signed_out/unavailable centre a locked composition. */
  statusKind: HomeWidgetPresentation['status'];
  /** Picks the status dot colour. */
  primaryKind: GlanceableCountKind | null;
  primaryCount: string;
  primaryLabel: string | null;
  /** Locked, empty ("Nothing running right now") and updating copy; null while content shows. */
  status: string | null;
  /** The 2x1 cell's shorter empty wording. */
  emptyShort: string;
  /** The agent the count is about; an untitled agent reads `common.agent`. */
  title: string | null;
  /** "Next run <time>", "Awaiting update" inside the retry window, then "Was due <time>". */
  wake: string | null;
  /**
   * True when the wake line states a wake that is already behind us — the
   * retry window, then the overdue time. A passed wake is secondary
   * information, so the line draws muted; only a future wake draws in ink.
   */
  wakePassed: boolean;
  /** "Checked <time>", or "Last known · <time>" when the data is stale. */
  footer: string | null;
  /** "Approving…" or "Could not approve" while an approve press is in flight or failed. */
  actionLine: string | null;
  /** The Medium/Large footer that replaces the checked time after a failed approve. */
  approveFailed: string;
  headings: { recent: string; waitingForYou: string; nextScheduled: string };
  secondaryCounts: AndroidWidgetCount[];
  waitingAgents: { title: string; reason: string }[];
  scheduledAgents: { title: string; time: string | null }[];
  accessibilityLabel: string;
};

const HOME_COUNT_KEYS = {
  needsInput: 'glanceable.needsInput',
  running: 'common.working',
  scheduled: 'common.scheduled',
  idle: 'common.idle',
} as const;
const WAIT_REASON_KEYS = {
  permission: 'agentChat.permissionCard.title',
  question: 'glanceable.answerNeeded',
  retry: 'glanceable.waitingToRetry',
} as const;
const ACTION_FEEDBACK_KEYS = {
  approving: 'glanceable.approving',
  couldNotApprove: 'glanceable.couldNotApprove',
} as const;

/**
 * The card's wake line, and whether it states a wake already behind us. One
 * read of the clock decides both, so the copy and its muted ink cannot
 * disagree about which case the line draws.
 */
function wakeLine(
  home: HomeWidgetPresentation,
  translate: (key: string) => string,
  formatClock: GlanceableClockFormat
): { value: string; passed: boolean } | null {
  if (home.awaitingUpdate) {
    return { value: translate('glanceable.awaitingUpdate'), passed: true };
  }
  if (home.scheduledAt === null) {
    return null;
  }
  // The retry window has closed, so the card names the clock time it waited
  // for instead of repeating the footer's checked time.
  const due = parseTimestamp(home.scheduledAt).getTime();
  if (Number.isFinite(due) && due <= Date.now()) {
    return {
      value: `${translate('glanceable.wasDue')} ${formatClock(home.scheduledAt)}`,
      passed: true,
    };
  }
  return {
    value: `${translate('glanceable.nextRun')} ${formatClock(home.scheduledAt)}`,
    passed: false,
  };
}

function scheduledAgentTime(
  scheduledAt: string | null,
  translate: (key: string) => string,
  formatClock: GlanceableClockFormat
): string | null {
  if (scheduledAt === null) {
    return null;
  }
  const wake = parseTimestamp(scheduledAt).getTime();
  return Number.isFinite(wake) && wake <= Date.now()
    ? translate('glanceable.awaitingUpdate')
    : formatClock(scheduledAt);
}

function footerLine(
  home: HomeWidgetPresentation,
  translate: (key: string) => string,
  formatClock: GlanceableClockFormat
): string | null {
  if (home.checkedAt === null) {
    return null;
  }
  const at = formatClock(home.checkedAt);
  return home.stale
    ? `${translate('glanceable.lastKnown')} · ${at}`
    : `${translate('glanceable.checked')} ${at}`;
}

// eslint-disable-next-line max-params -- shared policy, translator and injected number/clock formatters keep native/i18n imports out of this builder
export function buildAndroidHomeCopy(
  home: HomeWidgetPresentation,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatClock: GlanceableClockFormat,
  feedback: GlanceableActionFeedback
): AndroidWidgetHomeCopy {
  const primaryLabel =
    home.primaryKind === null ? null : translate(HOME_COUNT_KEYS[home.primaryKind]);
  const secondaryCounts = home.secondaryCounts.map(line => ({
    ...line,
    count: formatCount(line.count),
    label: translate(HOME_COUNT_KEYS[line.kind]),
  }));
  const status =
    home.status === 'content'
      ? null
      : translate(
          {
            waiting: 'glanceable.waiting',
            empty: 'home.noLiveSessions',
            unavailable: 'glanceable.privacy',
            signed_out: 'glanceable.signedOut',
            privacy: 'glanceable.privacy',
          }[home.status]
        );
  const content = home.status === 'content';
  const footer =
    home.status === 'content' || home.status === 'empty'
      ? footerLine(home, translate, formatClock)
      : null;
  const wake =
    content && home.primaryKind === 'scheduled' ? wakeLine(home, translate, formatClock) : null;
  const actionLine = feedback === null ? null : translate(ACTION_FEEDBACK_KEYS[feedback]);
  const title = content
    ? (glanceableSessionTitle(home.primaryTitle) ?? translate('common.agent'))
    : null;
  const counts =
    home.primaryKind === null
      ? []
      : [
          `${formatCount(home.primaryCount)} ${primaryLabel}`,
          ...secondaryCounts.map(line => `${line.count} ${line.label}`),
        ];
  return {
    statusKind: home.status,
    primaryKind: home.primaryKind,
    primaryCount: formatCount(home.primaryCount),
    primaryLabel,
    status,
    emptyShort: translate('glanceable.empty'),
    title,
    wake: wake?.value ?? null,
    wakePassed: wake?.passed ?? false,
    footer,
    actionLine,
    approveFailed: translate('glanceable.approveFailed'),
    headings: {
      recent: translate('common.recent'),
      waitingForYou: translate('glanceable.waitingForYou'),
      nextScheduled: translate('glanceable.nextScheduled'),
    },
    secondaryCounts,
    waitingAgents: home.waitingAgents.map(agent => ({
      title: glanceableSessionTitle(agent.title) ?? translate('common.agent'),
      reason: translate(WAIT_REASON_KEYS[agent.kind]),
    })),
    scheduledAgents: home.scheduledAgents.map(agent => ({
      title: glanceableSessionTitle(agent.title) ?? translate('common.agent'),
      time: scheduledAgentTime(agent.scheduledAt, translate, formatClock),
    })),
    accessibilityLabel: [
      status,
      ...counts,
      actionLine ?? wake?.value ?? title,
      footer,
      translate('glanceable.openAgents'),
    ]
      .filter(Boolean)
      .join(translate('common.listJoiner')),
  };
}
