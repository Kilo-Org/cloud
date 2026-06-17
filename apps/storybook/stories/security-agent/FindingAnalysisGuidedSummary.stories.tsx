'use client';

import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import {
  Check,
  CircleHelp,
  Clock3,
  FileCode2,
  FileWarning,
  GitPullRequest,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Wrench,
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
  title: 'Security Agent/Finding Analysis',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Plain-language, progressive-disclosure variations for Security Finding codebase analysis outcomes.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;

type OutcomeQuestion = {
  question: string;
  answer: string;
  detail: string;
  icon: LucideIcon;
  tone: Tone;
};

type AnalysisStep = {
  title: string;
  detail: string;
  icon?: LucideIcon;
  tone?: Tone;
};

type EvidenceFactData = {
  label: string;
  value: string;
  mono?: boolean;
};

type ReportSection = {
  title: string;
  body: string;
  code?: string;
};

type TechnicalDisclosureBase = {
  title: string;
  reportTitle: string;
  reportMeta: string;
  reportSections: ReportSection[];
};

type TechnicalDisclosure =
  | (TechnicalDisclosureBase & {
      kind: 'evidence';
      facts: EvidenceFactData[];
      locations: string[];
    })
  | (TechnicalDisclosureBase & {
      kind: 'report-only';
    });

type OutcomeConfig = {
  previewTitle: string;
  previewDescription: string;
  header: FindingHeaderData;
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
  };
  questions: OutcomeQuestion[];
  contextNote: string;
  recommendation: {
    title: string;
    description: string;
    actionLabel: string;
    actionIcon: LucideIcon;
    primary: boolean;
    secondaryLabel?: string;
  };
  firstDisclosure: {
    title: string;
    steps: AnalysisStep[];
  };
  technicalDisclosure: TechnicalDisclosure | null;
};

const noExploitablePath: OutcomeConfig = {
  previewTitle: 'No exploitable path',
  previewDescription:
    'Analysis found no reachable use of the vulnerable feature. The finding is dismissed, but the package itself is not presented as fixed.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Dismissed', tone: 'neutral' },
    analysis: { value: 'No reachable path', tone: 'success' },
  },
  hero: {
    title: 'No reachable risk found',
    description:
      'Analysis found no path that can trigger this vulnerability in this repository. You can update lodash during routine maintenance.',
    icon: ShieldCheck,
    tone: 'success',
  },
  questions: [
    {
      question: 'Why?',
      answer: 'The affected feature is not used',
      detail: 'No reachable use was found in this repository',
      icon: Search,
      tone: 'neutral',
    },
    {
      question: 'Do I need to act now?',
      answer: 'No urgent response needed',
      detail: 'Update during routine maintenance',
      icon: Clock3,
      tone: 'success',
    },
    {
      question: 'What should I do?',
      answer: 'Update lodash',
      detail: 'Move from 4.17.19 to 4.17.21',
      icon: Wrench,
      tone: 'neutral',
    },
  ],
  contextNote:
    'This result reflects the repository when it was analyzed. It does not mean the package is fixed.',
  recommendation: {
    title: 'Update during routine maintenance',
    description: 'Upgrade lodash from 4.17.19 to 4.17.21. No urgent security response is needed.',
    actionLabel: 'View update options',
    actionIcon: Wrench,
    primary: false,
    secondaryLabel: 'Ask Cloud Agent',
  },
  firstDisclosure: {
    title: 'How Security Agent reached this decision',
    steps: [
      {
        title: 'Found the affected library',
        detail: 'The repository uses a version of lodash with a published vulnerability.',
      },
      {
        title: 'Checked the application',
        detail: 'Security Agent looked for use of the affected feature.',
      },
      {
        title: 'Reviewed related packages',
        detail: 'Other packages use unaffected parts of lodash.',
      },
      {
        title: 'Found no exploitable path',
        detail: 'No path to trigger the vulnerable feature was found in this repository.',
        icon: Check,
        tone: 'success',
      },
    ],
  },
  technicalDisclosure: {
    kind: 'evidence',
    title: 'Technical evidence and generated report',
    facts: [
      { label: 'Affected package', value: 'lodash 4.17.19', mono: true },
      { label: 'Affected API', value: '_.template()', mono: true },
      { label: 'Direct calls', value: 'None found' },
      { label: 'Dependency paths', value: '2 transitive' },
    ],
    locations: [
      'package.json:17',
      'node_modules/jsonwebtoken/package.json',
      'node_modules/sequelize/package.json',
      'pages/index.js:1-84 (searched, no import)',
      'pages/_app.js:1-42 (searched, no import)',
    ],
    reportTitle: 'Full generated report',
    reportMeta: 'claude-sonnet-4, Jun 15 at 14:32 UTC',
    reportSections: [
      {
        title: 'Vulnerability analysis',
        body: 'CVE-2021-23337 affects lodash template compilation when attacker-controlled input reaches the template function. No direct use was found in application source.',
      },
      {
        title: 'Exploitability assessment',
        body: 'No execution path was found. Transitive dependencies use unaffected utility methods.',
      },
      {
        title: 'Suggested fix',
        body: 'Update the direct dependency to the patched release.',
        code: '"lodash": "^4.17.21"',
      },
    ],
  },
};

