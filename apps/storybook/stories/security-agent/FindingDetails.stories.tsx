'use client';

import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCode2,
  GitMerge,
  GitPullRequest,
  Package,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  FindingActionSection,
  FindingContextNote,
  FindingDialogShell,
  FindingOutcome,
  FindingPreview,
  lodashFindingIdentity,
  toneStyles,
  type FindingHeaderData,
  type Tone,
} from './FindingStoryShell';

const meta: Meta = {
  title: 'Security Agent/Finding Details',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Security Finding detail variations grounded in current finding metadata, source status, resolution deadlines, and dismissal behavior.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type DetailFact = {
  label: string;
  value: string;
  mono?: boolean;
};

type DetailAction = {
  title: string;
  description: string;
  label: string;
  icon: LucideIcon;
  primary?: boolean;
  secondaryLabel?: string;
};

type DetailConfig = {
  previewTitle: string;
  previewDescription: string;
  header: FindingHeaderData;
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
  };
  timeline: {
    label: string;
    date: string;
    icon: LucideIcon;
    tone: Tone;
  } | null;
  packageSummary: string;
  facts: DetailFact[];
  description: string;
  contextNote: string;
  action: DetailAction;
  sourceFacts: DetailFact[];
  sourceNote: string;
};

const openFinding: DetailConfig = {
  previewTitle: 'Open finding',
  previewDescription:
    'An active Security Finding with complete advisory metadata, an upcoming resolution deadline, and a confirmed reachable risk.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'This finding is open',
    description:
      'The vulnerable package remains in the repository. Security Agent found that application code can reach the affected feature.',
    icon: ShieldAlert,
    tone: 'destructive',
  },
  timeline: {
    label: 'Resolution deadline in 2 days',
    date: 'Jun 18, 2026 at 14:00 UTC',
    icon: Clock3,
    tone: 'warning',
  },
  packageSummary: 'lodash 4.17.19 (npm)',
  facts: [
    { label: 'CVE', value: 'CVE-2021-23337', mono: true },
    { label: 'GHSA', value: 'GHSA-35jh-r3h4-6jhm', mono: true },
    { label: 'Vulnerable versions', value: '< 4.17.21', mono: true },
    { label: 'Patched version', value: '4.17.21', mono: true },
    { label: 'Manifest', value: 'package.json', mono: true },
  ],
  description:
    'Lodash versions before 4.17.21 can allow command injection when untrusted input reaches template compilation. The affected package is a direct dependency in this repository.',
  contextNote:
    'This finding closes only after GitHub reports the vulnerability fixed or someone dismisses it.',
  action: {
    title: 'Review remediation options',
    description:
      'Security Agent has a concrete patch path and can prepare a pull request for review.',
    label: 'View remediation',
    icon: GitPullRequest,
    primary: true,
    secondaryLabel: 'View on GitHub',
  },
  sourceFacts: [
    { label: 'Source', value: 'GitHub Dependabot' },
    { label: 'First detected', value: 'Mar 4, 2026 at 09:12 UTC', mono: true },
    { label: 'Last synced', value: 'Jun 15, 2026 at 14:21 UTC', mono: true },
    { label: 'Source alert state', value: 'Open' },
  ],
  sourceNote:
    'Security Agent will keep this finding open until GitHub reports it fixed or it is dismissed.',
};

