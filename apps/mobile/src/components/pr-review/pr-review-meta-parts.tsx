// The sidebar metadata GitHub shows beside a pull request: when it opened and
// last moved, its labels, its reviewers and their verdicts, its assignees, and
// the issues it closes. Every section hides itself when GitHub reports nothing,
// so a bare PR renders exactly what it does today.

import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  type LucideIcon,
  MessageSquare,
  UserRound,
  Users,
} from '@/components/ui/icons';
import { PrAvatar } from '@/components/pr-review/pr-review-overview-parts';
import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrOverviewDto } from '@/lib/pr-review/merge/merge-blocked-reasons';
import {
  buildPrTimeline,
  labelChipColors,
  type PrReviewerState,
  reviewerStateLabelKey,
  reviewerStateTone,
  type ReviewerTone,
} from '@/lib/pr-review/overview-meta';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

// Lucide icons do not take a `className` color, so each tone names a theme
// color token instead of a Tailwind text class.
const REVIEWER_TONE_COLOR = {
  good: 'good',
  destructive: 'destructive',
  muted: 'mutedForeground',
} satisfies Record<ReviewerTone, keyof ThemeColors>;

const REVIEWER_TONE_CLASS = {
  good: 'text-good',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
} satisfies Record<ReviewerTone, string>;

// Icons live here, not in the pure selector module: `merge-blocked-reasons.ts`
// keeps lucide out of the plain-Node test path for the same reason.
const REVIEWER_STATE_ICON = {
  APPROVED: CircleCheck,
  CHANGES_REQUESTED: CircleX,
  COMMENTED: MessageSquare,
  DISMISSED: MessageSquare,
  PENDING: Clock,
} satisfies Record<PrReviewerState, LucideIcon>;

function SectionHeading({ icon: Icon, label }: Readonly<{ icon?: LucideIcon; label: string }>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-1.5">
      {Icon ? <Icon size={12} color={colors.mutedForeground} /> : null}
      <Text variant="eyebrow" className="uppercase tracking-wide text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}

/** "Opened 3 days ago · Updated 2 hours ago" — one line, always present. */
function PrTimelineLine({ overview }: Readonly<{ overview: PrOverviewDto }>) {
  const { t } = useTranslation();
  const parts = buildPrTimeline(overview).map(entry =>
    t(entry.labelKey, { time: timeAgo(parseTimestamp(entry.iso)), login: entry.login ?? '' })
  );
  return (
    <Text variant="muted" className="text-sm">
      {parts.join(' · ')}
    </Text>
  );
}

function PrLabelChips({ labels }: Readonly<{ labels: PrOverviewDto['labels'] }>) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {labels.map(label => {
        const chip = labelChipColors(label.color);
        return (
          <View
            key={label.name}
            className={cn('rounded-full px-2.5 py-1', chip ? undefined : 'bg-secondary')}
            style={chip ? { backgroundColor: chip.background } : undefined}
          >
            <Text
              className={cn('text-xs font-medium', chip ? undefined : 'text-foreground')}
              style={chip ? { color: chip.text } : undefined}
            >
              {label.name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function PrReviewersSection({ reviewers }: Readonly<{ reviewers: PrOverviewDto['reviewers'] }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <SectionHeading icon={Users} label={t('prReview.overview.reviewers')} />
      {reviewers.map(reviewer => {
        const tone = reviewerStateTone(reviewer.state);
        const StateIcon = REVIEWER_STATE_ICON[reviewer.state];
        const stateLabel = t(reviewerStateLabelKey(reviewer.state));
        return (
          <View key={reviewer.login} accessible className="flex-row items-center gap-2">
            <PrAvatar avatarUrl={reviewer.avatarUrl} />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {reviewer.login}
            </Text>
            <StateIcon size={14} color={colors[REVIEWER_TONE_COLOR[tone]]} />
            <Text className={cn('text-xs', REVIEWER_TONE_CLASS[tone])}>{stateLabel}</Text>
          </View>
        );
      })}
    </View>
  );
}

function PrAssigneesRow({ assignees }: Readonly<{ assignees: PrOverviewDto['assignees'] }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <SectionHeading icon={UserRound} label={t('prReview.overview.assignees')} />
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        {assignees.map(assignee => (
          <View key={assignee.login} className="flex-row items-center gap-1.5">
            <PrAvatar avatarUrl={assignee.avatarUrl} />
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {assignee.login}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function PrLinkedIssues({ issues }: Readonly<{ issues: PrOverviewDto['linkedIssues'] }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <SectionHeading icon={CircleDot} label={t('prReview.overview.linkedIssues')} />
      {issues.map(issue => {
        const Icon = issue.closed ? CircleCheck : CircleDot;
        return (
          <Pressable
            key={issue.number}
            accessibilityRole="link"
            accessibilityLabel={t('prReview.overview.openIssueA11y', { number: issue.number })}
            onPress={() => {
              void WebBrowser.openBrowserAsync(issue.url);
            }}
            className="min-h-11 flex-row items-center gap-2 active:opacity-70"
          >
            <Icon size={14} color={issue.closed ? colors.mutedForeground : colors.good} />
            <Text variant="mono" className="text-[13px] text-muted-foreground">
              #{issue.number}
            </Text>
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {issue.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Every sidebar block, in GitHub's own order. `reviewers` and `linkedIssues`
 * come from the overview's GraphQL leg, which degrades to empty on a GraphQL
 * failure — an empty section renders nothing rather than an empty heading.
 */
export function PrOverviewMeta({ overview }: Readonly<{ overview: PrOverviewDto }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <PrTimelineLine overview={overview} />
      {overview.labels.length > 0 ? (
        <View className="gap-2">
          <SectionHeading label={t('prReview.overview.labels')} />
          <PrLabelChips labels={overview.labels} />
        </View>
      ) : null}
      {overview.reviewers.length > 0 ? <PrReviewersSection reviewers={overview.reviewers} /> : null}
      {overview.assignees.length > 0 ? <PrAssigneesRow assignees={overview.assignees} /> : null}
      {overview.linkedIssues.length > 0 ? <PrLinkedIssues issues={overview.linkedIssues} /> : null}
    </View>
  );
}