const exploitable: OutcomeConfig = {
  previewTitle: 'Exploitable',
  previewDescription:
    'Analysis confirmed a reachable vulnerable path and recommends remediation. Urgency and action are prominent without hiding supporting evidence.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Exploitable', tone: 'destructive' },
  },
  hero: {
    title: 'Action required',
    description:
      'Analysis found a reachable use of the vulnerable lodash feature in this repository. Prioritize remediation.',
    icon: ShieldAlert,
    tone: 'destructive',
  },
  questions: [
    {
      question: 'Why?',
      answer: 'Vulnerable code is reachable',
      detail: 'User-controlled data may reach the affected feature',
      icon: Search,
      tone: 'destructive',
    },
    {
      question: 'Do I need to act now?',
      answer: 'Yes, prioritize this finding',
      detail: 'A reachable high-severity path was found',
      icon: Clock3,
      tone: 'destructive',
    },
    {
      question: 'What should I do?',
      answer: 'Update and review usage',
      detail: 'Patch lodash and inspect the flagged call',
      icon: Wrench,
      tone: 'neutral',
    },
  ],
  contextNote:
    'The published severity is high, and application code can reach the affected feature.',
  recommendation: {
    title: 'Remediate this finding',
    description:
      'Update lodash to 4.17.21 and review the flagged template call before merging the change.',
    actionLabel: 'Start remediation',
    actionIcon: GitPullRequest,
    primary: true,
    secondaryLabel: 'Ask Cloud Agent',
  },
  firstDisclosure: {
    title: 'How Security Agent reached this decision',
    steps: [
      {
        title: 'Found the affected library',
        detail: 'The repository uses lodash 4.17.19.',
      },
      {
        title: 'Found a direct call',
        detail: 'Application code calls the affected template function.',
      },
      {
        title: 'Traced user-controlled input',
        detail: 'Request data can reach the vulnerable call without validation.',
      },
      {
        title: 'Confirmed an exploitable path',
        detail: 'The vulnerable feature is reachable in this repository.',
        icon: ShieldAlert,
        tone: 'destructive',
      },
    ],
  },
  technicalDisclosure: {
    kind: 'evidence',
    title: 'Technical evidence and generated report',
    facts: [
      { label: 'Affected package', value: 'lodash 4.17.19', mono: true },
      { label: 'Affected API', value: '_.template()', mono: true },
      { label: 'Direct calls', value: '1 found' },
      { label: 'Input source', value: 'Request body' },
    ],
    locations: ['src/lib/template-renderer.ts:42', 'src/routes/preview.ts:118', 'package.json:17'],
    reportTitle: 'Full generated report',
    reportMeta: 'claude-sonnet-4, Jun 15 at 14:32 UTC',
    reportSections: [
      {
        title: 'Vulnerability analysis',
        body: 'The preview route passes request-controlled template content to lodash template compilation.',
      },
      {
        title: 'Exploitability assessment',
        body: 'A reachable execution path exists from the request body to the affected API.',
      },
      {
        title: 'Suggested fix',
        body: 'Update lodash and replace untrusted template compilation with a constrained renderer.',
        code: '"lodash": "^4.17.21"',
      },
    ],
  },
};