const overdueFinding: DetailConfig = {
  previewTitle: 'Open and overdue',
  previewDescription:
    'A critical open finding past its resolution deadline, with no published patch and no repository analysis yet.',
  header: {
    title: 'Memory Corruption in legacy-parser',
    repository: 'Kilo-Org/security-agent-testbed',
    detectedAt: 'Jun 2, 2026',
    activityLabel: 'Updated Jun 15, 2026',
    severity: { value: 'Critical', tone: 'destructive' },
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Not analyzed', tone: 'neutral' },
  },
  hero: {
    title: 'Resolution deadline has passed',
    description:
      'This critical finding is still open. Repository risk is unknown until analysis checks whether application code can reach the vulnerable feature.',
    icon: Clock3,
    tone: 'destructive',
  },
  timeline: {
    label: 'Resolution deadline passed 3 days ago',
    date: 'Jun 13, 2026 at 14:00 UTC',
    icon: Clock3,
    tone: 'destructive',
  },
  packageSummary: 'legacy-parser 2.6.4 (npm)',
  facts: [
    { label: 'CVE', value: 'CVE-2026-10418', mono: true },
    { label: 'Vulnerable versions', value: '<= 2.6.4', mono: true },
    { label: 'Patched version', value: 'No patch available' },
    { label: 'Manifest', value: 'services/importer/package.json', mono: true },
  ],
  description:
    'A memory-safety issue affects parser input handling. The source advisory does not yet identify a patched release.',
  contextNote:
    'Critical severity comes from the published advisory. It does not prove this repository is exploitable.',
  action: {
    title: 'Determine project risk',
    description:
      'Analyze the repository to check whether application code can reach the affected parser path.',
    label: 'Analyze repository',
    icon: Brain,
    primary: true,
    secondaryLabel: 'View on GitHub',
  },
  sourceFacts: [
    { label: 'Source', value: 'GitHub Dependabot' },
    { label: 'First detected', value: 'Jun 2, 2026 at 08:40 UTC', mono: true },
    { label: 'Last synced', value: 'Jun 15, 2026 at 14:21 UTC', mono: true },
    { label: 'Source alert state', value: 'Open' },
  ],
  sourceNote:
    'No patch is published. Analysis can still identify exposure and a concrete repository-specific mitigation.',
};

const fixedFinding: DetailConfig = {
  previewTitle: 'Fixed finding',
  previewDescription:
    'A source-confirmed fixed Security Finding. The prior analysis result remains visible as historical context.',
  header: {
    title: 'Prototype Pollution in minimist',
    repository: 'Kilo-Org/security-agent-testbed',
    detectedAt: 'Feb 11, 2026',
    activityLabel: 'Updated Jun 14, 2026',
    severity: { value: 'Low', tone: 'neutral' },
    finding: { value: 'Fixed', tone: 'success' },
    analysis: { value: 'No reachable path', tone: 'success' },
  },
  hero: {
    title: 'The source reports this finding fixed',
    description:
      'GitHub no longer reports the vulnerable package version in this repository. No further Security Agent action is required.',
    icon: ShieldCheck,
    tone: 'success',
  },
  timeline: {
    label: 'Fixed 2 days ago',
    date: 'Jun 14, 2026 at 16:38 UTC',
    icon: CheckCircle2,
    tone: 'success',
  },
  packageSummary: 'minimist 1.2.5 (npm)',
  facts: [
    { label: 'CVE', value: 'CVE-2021-44906', mono: true },
    { label: 'GHSA', value: 'GHSA-xvch-5gv4-984h', mono: true },
    { label: 'Vulnerable versions', value: '< 1.2.6', mono: true },
    { label: 'Patched version', value: '1.2.6', mono: true },
    { label: 'Manifest', value: 'package.json', mono: true },
  ],
  description:
    'Prototype pollution affected earlier versions of minimist. Repository synchronization confirmed that the vulnerable version is no longer present.',
  contextNote:
    'Fixed is a source status. A pull request opened by Security Agent would not have changed the finding to fixed by itself.',
  action: {
    title: 'No action required',
    description: 'Keep the record for audit history or review the original source advisory.',
    label: 'View source record',
    icon: ExternalLink,
  },
  sourceFacts: [
    { label: 'Source', value: 'GitHub Dependabot' },
    { label: 'First detected', value: 'Feb 11, 2026 at 11:07 UTC', mono: true },
    { label: 'Fixed', value: 'Jun 14, 2026 at 16:38 UTC', mono: true },
    { label: 'Source alert state', value: 'Fixed' },
  ],
  sourceNote:
    'The finding remains available as a historical record after its source status changes.',
};

