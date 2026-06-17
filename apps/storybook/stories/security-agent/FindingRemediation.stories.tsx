'use client';

import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Ban,
  Brain,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCheck2,
  GitBranch,
  GitPullRequest,
  Info,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  UserRound,
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
  title: 'Security Agent/Finding Remediation',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Security Remediation lifecycle variations grounded in current capability, attempt, cancellation, and pull request outcomes.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type SummaryItem = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: Tone;
};

type RemediationStep = {
  title: string;
  detail: string;
  state: 'done' | 'running' | 'waiting' | 'attention' | 'pending' | 'error';
};

type RemediationActionBase = {
  sectionLabel: 'Next step' | 'Attempt controls' | 'Current status';
  title: string;
  description: string;
};

type RemediationAction = RemediationActionBase &
  (
    | {
        label: string;
        icon: LucideIcon;
        primary?: boolean;
        secondaryLabel?: string;
      }
    | {
        label?: never;
        icon?: never;
        primary?: never;
        secondaryLabel?: never;
      }
  );

type AttemptFact = {
  label: string;
  value: string;
  mono?: boolean;
};

type RemediationAttemptStatus =
  | 'Queued'
  | 'Starting'
  | 'Running'
  | 'Cancellation requested'
  | 'PR opened'
  | 'Blocked'
  | 'Failed'
  | 'No changes needed'
  | 'Cancelled';

type RemediationAttemptBase = {
  number: number;
  tone: Tone;
  origin: string;
  requestedBy: string;
  updatedAt: string;
  facts: AttemptFact[];
  outcome?: string;
  validation?: string;
  risk?: string;
};

type RemediationAttempt = RemediationAttemptBase &
  (
    | {
        status: Extract<RemediationAttemptStatus, 'PR opened' | 'Blocked'>;
        prLabel: string;
      }
    | {
        status: Exclude<RemediationAttemptStatus, 'PR opened' | 'Blocked'>;
        prLabel?: never;
      }
  );

type RemediationConfig = {
  previewTitle: string;
  previewDescription: string;
  header: FindingHeaderData;
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
    spinning?: boolean;
  };
  summary: SummaryItem[];
  contextNote: string;
  action: RemediationAction;
  disclosureTitle: string;
  steps: RemediationStep[];
  attempts: RemediationAttempt[];
};

const eligible: RemediationConfig = {
  previewTitle: 'Ready to remediate',
  previewDescription:
    'An open, analyzed Security Finding with a concrete fix path and no active or previous remediation work.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Ready to prepare a fix',
    description:
      'Security Agent can ask Cloud Agent to update lodash, review the affected call, and open a pull request for your team.',
    icon: GitPullRequest,
    tone: 'neutral',
  },
  summary: [
    {
      label: 'Why available?',
      value: 'Concrete fix path',
      detail: 'Analysis recommends opening a PR',
      icon: ShieldCheck,
      tone: 'success',
    },
    {
      label: 'How does it start?',
      value: 'Manual request',
      detail: 'This action is independent of Auto Remediation',
      icon: UserRound,
      tone: 'neutral',
    },
    {
      label: 'What happens next?',
      value: 'Review a pull request',
      detail: 'The finding remains open until source sync',
      icon: GitPullRequest,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Starting remediation creates a Security Remediation Attempt. It does not mark the finding fixed.',
  action: {
    sectionLabel: 'Next step',
    title: 'Prepare a fix',
    description:
      'Cloud Agent will make the smallest safe change it can identify, run focused checks, and open a pull request for review.',
    label: 'Start remediation',
    icon: Sparkles,
    primary: true,
  },
  disclosureTitle: 'Why remediation is available',
  steps: [
    {
      title: 'Finding is still open',
      detail: 'GitHub continues to report the vulnerable package in this repository.',
      state: 'done',
    },
    {
      title: 'Analysis is current',
      detail: 'The latest codebase analysis matches the current finding data.',
      state: 'done',
    },
    {
      title: 'Project risk is confirmed',
      detail: 'Analysis found a reachable vulnerable path and recommends a pull request.',
      state: 'done',
    },
    {
      title: 'No remediation is active',
      detail: 'No other attempt or known remediation pull request blocks a new start.',
      state: 'done',
    },
  ],
  attempts: [],
};

const analysisRequired: RemediationConfig = {
  previewTitle: 'Analysis required',
  previewDescription:
    'A finding with source advisory data but no completed repository analysis, so remediation is not available yet.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Required', tone: 'warning' },
  },
  hero: {
    title: 'Analyze the repository first',
    description:
      'Security Agent needs codebase-level evidence before it can determine whether opening a remediation pull request is safe.',
    icon: Brain,
    tone: 'warning',
  },
  summary: [
    {
      label: 'What is known?',
      value: 'Published vulnerability',
      detail: 'The package matches an affected version range',
      icon: ShieldAlert,
      tone: 'warning',
    },
    {
      label: 'What is missing?',
      value: 'Repository analysis',
      detail: 'Project-specific reachability is unknown',
      icon: Brain,
      tone: 'warning',
    },
    {
      label: 'What should I do?',
      value: 'Analyze repository',
      detail: 'Security Agent will check usage and fix options',
      icon: Sparkles,
      tone: 'neutral',
    },
  ],
  contextNote:
    'The initial advisory check is not enough to start remediation. Current repository analysis is required.',
  action: {
    sectionLabel: 'Next step',
    title: 'Check repository risk and fix options',
    description:
      'Analyze the repository to check whether application code can reach the vulnerable feature and identify a safe fix.',
    label: 'Analyze repository',
    icon: Brain,
    primary: true,
  },
  disclosureTitle: 'What blocks remediation',
  steps: [
    {
      title: 'Source advisory is available',
      detail: 'GitHub reports that lodash 4.17.19 is affected.',
      state: 'done',
    },
    {
      title: 'Repository analysis has not run',
      detail: 'No current repository-specific risk result exists.',
      state: 'attention',
    },
    {
      title: 'Remediation decision is pending',
      detail: 'Security Agent cannot recommend a pull request until analysis completes.',
      state: 'pending',
    },
  ],
  attempts: [],
};