const inconclusive: OutcomeConfig = {
  previewTitle: 'Inconclusive',
  previewDescription:
    'Analysis completed but could not confirm whether the vulnerable path is exploitable. The user gets a clear review task rather than a false safe or unsafe conclusion.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Needs review', tone: 'warning' },
  },
  hero: {
    title: 'Review recommended',
    description:
      'Analysis found use of the affected lodash feature, but could not confirm whether untrusted input can reach it.',
    icon: CircleHelp,
    tone: 'warning',
  },
  questions: [
    {
      question: 'Why?',
      answer: 'The input source is unclear',
      detail: 'Analysis could not verify where template content comes from',
      icon: Search,
      tone: 'warning',
    },
    {
      question: 'Do I need to act now?',
      answer: 'Review before dismissing',
      detail: 'The finding is neither confirmed nor cleared',
      icon: Clock3,
      tone: 'warning',
    },
    {
      question: 'What should I do?',
      answer: 'Inspect the flagged call',
      detail: 'Confirm whether untrusted input can reach it',
      icon: Wrench,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Analysis could not confirm whether the repository is exposed. Review the flagged code before changing the finding status.',
  recommendation: {
    title: 'Review the flagged code',
    description:
      'Check where the template content originates and whether it can be influenced by an untrusted user.',
    actionLabel: 'Review evidence',
    actionIcon: Search,
    primary: true,
    secondaryLabel: 'Ask Cloud Agent',
  },
  firstDisclosure: {
    title: 'Why the result is inconclusive',
    steps: [
      {
        title: 'Found the affected library',
        detail: 'The repository uses lodash 4.17.19.',
      },
      {
        title: 'Found the affected feature',
        detail: 'Application code calls the lodash template function.',
      },
      {
        title: 'Traced available input paths',
        detail: 'Some call sites were resolved, but the template source remains unclear.',
      },
      {
        title: 'Could not confirm exploitability',
        detail: 'Manual review is needed to determine whether untrusted input can reach the call.',
        icon: CircleHelp,
        tone: 'warning',
      },
    ],
  },
  technicalDisclosure: {
    kind: 'evidence',
    title: 'Technical evidence and generated report',
    facts: [
      { label: 'Affected package', value: 'lodash 4.17.19', mono: true },
      { label: 'Affected API', value: '_.template()', mono: true },
      { label: 'Direct calls', value: '1 found' },
      { label: 'Input source', value: 'Unresolved' },
    ],
    locations: [
      'src/lib/template-renderer.ts:42',
      'src/services/content-loader.ts:76',
      'package.json:17',
    ],
    reportTitle: 'Full generated report',
    reportMeta: 'claude-sonnet-4, Jun 15 at 14:32 UTC',
    reportSections: [
      {
        title: 'Vulnerability analysis',
        body: 'The affected API is called in application code, but the source of the template string crosses an unresolved service boundary.',
      },
      {
        title: 'Exploitability assessment',
        body: 'Exploitability could not be confirmed or ruled out from the available repository context.',
      },
      {
        title: 'Suggested next step',
        body: 'Review the template source and document whether untrusted users can influence it.',
      },
    ],
  },
};

const summaryUnavailable: OutcomeConfig = {
  previewTitle: 'Analysis result needs review',
  previewDescription:
    'Repository analysis completed, but Security Agent could not create a reliable plain-language result. The technical report remains available for review.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Needs review', tone: 'warning' },
  },
  hero: {
    title: 'Analysis result needs review',
    description:
      'Security Agent analyzed the repository, but could not turn the technical report into a reliable plain-language result.',
    icon: FileWarning,
    tone: 'warning',
  },
  questions: [
    {
      question: 'What is the result?',
      answer: 'No conclusion is available',
      detail: 'Project risk remains unknown',
      icon: CircleHelp,
      tone: 'warning',
    },
    {
      question: 'Did analysis run?',
      answer: 'Yes, a report was created',
      detail: 'Only structured summary extraction failed',
      icon: Check,
      tone: 'neutral',
    },
    {
      question: 'What should I do?',
      answer: 'Review the technical report',
      detail: 'Use manual review before changing status',
      icon: Search,
      tone: 'neutral',
    },
  ],
  contextNote:
    'Analysis completed and the technical report is available, but the result still needs human review.',
  recommendation: {
    title: 'Review the generated report',
    description:
      'Read the technical report or ask Cloud Agent to explain it. Keep the finding open until the result is clear.',
    actionLabel: 'Open technical report',
    actionIcon: FileWarning,
    primary: true,
    secondaryLabel: 'Ask Cloud Agent',
  },
  firstDisclosure: {
    title: 'What happened during analysis',
    steps: [
      {
        title: 'Codebase analysis completed',
        detail: 'Security Agent inspected the repository and generated a technical report.',
      },
      {
        title: 'Report extraction started',
        detail: 'The report was processed into structured fields for the summary view.',
      },
      {
        title: 'Structured extraction failed',
        detail: 'No reliable exploitability verdict or recommendation could be extracted.',
        icon: FileWarning,
        tone: 'warning',
      },
    ],
  },
  technicalDisclosure: {
    kind: 'report-only',
    title: 'Generated technical report',
    reportTitle: 'Raw analysis output',
    reportMeta: 'claude-sonnet-4, Jun 15 at 14:32 UTC',
    reportSections: [
      {
        title: 'Analysis output',
        body: 'The repository contains lodash 4.17.19 and several indirect references. Additional review is required to determine whether the affected template function is reachable.',
      },
      {
        title: 'Extraction status',
        body: 'Structured summary extraction failed. No authoritative exploitability verdict or suggested action is available.',
      },
    ],
  },
};