const dismissedFinding: DetailConfig = {
  previewTitle: 'Dismissed finding',
  previewDescription:
    'A manually dismissed Security Finding with the recorded reason separated from package and analysis status.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Dismissed', tone: 'neutral' },
    analysis: { value: 'No reachable path', tone: 'success' },
  },
  hero: {
    title: 'Dismissed after review',
    description:
      'This finding was dismissed because the affected code is not used. The vulnerable dependency has not been presented as fixed.',
    icon: XCircle,
    tone: 'neutral',
  },
  timeline: {
    label: 'Dismissed: vulnerable code is not used',
    date: 'Jun 15, 2026 at 14:46 UTC',
    icon: XCircle,
    tone: 'neutral',
  },
  packageSummary: 'lodash 4.17.19 (npm)',
  facts: [
    { label: 'CVE', value: 'CVE-2021-23337', mono: true },
    { label: 'GHSA', value: 'GHSA-35jh-r3h4-6jhm', mono: true },
    { label: 'Vulnerable versions', value: '< 4.17.21', mono: true },
    { label: 'Patched version', value: '4.17.21', mono: true },
    { label: 'Manifest', value: 'package.json', mono: true },
  ],
  description:
    'Lodash versions before 4.17.21 can allow command injection when untrusted input reaches template compilation.',
  contextNote:
    'Dismissed records a disposition, not a package update. Future source changes can cause Security Agent to reassess the finding.',
  action: {
    title: 'No immediate response needed',
    description: 'Review the source record if repository usage or dismissal context changes.',
    label: 'View source record',
    icon: ExternalLink,
  },
  sourceFacts: [
    { label: 'Dismissal reason', value: 'Vulnerable code is not used' },
    { label: 'Source', value: 'GitHub Dependabot' },
    { label: 'First detected', value: 'Mar 4, 2026 at 09:12 UTC', mono: true },
    { label: 'Source alert state', value: 'Dismissed' },
  ],
  sourceNote:
    'Security Agent analysis found no reachable use of the affected feature at the time of dismissal.',
};

const supersededFinding: DetailConfig = {
  previewTitle: 'Superseded finding',
  previewDescription:
    'A duplicate record replaced by the current Security Finding, shown as a relationship rather than a user dismissal.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 12, 2026',
    finding: { value: 'Superseded', tone: 'neutral' },
    analysis: { value: 'Not available', tone: 'neutral' },
  },
  hero: {
    title: 'Replaced by a current finding',
    description:
      'Security Agent linked this duplicate to the current finding. Use that record for status, analysis, and remediation.',
    icon: GitMerge,
    tone: 'neutral',
  },
  timeline: {
    label: 'Superseded during synchronization',
    date: 'Jun 12, 2026 at 10:18 UTC',
    icon: GitMerge,
    tone: 'neutral',
  },
  packageSummary: 'lodash 4.17.19 (npm)',
  facts: [
    { label: 'CVE', value: 'CVE-2021-23337', mono: true },
    { label: 'GHSA', value: 'GHSA-35jh-r3h4-6jhm', mono: true },
    { label: 'Vulnerable versions', value: '< 4.17.21', mono: true },
    { label: 'Manifest', value: 'package.json', mono: true },
  ],
  description:
    'This record refers to the same repository vulnerability as the current Security Finding.',
  contextNote:
    'Superseded findings remain separate historical records. Analysis and remediation details stay with the current finding.',
  action: {
    title: 'Continue with the current record',
    description:
      'Open the current finding to review its latest status and Security Agent activity.',
    label: 'Open current finding',
    icon: ArrowRight,
    primary: true,
  },
  sourceFacts: [
    { label: 'Current finding', value: 'sf_01JXR4P1Q4HBEK9D7S6T3A8N2M', mono: true },
    { label: 'Source', value: 'GitHub Dependabot' },
    { label: 'First detected', value: 'Mar 4, 2026 at 09:12 UTC', mono: true },
    { label: 'Recorded state', value: 'Superseded' },
  ],
  sourceNote:
    'This record is preserved for traceability and is not presented as a manual dismissal.',
};

