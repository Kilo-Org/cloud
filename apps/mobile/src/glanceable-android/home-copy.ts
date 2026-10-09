import { type HomeWidgetPresentation } from '@kilocode/app-shared/home-widget';

import { type GlanceableCountKind } from '@/lib/glanceable/presentation';
import { type GlanceableActionFeedback } from '@/lib/glanceable/surface-extras';

export type AndroidWidgetCount = { label: string; kind: GlanceableCountKind; count: string };
export type GlanceableCountFormat = (value: number) => string;
export type GlanceableClockFormat = (at: string, options?: { includeDate: boolean }) => string;

/** Translated Home widget copy; the layout never translates or formats on its own. */
export type AndroidWidgetHomeCopy = {
  /** The presented state: privacy/signed_out/unavailable centre a locked composition. */
  statusKind: HomeWidgetPresentation['status'];
  primaryCount: string;
  primaryLabel: string | null;
  status: string | null;
  detail: string | null;
  checked: string | null;
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

function wakeLine(
  home: HomeWidgetPresentation,
  translate: (key: string) => string,
  formatClock: GlanceableClockFormat
): string | null {
  if (home.awaitingUpdate) {
    return translate('glanceable.awaitingUpdate');
  }
  if (home.scheduledAt === null) {
    return null;
  }
  return `${translate('glanceable.nextRun')} ${formatClock(home.scheduledAt)}`;
}

function scheduledAgentTime(
  scheduledAt: string | null,
  translate: (key: string) => string,
  formatClock: GlanceableClockFormat
): string | null {
  if (scheduledAt === null) {
    return null;
  }
  return Date.parse(scheduledAt) <= Date.now()
    ? translate('glanceable.awaitingUpdate')
    : formatClock(scheduledAt);
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
  const checked =
    home.checkedAt === null
      ? null
      : `${translate('glanceable.checked')} ${formatClock(home.checkedAt, { includeDate: true })}`;
  const wake = wakeLine(home, translate, formatClock);
  const actionLine = feedback === null ? null : translate(ACTION_FEEDBACK_KEYS[feedback]);
  const title = home.primaryTitle === null ? null : home.primaryTitle || translate('common.agent');
  const knownTitle = home.stale
    ? [translate('glanceable.lastKnown'), title].filter(Boolean).join(' · ')
    : title;
  const detail =
    home.status !== 'content'
      ? null
      : (actionLine ?? (home.primaryKind === 'scheduled' ? (wake ?? knownTitle) : knownTitle));
  const counts =
    home.primaryKind === null
      ? []
      : [
          `${formatCount(home.primaryCount)} ${primaryLabel}`,
          ...secondaryCounts.map(line => `${line.count} ${line.label}`),
        ];
  return {
    statusKind: home.status,
    primaryCount: formatCount(home.primaryCount),
    primaryLabel,
    status,
    detail,
    checked,
    secondaryCounts,
    waitingAgents: home.waitingAgents.map(agent => ({
      title: agent.title || translate('common.agent'),
      reason: translate(WAIT_REASON_KEYS[agent.kind]),
    })),
    scheduledAgents: home.scheduledAgents.map(agent => ({
      title: agent.title || translate('common.agent'),
      time: scheduledAgentTime(agent.scheduledAt, translate, formatClock),
    })),
    accessibilityLabel: [
      status,
      ...counts,
      detail,
      home.stale && home.status === 'content' ? translate('glanceable.lastKnown') : null,
      checked,
      translate('glanceable.openAgents'),
    ]
      .filter(Boolean)
      .join(', '),
  };
}