const analysisFailed: OutcomeConfig = {
  previewTitle: 'Analysis failed',
  previewDescription:
    'Analysis did not complete. Risk remains unknown, the failure reason is kept concise, and retry is the clear next action.',
  header: {
    ...lodashFindingIdentity,
    activityLabel: 'Updated Jun 15, 2026',
    finding: { value: 'Open', tone: 'neutral' },
    analysis: { value: 'Failed', tone: 'destructive' },
  },
  hero: {
    title: 'Analysis did not complete',
    description:
      'Security Agent could not finish checking this repository, so no project-specific risk conclusion is available.',
    icon: TriangleAlert,
    tone: 'destructive',
  },
  questions: [
    {
      question: 'What is the result?',
      answer: 'Project risk is unknown',
      detail: 'No repository risk conclusion was produced',
      icon: CircleHelp,
      tone: 'warning',
    },
    {
      question: 'Why?',
      answer: 'The repository could not be loaded',
      detail: 'The checkout was unavailable during analysis',
      icon: TriangleAlert,
      tone: 'destructive',
    },
    {
      question: 'What should I do?',
      answer: 'Try analysis again',
      detail: 'Retry when repository access is available',
      icon: RefreshCw,
      tone: 'neutral',
    },
  ],
  contextNote:
    'The published severity is unchanged. Repository risk remains unknown until analysis completes.',
  recommendation: {
    title: 'Run analysis again',
    description:
      'Retry the analysis. If it fails again, verify repository access before requesting manual review.',
    actionLabel: 'Retry analysis',
    actionIcon: RefreshCw,
    primary: true,
    secondaryLabel: 'View repository access',
  },
  firstDisclosure: {
    title: 'Error details',
    steps: [
      {
        title: 'Analysis started',
        detail: 'Security Agent accepted the analysis request.',
      },
      {
        title: 'Repository checkout failed',
        detail: 'The repository snapshot could not be loaded. No source files were analyzed.',
        icon: TriangleAlert,
        tone: 'destructive',
      },
      {
        title: 'No report was generated',
        detail: 'Retry is required before Security Agent can assess project risk.',
        icon: FileWarning,
        tone: 'warning',
      },
    ],
  },
  technicalDisclosure: null,
};