const queued: RemediationConfig = {
  previewTitle: 'Queued',
  previewDescription:
    'A persisted Security Remediation Attempt waiting for Cloud Agent capacity. Duplicate starts are suppressed.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Remediation is queued',
    description:
      'Security Agent accepted the request. Cloud Agent will begin when execution capacity is available.',
    icon: Loader2,
    tone: 'warning',
    spinning: true,
  },
  summary: [
    {
      label: 'Current state',
      value: 'Waiting for capacity',
      detail: 'No repository changes have started',
      icon: Clock3,
      tone: 'warning',
    },
    {
      label: 'Attempt started by',
      value: 'Jordan Park',
      detail: 'Manual remediation',
      icon: UserRound,
      tone: 'neutral',
    },
    {
      label: 'Next update',
      value: 'Cloud Agent starts',
      detail: 'Status refreshes automatically',
      icon: Sparkles,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Only one active remediation attempt can exist for this finding. Starting another is unavailable while this attempt is queued.',
  action: {
    sectionLabel: 'Attempt controls',
    title: 'Manage this attempt',
    description:
      'You can cancel before Cloud Agent starts if this remediation is no longer needed.',
    label: 'Cancel remediation',
    icon: XCircle,
  },
  disclosureTitle: 'Remediation progress',
  steps: [
    {
      title: 'Request accepted',
      detail: 'Security Agent created attempt #1 and reserved the remediation branch.',
      state: 'done',
    },
    {
      title: 'Waiting for Cloud Agent',
      detail: 'The attempt will start when execution capacity is available.',
      state: 'waiting',
    },
    {
      title: 'Prepare repository change',
      detail: 'Cloud Agent has not started repository work.',
      state: 'pending',
    },
    {
      title: 'Open pull request',
      detail: 'No pull request exists yet.',
      state: 'pending',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Queued',
      tone: 'warning',
      origin: 'Manual',
      requestedBy: 'Jordan Park',
      updatedAt: 'Jun 16, 2026 at 12:04 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Waiting for Cloud Agent capacity.',
    },
  ],
};

const starting: RemediationConfig = {
  previewTitle: 'Starting Cloud Agent',
  previewDescription:
    'The attempt has been claimed and is launching a Cloud Agent session, a persisted active state between queued and running.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Cloud Agent is starting',
    description:
      'Security Agent claimed the queued attempt and is opening the isolated session that will prepare the repository change.',
    icon: Loader2,
    tone: 'warning',
    spinning: true,
  },
  summary: [
    {
      label: 'Current state',
      value: 'Launching session',
      detail: 'Repository work has not been confirmed yet',
      icon: Sparkles,
      tone: 'warning',
    },
    {
      label: 'Attempt started by',
      value: 'Jordan Park',
      detail: 'Manual remediation',
      icon: UserRound,
      tone: 'neutral',
    },
    {
      label: 'Next update',
      value: 'Repository work begins',
      detail: 'Status refreshes automatically',
      icon: GitBranch,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Launching is an active Security Remediation Attempt. A launch failure can return the attempt to queued or end it as failed.',
  action: {
    sectionLabel: 'Attempt controls',
    title: 'Manage this attempt',
    description: 'You can request cancellation while Security Agent finishes starting the session.',
    label: 'Cancel remediation',
    icon: XCircle,
  },
  disclosureTitle: 'Remediation progress',
  steps: [
    {
      title: 'Request accepted',
      detail: 'Security Agent created attempt #1.',
      state: 'done',
    },
    {
      title: 'Cloud Agent session starting',
      detail: 'The attempt is creating an isolated execution session.',
      state: 'running',
    },
    {
      title: 'Prepare repository change',
      detail: 'Repository work has not started yet.',
      state: 'pending',
    },
    {
      title: 'Open pull request',
      detail: 'No pull request exists yet.',
      state: 'pending',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Starting',
      tone: 'warning',
      origin: 'Manual',
      requestedBy: 'Jordan Park',
      updatedAt: 'Jun 16, 2026 at 12:05 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Creating the Cloud Agent session.',
    },
  ],
};

const running: RemediationConfig = {
  previewTitle: 'In progress',
  previewDescription:
    'Cloud Agent is working on the repository. The finding remains open and a second attempt cannot start.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Cloud Agent is preparing a fix',
    description:
      'The agent is updating the dependency, reviewing the affected call, and running focused validation before deciding whether to open a pull request.',
    icon: Loader2,
    tone: 'warning',
    spinning: true,
  },
  summary: [
    {
      label: 'Current state',
      value: 'Repository work',
      detail: 'Changes and validation are in progress',
      icon: PackageCheck,
      tone: 'warning',
    },
    {
      label: 'Attempt started by',
      value: 'Auto Remediation',
      detail: 'Automatic policy',
      icon: Sparkles,
      tone: 'neutral',
    },
    {
      label: 'Expected outcome',
      value: 'Pull request or explanation',
      detail: 'No-change and failure outcomes stay explicit',
      icon: GitPullRequest,
      tone: 'neutral',
    },
  ],
  contextNote:
    'A running remediation does not change finding status. The source record remains open until GitHub reports it fixed or it is dismissed.',
  action: {
    sectionLabel: 'Attempt controls',
    title: 'Manage this attempt',
    description:
      'Status updates automatically. Cancellation asks Cloud Agent to stop but cannot guarantee it stops before opening a pull request.',
    label: 'Cancel remediation',
    icon: Square,
  },
  disclosureTitle: 'Remediation progress',
  steps: [
    {
      title: 'Request accepted',
      detail: 'Automatic policy created attempt #1 after analysis completed.',
      state: 'done',
    },
    {
      title: 'Cloud Agent started',
      detail: 'The isolated session and remediation branch are ready.',
      state: 'done',
    },
    {
      title: 'Prepare and validate change',
      detail: 'Cloud Agent is updating lodash and checking the affected template path.',
      state: 'running',
    },
    {
      title: 'Open pull request',
      detail: 'No verified pull request exists yet.',
      state: 'pending',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Running',
      tone: 'warning',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 12:09 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Updating the dependency and reviewing the affected call site.',
    },
  ],
};

const cancellationRequested: RemediationConfig = {
  previewTitle: 'Cancellation requested',
  previewDescription:
    'A running attempt after Security Agent accepted a cancellation request but before Cloud Agent confirms a final result.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Cancellation has been requested',
    description:
      'Security Agent asked Cloud Agent to stop. The attempt remains active until Cloud Agent confirms cancellation or returns another final result.',
    icon: Loader2,
    tone: 'warning',
    spinning: true,
  },
  summary: [
    {
      label: 'Current state',
      value: 'Waiting for confirmation',
      detail: 'The attempt is not cancelled yet',
      icon: Clock3,
      tone: 'warning',
    },
    {
      label: 'Cancellation requested by',
      value: 'Jordan Park',
      detail: 'Jun 16 at 12:11 UTC',
      icon: UserRound,
      tone: 'neutral',
    },
    {
      label: 'Possible outcome',
      value: 'Cancelled or PR opened',
      detail: 'A pull request can still win the race',
      icon: GitPullRequest,
      tone: 'warning',
    },
  ],
  contextNote:
    'Cancellation is best effort. If Cloud Agent opens a verified pull request before stopping, Security Agent will show that result.',
  action: {
    sectionLabel: 'Current status',
    title: 'Waiting for Cloud Agent',
    description:
      'No further action is available until Cloud Agent confirms cancellation or returns a pull request.',
  },
  disclosureTitle: 'Cancellation progress',
  steps: [
    {
      title: 'Remediation started',
      detail: 'Cloud Agent began repository work.',
      state: 'done',
    },
    {
      title: 'Cancellation requested',
      detail: "Security Agent accepted Jordan Park's request and asked Cloud Agent to interrupt.",
      state: 'done',
    },
    {
      title: 'Waiting for Cloud Agent',
      detail: 'Cloud Agent has not confirmed interruption or returned a pull request.',
      state: 'waiting',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Cancellation requested',
      tone: 'warning',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 12:11 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Waiting for Cloud Agent to confirm interruption.',
      risk: 'Cloud Agent may still finish and open a pull request before cancellation takes effect.',
    },
  ],
};