function DetailMockup({ config }: { config: DetailConfig }) {
  const TimelineIcon = config.timeline?.icon;
  const ActionIcon = config.action.icon;

  return (
    <FindingDialogShell header={config.header} selectedTab="Details">
      <div className="space-y-6">
        <FindingOutcome {...config.hero} />

        {config.timeline && TimelineIcon && (
          <section
            className={`flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${toneStyles[config.timeline.tone].border}`}
          >
            <div
              className={`type-body flex items-center gap-2 font-medium ${toneStyles[config.timeline.tone].text}`}
            >
              <TimelineIcon className="size-4 shrink-0" aria-hidden="true" />
              {config.timeline.label}
            </div>
            <span className="text-muted-foreground type-code tabular-nums">
              {config.timeline.date}
            </span>
          </section>
        )}

        <FindingActionSection
          label="Next step"
          title={config.action.title}
          description={config.action.description}
        >
          <Button
            variant={config.action.primary ? 'default' : 'outline'}
            className="h-control-touch type-label"
          >
            <ActionIcon aria-hidden="true" />
            {config.action.label}
          </Button>
          {config.action.secondaryLabel && (
            <Button variant="ghost" className="h-control-touch type-label">
              <ExternalLink aria-hidden="true" />
              {config.action.secondaryLabel}
            </Button>
          )}
        </FindingActionSection>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Package className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <h4 className="type-body min-w-0 break-words font-medium">{config.packageSummary}</h4>
            </div>
            <span className="text-muted-foreground type-label">Package advisory</span>
          </div>
          <dl className="border-border bg-border gap-hairline grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
            {config.facts.map(fact => (
              <DetailFactCell key={fact.label} fact={fact} />
            ))}
          </dl>
        </section>

        <section className="max-w-[70ch] space-y-3">
          <div>
            <h4 className="type-body font-medium">About this vulnerability</h4>
            <p className="text-muted-foreground type-body mt-2">{config.description}</p>
          </div>
          <FindingContextNote>{config.contextNote}</FindingContextNote>
        </section>

        <Accordion type="single" collapsible>
          <AccordionItem value="source" className="border-border border-t">
            <AccordionTrigger className="min-h-control-touch type-body py-3 no-underline hover:no-underline">
              Source record and timestamps
            </AccordionTrigger>
            <AccordionContent className="pb-5">
              <div className="space-y-4">
                <dl className="type-body grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                  {config.sourceFacts.map(fact => (
                    <DetailFactItem key={fact.label} fact={fact} />
                  ))}
                </dl>
                <div className="text-muted-foreground type-label flex max-w-[68ch] items-start gap-2">
                  <FileCode2 className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
                  <p>{config.sourceNote}</p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </FindingDialogShell>
  );
}

function DetailFactCell({ fact }: { fact: DetailFact }) {
  return (
    <div className="bg-surface-raised min-w-0 p-4">
      <dt className="text-muted-foreground type-label">{fact.label}</dt>
      <dd className={`type-body mt-1 break-words ${fact.mono ? 'type-code' : 'font-medium'}`}>
        {fact.value}
      </dd>
    </div>
  );
}

function DetailFactItem({ fact }: { fact: DetailFact }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground type-label">{fact.label}</dt>
      <dd className={`type-body mt-1 break-words ${fact.mono ? 'type-code' : 'font-medium'}`}>
        {fact.value}
      </dd>
    </div>
  );
}

function DetailStory({ config }: { config: DetailConfig }) {
  return (
    <FindingPreview
      eyebrow="Security Agent finding details"
      title={config.previewTitle}
      description={config.previewDescription}
    >
      <DetailMockup config={config} />
    </FindingPreview>
  );
}

export const Open: Story = {
  render: () => <DetailStory config={openFinding} />,
};

export const Overdue: Story = {
  name: 'Open and overdue',
  render: () => <DetailStory config={overdueFinding} />,
};

export const Fixed: Story = {
  render: () => <DetailStory config={fixedFinding} />,
};

export const Dismissed: Story = {
  render: () => <DetailStory config={dismissedFinding} />,
};

export const Superseded: Story = {
  render: () => <DetailStory config={supersededFinding} />,
};