function OutcomeMockup({ config }: { config: OutcomeConfig }) {
  const ActionIcon = config.recommendation.actionIcon;

  return (
    <FindingDialogShell header={config.header} selectedTab="Analysis">
      <div className="space-y-6">
        <FindingOutcome {...config.hero} />

        <FindingActionSection
          label="Next step"
          title={config.recommendation.title}
          description={config.recommendation.description}
        >
          <Button
            variant={config.recommendation.primary ? 'default' : 'outline'}
            className="h-control-touch type-label"
          >
            <ActionIcon aria-hidden="true" />
            {config.recommendation.actionLabel}
          </Button>
          {config.recommendation.secondaryLabel && (
            <Button variant="ghost" className="h-control-touch type-label">
              <CircleHelp aria-hidden="true" />
              {config.recommendation.secondaryLabel}
            </Button>
          )}
        </FindingActionSection>

        <section>
          <h4 className="type-body mb-3 font-medium">What this means</h4>
          <div className="border-border grid overflow-hidden rounded-lg border md:grid-cols-3">
            {config.questions.map((question, index) => (
              <QuestionAnswer
                key={question.question}
                {...question}
                last={index === config.questions.length - 1}
              />
            ))}
          </div>
        </section>

        <FindingContextNote>{config.contextNote}</FindingContextNote>

        <AnalysisDisclosures
          firstDisclosure={config.firstDisclosure}
          technicalDisclosure={config.technicalDisclosure}
        />
      </div>
    </FindingDialogShell>
  );
}

function QuestionAnswer({
  question,
  answer,
  detail,
  icon: Icon,
  tone,
  last = false,
}: OutcomeQuestion & { last?: boolean }) {
  return (
    <div
      className={`min-w-0 p-4 ${!last ? 'border-border border-b md:border-r md:border-b-0' : ''}`}
    >
      <div className="text-muted-foreground type-label flex items-center gap-2">
        <Icon className={`size-icon-sm ${toneStyles[tone].text}`} aria-hidden="true" />
        {question}
      </div>
      <div className={`type-body mt-2 font-medium ${toneStyles[tone].text}`}>{answer}</div>
      <div className="text-muted-foreground type-label mt-1">{detail}</div>
    </div>
  );
}

function AnalysisDisclosures({
  firstDisclosure,
  technicalDisclosure,
}: {
  firstDisclosure: OutcomeConfig['firstDisclosure'];
  technicalDisclosure: TechnicalDisclosure | null;
}) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="decision" className="border-border border-t">
        <AccordionTrigger className="min-h-control-touch type-body py-3 no-underline hover:no-underline">
          {firstDisclosure.title}
        </AccordionTrigger>
        <AccordionContent className="pb-5">
          <ol className="max-w-2xl space-y-3">
            {firstDisclosure.steps.map((step, index) => (
              <AnalysisStepRow key={step.title} step={step} index={index} />
            ))}
          </ol>
        </AccordionContent>
      </AccordionItem>

      {technicalDisclosure && (
        <AccordionItem value="technical" className="border-border">
          <AccordionTrigger className="min-h-control-touch type-body py-3 no-underline hover:no-underline">
            {technicalDisclosure.title}
          </AccordionTrigger>
          <AccordionContent className="pb-5">
            <TechnicalEvidence disclosure={technicalDisclosure} />
          </AccordionContent>
        </AccordionItem>
      )}
    </Accordion>
  );
}