const prOpened: RemediationConfig = {
  previewTitle: 'Pull request opened',
  previewDescription:
    'A successful remediation outcome with a verified pull request. The finding remains open until GitHub reports the vulnerability fixed.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Remediation pull request is ready',
    description:
      'Cloud Agent updated lodash, reviewed the affected template call, and opened pull request #482 for team review.',
    icon: GitPullRequest,
    tone: 'success',
  },
  summary: [
    {
      label: 'Outcome',
      value: 'PR #482 opened',
      detail: 'Expected repository and remediation branch verified',
      icon: GitPullRequest,
      tone: 'success',
    },
    {
      label: 'Validation',
      value: 'Targeted checks passed',
      detail: 'Dependency tests and typecheck completed',
      icon: FileCheck2,
      tone: 'success',
    },
    {
      label: 'Finding state',
      value: 'Still open',
      detail: 'GitHub confirms when the vulnerability is fixed',
      icon: ShieldAlert,
      tone: 'warning',
    },
  ],
  contextNote:
    'A pull request is not the same as a fixed finding. The finding stays open until GitHub reports the vulnerability resolved.',
  action: {
    sectionLabel: 'Next step',
    title: 'Review the pull request',
    description:
      'Review the dependency update and template handling changes before merging into the default branch.',
    label: 'View pull request',
    icon: ExternalLink,
    primary: true,
  },
  disclosureTitle: 'How remediation completed',
  steps: [
    {
      title: 'Prepared the smallest safe change',
      detail:
        'Updated lodash and replaced untrusted template compilation with a constrained renderer.',
      state: 'done',
    },
    {
      title: 'Ran targeted validation',
      detail: 'Dependency tests and TypeScript checks passed.',
      state: 'done',
    },
    {
      title: 'Verified pull request identity',
      detail: 'Pull request #482 belongs to the expected repository and remediation branch.',
      state: 'done',
    },
  ],
  attempts: [
    {
      number: 2,
      status: 'PR opened',
      tone: 'success',
      origin: 'Manual retry',
      requestedBy: 'Jordan Park',
      updatedAt: 'Jun 16, 2026 at 12:26 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Updated lodash and constrained template rendering.',
      validation: 'Dependency tests and TypeScript checks passed.',
      prLabel: 'Open pull request #482',
    },
    {
      number: 1,
      status: 'Failed',
      tone: 'destructive',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 11:42 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Repository checkout timed out before changes began.',
    },
  ],
};

