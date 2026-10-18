import {
  GLANCEABLE_STALE_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildHomeWidgetPresentation,
  EMPTY_HOME_WIDGET_DETAILS,
  type HomeWidgetData,
  type HomeWidgetPresentation,
} from '@kilocode/app-shared/home-widget';

import {
  glanceableCountLines,
  glanceableScheduledAt,
  glanceableSpokenLabel,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';
import { getSurfaceExtras, type GlanceableActionFeedback } from '@/lib/glanceable/surface-extras';

import {
  type AndroidWidgetCount,
  type AndroidWidgetHomeCopy,
  buildAndroidHomeCopy,
  type GlanceableClockFormat,
  type GlanceableCountFormat,
} from './home-copy';

export type GlanceableAgoFormat = (at: string) => string;

/** Home-only titles never enter the counts-only ongoing notification snapshot. */
export type AndroidWidgetProps = {
  home?: HomeWidgetPresentation;
  homeCopy?: AndroidWidgetHomeCopy;
  // Existing count props remain readable for persisted pre-Home presentations.
  statusLine: string | null;
  countLines: AndroidWidgetCount[];
  primaryLabel: string | null;
  scheduledTime: string | null;
  actionFeedback: GlanceableActionFeedback;
  actions: {
    approve: boolean;
    newAgent: boolean;
    approveLabel: string;
    newAgentLabel: string;
  };
  accessibilityLabel: string;
};

/** Signed-out and privacy surfaces override the separately scoped Home data. */
function homeSnapshotFor(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  homeData: HomeWidgetData
): HomeWidgetData['snapshot'] {
  if (flags.signedOut) {
    return { ...snapshot, status: 'signed_out' };
  }
  if (flags.orgInvalid) {
    return { ...snapshot, status: 'privacy' };
  }
  if (snapshot.status === 'signed_out' || snapshot.status === 'privacy') {
    return snapshot;
  }
  return homeData.snapshot;
}

/** Platform localization only; priority, privacy, retention and wake policy are shared. */
// eslint-disable-next-line max-params -- retain existing injected formatters and accept separately scoped Home-only data
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String,
  _formatAgo: GlanceableAgoFormat = String,
  formatClock: GlanceableClockFormat = String,
  homeData?: HomeWidgetData
): AndroidWidgetProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const primary = showCounts ? primaryGlanceableCount(snapshot) : null;
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const resolvedHomeData = homeData ?? { snapshot, details: EMPTY_HOME_WIDGET_DETAILS };
  const home = buildHomeWidgetPresentation(
    { ...resolvedHomeData, snapshot: homeSnapshotFor(snapshot, flags, resolvedHomeData) },
    Date.now()
  );
  const feedback = home.status === 'content' ? getSurfaceExtras().actionFeedback : null;
  const scheduledAt = showCounts ? glanceableScheduledAt(snapshot) : null;
  // Both platforms name the empty state by its New agent action.
  const copy = (key: string): string =>
    translate(key === 'glanceable.empty' ? 'glanceable.noneWaiting' : key);
  return {
    home,
    homeCopy: buildAndroidHomeCopy(home, translate, formatCount, formatClock, feedback),
    statusLine: statusKey === null ? null : copy(statusKey),
    countLines: (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
      kind: line.kind,
      count: formatCount(line.count),
      label: translate(line.key),
    })),
    primaryLabel: primary === null ? null : translate(primary.key),
    scheduledTime: scheduledAt === null ? null : formatClock(scheduledAt),
    actionFeedback: feedback,
    actions: {
      approve: home.canApprove,
      newAgent: home.canCreate,
      approveLabel: translate('common.approve'),
      newAgentLabel: translate('glanceable.newAgent'),
    },
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, copy),
  };
}

/** Aging the Home widget never overwrites confirmed counts or checkedAt. */
// eslint-disable-next-line max-params -- preserve existing injected-format API and separate Home-only data
export function buildCurrentWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat,
  formatClock: GlanceableClockFormat,
  homeData?: HomeWidgetData
): AndroidWidgetProps {
  const expiresAt = Date.parse(snapshot.expiresAt);
  let activitySnapshot = snapshot;
  if (snapshot.status === 'happy' || snapshot.status === 'stale') {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      activitySnapshot = {
        ...snapshot,
        status: 'expired',
        running: 0,
        needsInput: 0,
        idle: 0,
        scheduled: 0,
        needsInputSince: null,
        scheduledAt: null,
      };
    } else if (
      snapshot.status === 'happy' &&
      Date.parse(snapshot.updatedAt) + GLANCEABLE_STALE_MS <= Date.now()
    ) {
      activitySnapshot = { ...snapshot, status: 'stale' };
    }
  }
  return buildAndroidWidgetProps(
    activitySnapshot,
    {},
    translate,
    formatCount,
    formatAgo,
    formatClock,
    homeData ?? { snapshot, details: EMPTY_HOME_WIDGET_DETAILS }
  );
}

/** No account behind a gallery/new-install widget: never invent an empty authenticated tray. */
export function buildGenericWidgetProps(translate: (key: string) => string): AndroidWidgetProps {
  const signedOut = translate('glanceable.signedOut');
  return {
    statusLine: signedOut,
    countLines: [],
    primaryLabel: null,
    scheduledTime: null,
    actionFeedback: null,
    actions: {
      approve: false,
      newAgent: false,
      approveLabel: translate('common.approve'),
      newAgentLabel: translate('glanceable.newAgent'),
    },
    accessibilityLabel: signedOut,
  };
}
