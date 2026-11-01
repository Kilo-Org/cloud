import {
  getFindingLifecycleStatusPresentation,
  getFindingSeverityPresentation,
  getSecurityDeadlinePresentation,
  getSupersedingFindingId,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink, GitMerge } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  FINDING_TONE_TEXT_CLASS,
  FINDING_TONE_TO_KV_ROW_TONE,
} from '@/components/security-agent/finding-tone';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { DISMISSAL_REASON_LABEL_KEYS } from '@/components/security-agent/dismissal-reason-keys';
import { storedText } from '@/components/security-agent/stored-text';
import { getDeadlineCopy, isOpenDeadline } from '@/lib/security-agent-copy';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { getSecurityAgentPath, type SecurityFinding } from '@/lib/security-agent';
import { openFindingLink } from '@/lib/security-agent-link';
import { cn, firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingDetailsPanelProps = {
  finding: SecurityFinding;
  scope: string;
};

/** One row of the dates group, before the group decides which row is the last. */
type FindingDateRow = {
  key: string;
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'warn' | 'danger' | 'muted';
};

// Catalog keys for app-shared presentation codes. The mobile app maps a
// stable code (severity, status, dismissal reason, source) to a key and
// renders `t(key)` instead of app-shared's English labels.
const SEVERITY_KEYS = {
  critical: 'common.critical',
  high: 'securityAgent.sla.high',
  medium: 'securityAgent.sla.medium',
  low: 'securityAgent.sla.low',
} satisfies Record<string, string>;

const FINDING_STATUS_KEYS = {
  superseded: 'securityAgent.deadline.superseded',
  fixed: 'securityAgent.filter.fixed',
  dismissed: 'common.dismissed',
  open: 'securityAgent.findingDetails.statusOpen',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function getDismissalReasonLabel(reason: string | null): string {
  const code = storedText(reason);
  if (code === null) {
    return i18n.t('securityAgent.findingDetails.reasonAfterReview');
  }
  const key = lookup(DISMISSAL_REASON_LABEL_KEYS, code);
  return key ? i18n.t(key) : code.replaceAll('_', ' ');
}

function getFindingSourceLabel(source: string): string {
  if (source === 'dependabot') {
    return i18n.t('securityAgent.findingDetails.sourceDependabot');
  }
  return storedText(source)?.replaceAll('_', ' ') ?? i18n.t('common.unknown');
}

function DismissalOrSupersessionNote({
  finding,
  scope,
  supersedingFindingId,
}: Readonly<{ finding: SecurityFinding; scope: string; supersedingFindingId: string | null }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const colors = useThemeColors();

  if (supersedingFindingId) {
    return (
      <Pressable
        className="gap-1 rounded-lg bg-secondary p-3 active:opacity-70"
        onPress={() => {
          pushOnce(getSecurityAgentPath(scope, `findings/${supersedingFindingId}`));
        }}
      >
        <View className="flex-row items-center gap-2">
          <GitMerge size={14} color={colors.mutedForeground} />
          <Text className="text-sm font-medium">
            {t('securityAgent.findingDetails.supersededBy')}
          </Text>
        </View>
        <Text variant="muted" className="text-xs">
          {t('securityAgent.findingDetails.supersededByDescription')}
        </Text>
      </Pressable>
    );
  }

  if (finding.status !== 'ignored') {
    return null;
  }

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <Text className="text-sm font-medium">{t('securityAgent.dismiss.reason')}</Text>
      <Text variant="muted" className="text-xs" selectable>
        {getDismissalReasonLabel(finding.ignored_reason)}
      </Text>
    </View>
  );
}

// Ported from FindingDetailDialog.tsx:552 (getFindingDetailsPresentation) —
// source, package, repository, severity/status, timestamps, and
// dismissal/supersession context as plain facts rather than the web's
// hero + next-step action card (Task 7 owns actions).
export function FindingDetailsPanel({ finding, scope }: Readonly<FindingDetailsPanelProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const now = useRelativeTimeNow();
  const severity = getFindingSeverityPresentation(finding.severity);
  const status = getFindingLifecycleStatusPresentation(finding);
  const deadline = getSecurityDeadlinePresentation(finding);
  const deadlineCopy = getDeadlineCopy(deadline.state);
  // The row already names the lifecycle status. A dismissed, superseded or
  // after-deadline fixed finding carries that same word as its deadline label,
  // so the badge would repeat the chip beside it; it renders only when it adds a
  // deadline of its own. The SLA deadline row below keeps the detail either way.
  const deadlineBadgeCopy =
    deadline.state.kind === 'closed' ||
    (deadline.state.kind === 'fixed' && !deadline.state.beforeDeadline)
      ? null
      : deadlineCopy;
  const supersedingFindingId = getSupersedingFindingId(finding);
  // A code the app does not know yet reads as the raw code, the same way
  // packages/app-shared renders it for web. A word like "Unknown" would hide
  // which value the backend actually sent.
  const severityKey = lookup(SEVERITY_KEYS, finding.severity);
  const severityLabel = severityKey ? t(severityKey) : finding.severity;
  const knownStatusKey =
    finding.status === 'ignored'
      ? FINDING_STATUS_KEYS.dismissed
      : lookup(FINDING_STATUS_KEYS, finding.status);
  const statusKey = supersedingFindingId ? FINDING_STATUS_KEYS.superseded : knownStatusKey;
  const statusLabel = statusKey ? t(statusKey) : finding.status;
  const advisoryUrl = finding.dependabot_html_url;
  // An advisory description arrives as provider markdown: wrapped source lines
  // carry a newline plus the indentation of the next line, which a plain Text
  // paints as ragged, indented fragments instead of a paragraph. Collapsing the
  // whitespace runs leaves one block that wraps to the card width.
  const description = finding.description?.replaceAll(/\s+/g, ' ').trim() ?? '';
  // Each instant the dates group shows carries the label that names it. A
  // dismissed or superseded finding has no deadline left to meet, so its
  // resolution date gets its own row and the SLA row stays with a finding that
  // still has a deadline.
  const dismissedAt = finding.status === 'ignored' ? parseTimestamp(finding.updated_at) : null;
  const dateRows: FindingDateRow[] = [
    {
      key: 'detected',
      label: t('securityAgent.findingDetails.detected'),
      value: timeAgo(parseTimestamp(finding.first_detected_at), undefined, now),
    },
    ...(dismissedAt
      ? [
          {
            key: 'dismissed',
            label: supersedingFindingId
              ? t('securityAgent.findingDetails.supersededOn')
              : t('securityAgent.findingDetails.dismissedOn'),
            value: formatDate(dismissedAt, i18n.language),
          },
        ]
      : [
          {
            key: 'updated',
            label: t('common.updated'),
            value: timeAgo(parseTimestamp(finding.updated_at), undefined, now),
          },
        ]),
    ...(finding.fixed_at
      ? [
          {
            key: 'fixed',
            label: t('securityAgent.filter.fixed'),
            value: timeAgo(parseTimestamp(finding.fixed_at), undefined, now),
          },
        ]
      : []),
    ...(isOpenDeadline(deadline.state)
      ? [
          {
            key: 'sla',
            label: t('securityAgent.findingDetails.slaDeadline'),
            value: deadlineCopy.detail,
            tone: FINDING_TONE_TO_KV_ROW_TONE[deadline.tone],
          },
        ]
      : []),
  ];

  return (
    <View className="gap-4">
      <View className="gap-2 rounded-lg bg-secondary p-3">
        <Text className="text-base font-medium" selectable>
          {finding.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-3">
          <Text className={cn('text-xs font-medium', FINDING_TONE_TEXT_CLASS[severity.tone])}>
            {t('securityAgent.findingDetails.severityLabel', { severity: severityLabel })}
          </Text>
          <Text className={cn('text-xs font-medium', FINDING_TONE_TEXT_CLASS[status.tone])}>
            {statusLabel}
          </Text>
          {deadlineBadgeCopy ? (
            <FindingStatusBadge
              icon={deadline.icon}
              label={deadlineBadgeCopy.label}
              tone={deadline.tone}
            />
          ) : null}
        </View>
        {description ? (
          <Text variant="muted" className="text-sm" selectable>
            {description}
          </Text>
        ) : null}
      </View>

      <DismissalOrSupersessionNote
        finding={finding}
        scope={scope}
        supersedingFindingId={supersedingFindingId}
      />

      <View className="rounded-lg bg-secondary px-3">
        <KvRow
          label={t('securityAgent.findingDetails.package')}
          value={`${finding.package_name} (${finding.package_ecosystem})`}
        />
        <KvRow
          label={t('securityAgent.findingDetails.vulnerableVersions')}
          value={firstNonEmpty(finding.vulnerable_version_range, t('common.unknown'))}
          valueDirection="ltr"
          selectable
        />
        <KvRow
          label={t('securityAgent.findingDetails.patchedVersion')}
          value={firstNonEmpty(
            finding.patched_version,
            t('securityAgent.findingDetails.noPatchAvailable')
          )}
          valueDirection="ltr"
          selectable
        />
        {finding.cve_id ? (
          <KvRow
            label={t('securityAgent.findingDetails.cve')}
            value={finding.cve_id}
            valueDirection="ltr"
            selectable
          />
        ) : null}
        {finding.ghsa_id ? (
          <KvRow
            label={t('securityAgent.findingDetails.ghsa')}
            value={finding.ghsa_id}
            valueDirection="ltr"
            selectable
          />
        ) : null}
        <KvRow
          label={t('common.repository')}
          value={finding.repo_full_name}
          last={!finding.manifest_path}
          selectable
        />
        {finding.manifest_path ? (
          <KvRow
            label={t('securityAgent.findingDetails.manifest')}
            value={finding.manifest_path}
            last
            selectable
          />
        ) : null}
      </View>

      <View className="rounded-lg bg-secondary px-3">
        {dateRows.map((row, index) => (
          <KvRow
            key={row.key}
            label={row.label}
            value={row.value}
            valueTone={row.tone}
            last={index === dateRows.length - 1}
          />
        ))}
      </View>

      <CollapsibleSection title={t('securityAgent.findingDetails.sourceRecord')}>
        <KvRow
          label={t('securityAgent.findingDetails.source')}
          value={getFindingSourceLabel(finding.source)}
        />
        <KvRow
          label={t('securityAgent.findingDetails.sourceId')}
          value={finding.source_id}
          last
          selectable
        />
      </CollapsibleSection>

      {advisoryUrl ? (
        <Pressable
          className="flex-row items-center justify-center gap-2 rounded-lg bg-secondary p-3 active:opacity-70"
          onPress={() => {
            openFindingLink(router, advisoryUrl, t('securityAgent.findingDetails.viewAdvisory'));
          }}
          accessibilityRole="link"
        >
          <ExternalLink size={14} color={colors.mutedForeground} />
          <Text className="text-sm font-medium">
            {t('securityAgent.findingDetails.viewAdvisory')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