const draftPrOpened: RemediationConfig = {
  previewTitle: 'Draft pull request opened',
  previewDescription:
    'A pull request outcome where the code change exists but incomplete validation or risk requires explicit reviewer attention.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Draft remediation pull request is ready',
    description:
      'Cloud Agent prepared a concrete fix, but validation could not cover the full integration path. The pull request needs review before it is ready to merge.',
    icon: GitPullRequest,
    tone: 'warning',
  },
  summary: [
    {
      label: 'Outcome',
      value: 'Draft PR #483',
      detail: 'A concrete repository change is available',
      icon: GitPullRequest,
      tone: 'success',
    },
    {
      label: 'Validation',
      value: 'Incomplete',
      detail: 'Integration tests need service credentials',
      icon: TriangleAlert,
      tone: 'warning',
    },
    {
      label: 'Reviewer focus',
      value: 'Template behavior',
      detail: 'Confirm rendering compatibility before merge',
      icon: ShieldAlert,
      tone: 'warning',
    },
  ],
  contextNote:
    'Draft describes pull request readiness, not a separate remediation lifecycle status. The remediation outcome is still PR opened.',
  action: {
    sectionLabel: 'Next step',
    title: 'Review validation gaps and code changes',
    description:
      'Run the integration test suite with service credentials and confirm template output before marking the pull request ready.',
    label: 'View draft pull request',
    icon: ExternalLink,
    primary: true,
  },
  disclosureTitle: 'Why the pull request is a draft',
  steps: [
    {
      title: 'Prepared a concrete fix',
      detail: 'Updated lodash and constrained template rendering.',
      state: 'done',
    },
    {
      title: 'Ran available validation',
      detail: 'Unit tests passed, but integration tests require unavailable service credentials.',
      state: 'done',
    },
    {
      title: 'Reviewer attention required',
      detail: 'Verify template output compatibility before marking the pull request ready.',
      state: 'attention',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'PR opened',
      tone: 'success',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 12:31 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Branch', value: 'kilo/security/lodash-cve-2021-23337', mono: true },
      ],
      outcome: 'Prepared the dependency update and renderer change.',
      validation:
        'Unit tests passed. Integration tests were not run because credentials were unavailable.',
      risk: 'Confirm template output compatibility before merge.',
      prLabel: 'Open draft pull request #483',
    },
  ],
};