function AnalysisStepRow({ step, index }: { step: AnalysisStep; index: number }) {
  const StepIcon = step.icon;
  const tone = step.tone ?? 'neutral';

  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
      <div
        className={`size-control-default type-code flex items-center justify-center rounded-md ring-1 ${toneStyles[tone].step}`}
      >
        {StepIcon ? (
          <StepIcon className="size-4" aria-hidden="true" />
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

function TechnicalEvidence({ disclosure }: { disclosure: TechnicalDisclosure }) {
  return (
    <div className="space-y-6">
      {disclosure.kind === 'evidence' && disclosure.facts.length > 0 && (
        <dl className="type-body grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          {disclosure.facts.map(fact => (
            <EvidenceFact key={fact.label} {...fact} />
          ))}
        </dl>
      )}

      {disclosure.kind === 'evidence' && disclosure.locations.length > 0 && (
        <UsageLocations locations={disclosure.locations} />
      )}

      <div className="border-border border-t pt-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h5 className="type-body font-medium">{disclosure.reportTitle}</h5>
          <span className="text-muted-foreground type-code">{disclosure.reportMeta}</span>
        </div>
        <TechnicalReportContent sections={disclosure.reportSections} />
      </div>
    </div>
  );
}

function EvidenceFact({ label, value, mono = false }: EvidenceFactData) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground type-label">{label}</dt>
      <dd className={`type-body mt-1 break-words ${mono ? 'type-code' : 'font-medium'}`}>
        {value}
      </dd>
    </div>
  );
}

function UsageLocations({ locations }: { locations: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const visibleLocations = showAll ? locations : locations.slice(0, 2);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h4 className="type-body font-medium">Where this was found</h4>
        <span className="text-muted-foreground type-code">
          {locations.length} code {locations.length === 1 ? 'location' : 'locations'}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {visibleLocations.map(location => (
          <li
            key={location}
            className="bg-surface-inset text-syntax-plain type-code flex min-w-0 items-start gap-2 rounded-md px-3 py-2"
          >
            <FileCode2 className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
            <span className="break-all">{location}</span>
          </li>
        ))}
      </ul>
      {locations.length > 2 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-control-default type-label mt-2 px-2"
          onClick={() => setShowAll(current => !current)}
        >
          {showAll ? 'Show fewer locations' : `Show all ${locations.length} locations`}
        </Button>
      )}
    </div>
  );
}

function TechnicalReportContent({ sections }: { sections: ReportSection[] }) {
  return (
    <div className="text-muted-foreground type-body max-w-[68ch] space-y-5">
      {sections.map(section => (
        <section key={section.title}>
          <h5 className="text-foreground font-medium">{section.title}</h5>
          <p className="mt-1">{section.body}</p>
          {section.code && (
            <pre className="bg-surface-inset border-border text-syntax-plain type-code mt-2 overflow-x-auto rounded-md border px-3 py-2">
              {section.code}
            </pre>
          )}
        </section>
      ))}
    </div>
  );
}

function OutcomeStory({ config }: { config: OutcomeConfig }) {
  return (
    <FindingPreview
      eyebrow="Security Agent finding analysis"
      title={config.previewTitle}
      description={config.previewDescription}
    >
      <OutcomeMockup config={config} />
    </FindingPreview>
  );
}

export const NoExploitablePath: Story = {
  name: 'No exploitable path',
  render: () => <OutcomeStory config={noExploitablePath} />,
};

export const Exploitable: Story = {
  name: 'Exploitable',
  render: () => <OutcomeStory config={exploitable} />,
};

export const Inconclusive: Story = {
  name: 'Inconclusive',
  render: () => <OutcomeStory config={inconclusive} />,
};

export const SummaryUnavailable: Story = {
  name: 'Summary unavailable',
  render: () => <OutcomeStory config={summaryUnavailable} />,
};

export const AnalysisFailed: Story = {
  name: 'Analysis failed',
  render: () => <OutcomeStory config={analysisFailed} />,
};
