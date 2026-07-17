import {
  getDismissalReasonLabel,
  getFindingLifecycleStatusPresentation,
  getFindingSeverityPresentation,
  getFindingSourceLabel,
  getSecurityDeadlinePresentation,
  getSupersedingFindingId,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ExternalLink, GitMerge } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

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
          <Text className="text-sm font-medium">Superseded by a current finding</Text>
        </View>
        <Text variant="muted" className="text-xs">
          Tap to open the current record for status, analysis, and remediation.
        </Text>
      </Pressable>
    );
  }

  if (finding.status !== 'ignored') {
    return null;
  }

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <Text className="text-sm font-medium">Dismissed</Text>
      <Text variant="muted" className="text-xs" selectable>
        Dismissed because {getDismissalReasonLabel(finding.ignored_reason)}.
      </Text>
    </View>
  );
}

// Ported from FindingDetailDialog.tsx:552 (getFindingDetailsPresentation) —
// source, package, repository, severity/status, timestamps, and
// dismissal/supersession context as plain facts rather than the web's
// hero + next-step action card (Task 7 owns actions).
export function FindingDetailsPanel({ finding, scope }: Readonly<FindingDetailsPanelProps>) {
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
            {severity.label} severity
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
        <KvRow label="Package" value={`${finding.package_name} (${finding.package_ecosystem})`} />
        <KvRow
          label="Vulnerable versions"
          value={firstNonEmpty(finding.vulnerable_version_range, 'Unknown')}
          selectable
        />
        <KvRow
          label="Patched version"
          value={firstNonEmpty(finding.patched_version, 'No patch available')}
          selectable
        />
        {finding.cve_id ? <KvRow label="CVE" value={finding.cve_id} selectable /> : null}
        {finding.ghsa_id ? <KvRow label="GHSA" value={finding.ghsa_id} selectable /> : null}
        <KvRow
          label="Repository"
          value={finding.repo_full_name}
          last={!finding.manifest_path}
          selectable
        />
        {finding.manifest_path ? (
          <KvRow label="Manifest" value={finding.manifest_path} last selectable />
        ) : null}
      </View>

      <View className="rounded-lg bg-secondary px-3">
        <KvRow label="Detected" value={timeAgo(parseTimestamp(finding.first_detected_at))} />
        <KvRow
          label="Updated"
          value={timeAgo(parseTimestamp(finding.updated_at))}
          last={!finding.fixed_at && !finding.sla_due_at}
        />
        {finding.fixed_at ? (
          <KvRow
            label="Fixed"
            value={timeAgo(parseTimestamp(finding.fixed_at))}
            last={!finding.sla_due_at}
          />
        ) : null}
        {finding.sla_due_at ? (
          <KvRow
            label="SLA deadline"
            value={deadline.detail}
            valueTone={FINDING_TONE_TO_KV_ROW_TONE[deadline.tone]}
            last
          />
        ) : null}
      </View>

      <CollapsibleSection title="Source record">
        <KvRow label="Source" value={getFindingSourceLabel(finding.source)} />
        <KvRow label="Source ID" value={finding.source_id} last selectable />
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
          <Text className="text-sm font-medium">View advisory on GitHub</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