const blocked: RemediationConfig = {
  previewTitle: 'Blocked',
  previewDescription:
    'A completed attempt blocked by another open pull request that likely covers the same package and dependency file.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Another pull request blocks remediation',
    description:
      'Security Agent found an open pull request for lodash in the same dependency file and stopped before creating a competing change.',
    icon: Ban,
    tone: 'warning',
  },
  summary: [
    {
      label: 'Block reason',
      value: 'Related PR already open',
      detail: 'Pull request #476 updates the same package',
      icon: GitPullRequest,
      tone: 'warning',
    },
    {
      label: 'Repository changes',
      value: 'None created',
      detail: 'Cloud Agent stopped before making a branch',
      icon: GitBranch,
      tone: 'neutral',
    },
    {
      label: 'What should I do?',
      value: 'Review the existing PR',
      detail: 'Retry only if it does not resolve this finding',
      icon: ExternalLink,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Blocked is distinct from failed. Security Agent intentionally stopped because proceeding could create conflicting remediation work.',
  action: {
    sectionLabel: 'Next step',
    title: 'Review the existing remediation',
    description:
      'Check whether pull request #476 updates the affected dependency file and resolves this vulnerability.',
    label: 'View existing pull request',
    icon: ExternalLink,
    primary: true,
  },
  disclosureTitle: 'Why remediation was blocked',
  steps: [
    {
      title: 'Attempt admitted',
      detail: 'Security Agent accepted automatic remediation for this finding.',
      state: 'done',
    },
    {
      title: 'Checked for competing work',
      detail: 'An open pull request already updates lodash in package.json.',
      state: 'done',
    },
    {
      title: 'Stopped before repository changes',
      detail: 'Security Agent blocked the attempt to avoid a competing pull request.',
      state: 'error',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Blocked',
      tone: 'warning',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 12:14 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Blocking PR', value: '#476', mono: true },
      ],
      outcome: 'A related open pull request likely covers the same package and dependency file.',
      risk: 'Opening another remediation pull request could create conflicting lockfile changes.',
      prLabel: 'Open blocking pull request #476',
    },
  ],
};

