import {
  getDismissalReasonLabel,
  getFindingLifecycleStatusPresentation,
  getFindingSeverityPresentation,
  getFindingSourceLabel,
  getSecurityDeadlinePresentation,
  getSupersedingFindingId,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink, GitMerge } from '@/components/ui/icons';
import { Linking, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  FINDING_TONE_TEXT_CLASS,
  FINDING_TONE_TO_KV_ROW_TONE,
} from '@/components/security-agent/finding-tone';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import { FindingStatusBadge } from '@/components/security-agent/finding-status-badge';
import { KvRow } from '@/components/ui/kv-row';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getSecurityAgentPath, type SecurityFinding } from '@/lib/security-agent';
import { cn, firstNonEmpty, parseTimestamp, timeAgo } from '@/lib/utils';

type FindingDetailsPanelProps = {
  finding: SecurityFinding;
  scope: string;
};

function DismissalOrSupersessionNote({
  finding,
  scope,
  supersedingFindingId,
}: Readonly<{ finding: SecurityFinding; scope: string; supersedingFindingId: string | null }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();

  if (supersedingFindingId) {
    return (
      <Pressable
        className="gap-1 rounded-lg bg-secondary p-3 active:opacity-70"
        onPress={() => {
          router.push(getSecurityAgentPath(scope, `findings/${supersedingFindingId}`));
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
      <Text className="text-sm font-medium">{t('securityAgent.findingDetails.dismissed')}</Text>
      <Text variant="muted" className="text-xs" selectable>
        {t('securityAgent.findingDetails.dismissedBecause', {
          reason: getDismissalReasonLabel(finding.ignored_reason),
        })}
      </Text>
    </View>
  );
}

// Ported from FindingDetailDialog.tsx:552 (getFindingDetailsPresentation) —
// source, package, repository, severity/status, timestamps, and
// dismissal/supersession context as plain facts rather than the web's
// hero + next-step action card (Task 7 owns actions).
export function FindingDetailsPanel({ finding, scope }: Readonly<FindingDetailsPanelProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const severity = getFindingSeverityPresentation(finding.severity);
  const status = getFindingLifecycleStatusPresentation(finding);
  const deadline = getSecurityDeadlinePresentation(finding);
  const supersedingFindingId = getSupersedingFindingId(finding);
  const advisoryUrl = finding.dependabot_html_url;

  return (
    <View className="gap-4">
      <View className="gap-2 rounded-lg bg-secondary p-3">
        <Text className="text-base font-medium" selectable>
          {finding.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-3">
          <Text className={cn('text-xs font-medium', FINDING_TONE_TEXT_CLASS[severity.tone])}>
            {t('securityAgent.findingDetails.severityLabel', { severity: severity.label })}
          </Text>
          <Text className={cn('text-xs font-medium', FINDING_TONE_TEXT_CLASS[status.tone])}>
            {status.label}
          </Text>
          <FindingStatusBadge icon={deadline.icon} label={deadline.label} tone={deadline.tone} />
        </View>
        {finding.description ? (
          <Text variant="muted" className="text-sm" selectable>
            {finding.description}
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
          value={firstNonEmpty(
            finding.vulnerable_version_range,
            t('securityAgent.findingDetails.unknown')
          )}
          selectable
        />
        <KvRow
          label={t('securityAgent.findingDetails.patchedVersion')}
          value={firstNonEmpty(
            finding.patched_version,
            t('securityAgent.findingDetails.noPatchAvailable')
          )}
          selectable
        />
        {finding.cve_id ? (
          <KvRow label={t('securityAgent.findingDetails.cve')} value={finding.cve_id} selectable />
        ) : null}
        {finding.ghsa_id ? (
          <KvRow
            label={t('securityAgent.findingDetails.ghsa')}
            value={finding.ghsa_id}
            selectable
          />
        ) : null}
        <KvRow
          label={t('securityAgent.findingDetails.repository')}
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
        <KvRow
          label={t('securityAgent.findingDetails.detected')}
          value={timeAgo(parseTimestamp(finding.first_detected_at))}
        />
        <KvRow
          label={t('securityAgent.findingDetails.updated')}
          value={timeAgo(parseTimestamp(finding.updated_at))}
          last={!finding.fixed_at && !finding.sla_due_at}
        />
        {finding.fixed_at ? (
          <KvRow
            label={t('securityAgent.findingDetails.fixed')}
            value={timeAgo(parseTimestamp(finding.fixed_at))}
            last={!finding.sla_due_at}
          />
        ) : null}
        {finding.sla_due_at ? (
          <KvRow
            label={t('securityAgent.findingDetails.slaDeadline')}
            value={deadline.detail}
            valueTone={FINDING_TONE_TO_KV_ROW_TONE[deadline.tone]}
            last
          />
        ) : null}
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
            void Linking.openURL(advisoryUrl);
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