const failed: RemediationConfig = {
  previewTitle: 'Failed',
  previewDescription:
    'A terminal Security Remediation Attempt that could not access the repository. The failure is actionable and retry remains explicit.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Remediation did not complete',
    description:
      'Cloud Agent could not load the repository, so it made no code changes and did not open a pull request.',
    icon: XCircle,
    tone: 'destructive',
  },
  summary: [
    {
      label: 'What happened?',
      value: 'Repository checkout failed',
      detail: 'The repository snapshot was unavailable',
      icon: TriangleAlert,
      tone: 'destructive',
    },
    {
      label: 'Code changes',
      value: 'None',
      detail: 'No remediation branch or PR was created',
      icon: GitBranch,
      tone: 'neutral',
    },
    {
      label: 'What should I do?',
      value: 'Verify access and retry',
      detail: 'Current safety gates still allow another attempt',
      icon: RefreshCw,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Failure leaves the finding open. Retrying creates a new Security Remediation Attempt and preserves this attempt in history.',
  action: {
    sectionLabel: 'Next step',
    title: 'Retry after checking repository access',
    description:
      'Verify the GitHub integration can read and write this repository, then start another attempt.',
    label: 'Retry remediation',
    icon: RefreshCw,
    primary: true,
  },
  disclosureTitle: 'What failed',
  steps: [
    {
      title: 'Request accepted',
      detail: 'Security Agent created attempt #1.',
      state: 'done',
    },
    {
      title: 'Repository checkout failed',
      detail: 'Cloud Agent could not load the expected repository snapshot.',
      state: 'error',
    },
    {
      title: 'No pull request opened',
      detail: 'No verified code change or pull request exists.',
      state: 'pending',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Failed',
      tone: 'destructive',
      origin: 'Manual',
      requestedBy: 'Jordan Park',
      updatedAt: 'Jun 16, 2026 at 12:18 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Failure stage', value: 'Repository checkout' },
      ],
      outcome: 'Repository checkout failed before changes began.',
      risk: 'No repository files were modified.',
    },
  ],
};

const noChangesNeeded: RemediationConfig = {
  previewTitle: 'No changes needed',
  previewDescription:
    'A terminal semantic outcome where Cloud Agent determined that no repository change should be made and correctly opened no pull request.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Cloud Agent found no safe change to make',
    description:
      'The repository already resolves to the patched package at install time. Cloud Agent opened no pull request because the manifest and lockfile need no change.',
    icon: CheckCircle2,
    tone: 'neutral',
  },
  summary: [
    {
      label: 'Outcome',
      value: 'No repository changes',
      detail: 'A no-change pull request was not opened',
      icon: Check,
      tone: 'neutral',
    },
    {
      label: 'Finding state',
      value: 'Still open',
      detail: 'Source synchronization controls closure',
      icon: ShieldAlert,
      tone: 'warning',
    },
    {
      label: 'What should I do?',
      value: 'Review source state',
      detail: 'Retry only after new evidence or re-analysis',
      icon: Info,
      tone: 'neutral',
    },
  ],
  contextNote:
    'No changes needed is not the same as fixed. Security Agent does not close the finding or invent a pull request.',
  action: {
    sectionLabel: 'Next step',
    title: 'No immediate remediation action',
    description:
      'Review the finding now. If source data or repository evidence changes, run fresh analysis before deciding whether to retry.',
    label: 'Review finding details',
    icon: Info,
  },
  disclosureTitle: 'Why no changes were made',
  steps: [
    {
      title: 'Inspected dependency declarations',
      detail: 'The manifest range already permits lodash 4.17.21.',
      state: 'done',
    },
    {
      title: 'Checked the resolved dependency',
      detail: 'The current lockfile resolves to the patched version.',
      state: 'done',
    },
    {
      title: 'Skipped a no-change pull request',
      detail: 'Cloud Agent correctly ended without creating repository noise.',
      state: 'done',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'No changes needed',
      tone: 'neutral',
      origin: 'Manual',
      requestedBy: 'Jordan Park',
      updatedAt: 'Jun 16, 2026 at 12:22 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Resolved version', value: 'lodash 4.17.21', mono: true },
      ],
      outcome:
        'The lockfile already resolves to the patched version. No repository change was required.',
      validation: 'Dependency resolution check completed.',
    },
  ],
};

const cancelled: RemediationConfig = {
  previewTitle: 'Cancelled',
  previewDescription:
    'A terminal attempt where Cloud Agent confirmed interruption before opening a pull request. Retry remains available when safety gates pass.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 16, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Remediation was cancelled',
    description:
      'Cloud Agent confirmed interruption before opening a pull request. Any partial session work was not published to the repository.',
    icon: XCircle,
    tone: 'neutral',
  },
  summary: [
    {
      label: 'Outcome',
      value: 'Cancelled',
      detail: 'Cloud Agent confirmed interruption',
      icon: XCircle,
      tone: 'neutral',
    },
    {
      label: 'Cancellation requested by',
      value: 'Jordan Park',
      detail: 'Manual cancellation',
      icon: UserRound,
      tone: 'neutral',
    },
    {
      label: 'Pull request',
      value: 'Not opened',
      detail: 'No repository outcome was published',
      icon: GitPullRequest,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Cancelled is a terminal attempt outcome, not a finding status. The Security Finding remains open.',
  action: {
    sectionLabel: 'Next step',
    title: 'Start a new attempt when ready',
    description:
      'The current analysis still provides a concrete fix path and no pull request blocks another attempt.',
    label: 'Retry remediation',
    icon: RefreshCw,
    primary: true,
  },
  disclosureTitle: 'How cancellation completed',
  steps: [
    {
      title: 'Remediation started',
      detail: 'Cloud Agent began repository work.',
      state: 'done',
    },
    {
      title: 'Cancellation requested',
      detail: 'Jordan Park asked Security Agent to stop the attempt.',
      state: 'done',
    },
    {
      title: 'Interruption confirmed',
      detail: 'Cloud Agent stopped before opening a pull request.',
      state: 'done',
    },
  ],
  attempts: [
    {
      number: 1,
      status: 'Cancelled',
      tone: 'neutral',
      origin: 'Automatic policy',
      requestedBy: 'Security Agent',
      updatedAt: 'Jun 16, 2026 at 12:16 UTC',
      facts: [
        { label: 'Model', value: 'claude-sonnet-4', mono: true },
        { label: 'Cancelled by', value: 'Jordan Park' },
      ],
      outcome: 'Cloud Agent confirmed interruption before opening a pull request.',
    },
  ],
};

function RemediationMockup({ config }: { config: RemediationConfig }) {
  const ActionIcon = config.action.icon;

  return (
    <FindingDialogShell header={config.header} selectedTab="Remediation">
      <div className="space-y-6">
        <FindingOutcome {...config.hero} />

        <FindingActionSection
          label={config.action.sectionLabel}
          title={config.action.title}
          description={config.action.description}
        >
          {config.action.label && ActionIcon && (
            <>
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
            </>
          )}
        </FindingActionSection>

        <section>
          <h4 className="type-body mb-3 font-medium">Remediation summary</h4>
          <div className="border-border grid overflow-hidden rounded-lg border md:grid-cols-3">
            {config.summary.map((item, index) => (
              <SummaryCell
                key={item.label}
                item={item}
                last={index === config.summary.length - 1}
              />
            ))}
          </div>
        </section>

        <FindingContextNote>{config.contextNote}</FindingContextNote>

        <RemediationDisclosures config={config} />
      </div>
    </FindingDialogShell>
  );
}

function SummaryCell({ item, last }: { item: SummaryItem; last: boolean }) {
  const Icon = item.icon;
  return (
    <div
      className={`min-w-0 p-4 ${!last ? 'border-border border-b md:border-r md:border-b-0' : ''}`}
    >
      <div className="text-muted-foreground type-label flex items-center gap-2">
        <Icon className={`size-icon-sm ${toneStyles[item.tone].text}`} aria-hidden="true" />
        {item.label}
      </div>
      <div className={`type-body mt-2 font-medium ${toneStyles[item.tone].text}`}>{item.value}</div>
      <div className="text-muted-foreground type-label mt-1">{item.detail}</div>
    </div>
  );
}

function RemediationDisclosures({ config }: { config: RemediationConfig }) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="progress" className="border-border border-t">
        <AccordionTrigger className="min-h-control-touch type-body py-3 no-underline hover:no-underline">
          {config.disclosureTitle}
        </AccordionTrigger>
        <AccordionContent className="pb-5">
          <ol className="max-w-2xl space-y-3">
            {config.steps.map((step, index) => (
              <RemediationStepRow key={step.title} step={step} index={index} />
            ))}
          </ol>
        </AccordionContent>
      </AccordionItem>

      {config.attempts.length > 0 && (
        <AccordionItem value="attempts" className="border-border">
          <AccordionTrigger className="min-h-control-touch type-body py-3 no-underline hover:no-underline">
            Remediation attempt history ({config.attempts.length})
          </AccordionTrigger>
          <AccordionContent className="pb-5">
            <div className="space-y-3">
              {config.attempts.map(attempt => (
                <AttemptRecord key={attempt.number} attempt={attempt} />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      )}
    </Accordion>
  );
}

function RemediationStepRow({ step, index }: { step: RemediationStep; index: number }) {
  const presentation = {
    done: {
      icon: Check,
      classes: toneStyles.success.step,
    },
    running: {
      icon: Loader2,
      classes: toneStyles.warning.step,
    },
    waiting: {
      icon: Clock3,
      classes: toneStyles.warning.step,
    },
    attention: {
      icon: TriangleAlert,
      classes: toneStyles.warning.step,
    },
    pending: {
      icon: null,
      classes: toneStyles.neutral.step,
    },
    error: {
      icon: XCircle,
      classes: toneStyles.destructive.step,
    },
  }[step.state];
  const StepIcon = presentation.icon;

  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
      <div
        className={`size-control-default type-code flex items-center justify-center rounded-md ring-1 ${presentation.classes}`}
      >
        {StepIcon ? (
          <StepIcon
            className={`size-4 ${step.state === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden="true"
          />
        ) : (
          String(index + 1).padStart(2, '0')
        )}
      </div>
      <div className="pt-0.5">
        <h5 className="type-body font-medium">{step.title}</h5>
        <p className="text-muted-foreground type-body mt-0.5">{step.detail}</p>
      </div>
    </li>
  );
}

function AttemptRecord({ attempt }: { attempt: RemediationAttempt }) {
  return (
    <section className="border-border bg-surface-inset rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="type-code">
            #{attempt.number}
          </Badge>
          <span
            className={`type-label px-status rounded-full border py-1 ${toneStyles[attempt.tone].status}`}
          >
            {attempt.status}
          </span>
          <span className="text-muted-foreground type-label">{attempt.origin}</span>
        </div>
        <span className="text-muted-foreground type-code tabular-nums">{attempt.updatedAt}</span>
      </div>

      <div className="type-body mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <AttemptFactItem fact={{ label: 'Attempt started by', value: attempt.requestedBy }} />
        {attempt.facts.map(fact => (
          <AttemptFactItem key={fact.label} fact={fact} />
        ))}
      </div>

      {attempt.outcome && (
        <div className="border-border mt-4 border-t pt-4">
          <div className="text-muted-foreground type-label">Outcome</div>
          <p className="type-body mt-1 max-w-[68ch]">{attempt.outcome}</p>
        </div>
      )}
      {attempt.validation && (
        <div className="type-body mt-3 flex max-w-[68ch] items-start gap-2">
          <FileCheck2
            className="text-status-success-icon mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>
            <span className="font-medium">Validation:</span>{' '}
            <span className="text-muted-foreground">{attempt.validation}</span>
          </p>
        </div>
      )}
      {attempt.risk && (
        <div className="type-body mt-3 flex max-w-[68ch] items-start gap-2">
          <TriangleAlert
            className="text-status-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>
            <span className="font-medium">Risk note:</span>{' '}
            <span className="text-muted-foreground">{attempt.risk}</span>
          </p>
        </div>
      )}
      {attempt.prLabel && (
        <Button variant="link" size="sm" className="h-control-default type-label mt-2 px-0">
          {attempt.prLabel}
          <ExternalLink className="size-3" aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}

function AttemptFactItem({ fact }: { fact: AttemptFact }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground type-label">{fact.label}</div>
      <div className={`type-body mt-1 break-words ${fact.mono ? 'type-code' : 'font-medium'}`}>
        {fact.value}
      </div>
    </div>
  );
}

function RemediationStory({ config }: { config: RemediationConfig }) {
  return (
    <FindingPreview
      eyebrow="Security Agent finding remediation"
      title={config.previewTitle}
      description={config.previewDescription}
    >
      <RemediationMockup config={config} />
    </FindingPreview>
  );
}

export const Eligible: Story = {
  name: 'Ready to remediate',
  render: () => <RemediationStory config={eligible} />,
};

export const AnalysisRequired: Story = {
  name: 'Analysis required',
  render: () => <RemediationStory config={analysisRequired} />,
};

export const Queued: Story = {
  render: () => <RemediationStory config={queued} />,
};

export const Starting: Story = {
  name: 'Starting Cloud Agent',
  render: () => <RemediationStory config={starting} />,
};

export const Running: Story = {
  name: 'In progress',
  render: () => <RemediationStory config={running} />,
};

export const CancellationRequested: Story = {
  name: 'Cancellation requested',
  render: () => <RemediationStory config={cancellationRequested} />,
};

export const PullRequestOpened: Story = {
  name: 'Pull request opened',
  render: () => <RemediationStory config={prOpened} />,
};

export const DraftPullRequestOpened: Story = {
  name: 'Draft pull request opened',
  render: () => <RemediationStory config={draftPrOpened} />,
};

export const Blocked: Story = {
  render: () => <RemediationStory config={blocked} />,
};

export const Failed: Story = {
  render: () => <RemediationStory config={failed} />,
};

export const NoChangesNeeded: Story = {
  name: 'No changes needed',
  render: () => <RemediationStory config={noChangesNeeded} />,
};

export const Cancelled: Story = {
  render: () => <RemediationStory config={cancelled} />,
};
