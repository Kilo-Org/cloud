'use client';

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  AlertCircle,
  Bell,
  Bot,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileClock,
  LayoutDashboard,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  SecurityAgentActionBar as ActionBar,
  SecurityAgentActionBarField as ActionBarField,
} from '@/components/security-agent/SecurityAgentActionBar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const meta: Meta = {
  title: 'Security Agent/Unified Action Bar',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Unified post-navigation action bar for Dashboard, Findings, Audit report, and Settings. Every section uses the same raised surface, border, radius, spacing, control height, responsive structure, and right-aligned action zone.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;
type Section = 'dashboard' | 'findings' | 'audit-report' | 'settings';
type FindingState = 'open' | 'closed';
type SettingsSection = 'general' | 'automation' | 'notifications' | 'sla';

type SectionDefinition = {
  value: Section;
  label: string;
  icon: LucideIcon;
};

const sections = [
  { value: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { value: 'findings', label: 'Findings', icon: ListChecks },
  { value: 'audit-report', label: 'Audit report', icon: FileClock },
  { value: 'settings', label: 'Settings', icon: Settings2 },
] satisfies SectionDefinition[];

const settingsSections = [
  { value: 'general', label: 'General', icon: SlidersHorizontal },
  { value: 'automation', label: 'Automation', icon: Bot },
  { value: 'notifications', label: 'Notifications', icon: Bell },
  { value: 'sla', label: 'SLA', icon: Clock },
] satisfies Array<{ value: SettingsSection; label: string; icon: LucideIcon }>;

const repositories = [
  'all',
  'Kilo-Org/cloud',
  'Kilo-Org/kilocode',
  'Kilo-Org/kilocode-landing',
  'Kilo-Org/security-agent-testbed',
];

const sectionTabClass =
  'min-h-11 gap-2 rounded-none border-0 border-b-2 border-transparent bg-transparent px-4 py-3 text-muted-foreground shadow-none hover:text-foreground data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none';

const settingsTabClass =
  'min-h-9 gap-2 border-0 px-3 text-muted-foreground shadow-none hover:bg-surface-hover hover:text-foreground data-[state=active]:border-0 data-[state=active]:bg-surface-selected data-[state=active]:text-foreground data-[state=active]:shadow-none';

function SyncStatus({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground flex min-h-8 items-center gap-1.5 text-xs whitespace-nowrap">
      <Clock className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function RepositorySelect({
  id,
  value,
  onValueChange,
  className,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className={cn('min-h-11 w-full sm:min-h-9', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {repositories.map(repository => (
          <SelectItem key={repository} value={repository}>
            {repository === 'all' ? 'All repositories' : repository}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DashboardActionBar() {
  const [repository, setRepository] = useState('all');
  const [isSyncing, setIsSyncing] = useState(false);

  function syncFindings() {
    setIsSyncing(true);
    window.setTimeout(() => setIsSyncing(false), 900);
  }

  return (
    <ActionBar label="Dashboard controls">
      <div className="grid gap-3 md:grid-cols-[minmax(0,20rem)_1fr] md:items-end">
        <ActionBarField id="dashboard-repository" label="Repository scope">
          <RepositorySelect
            id="dashboard-repository"
            value={repository}
            onValueChange={setRepository}
          />
        </ActionBarField>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between md:justify-end">
          <SyncStatus label="Last synced about 2 hours ago" />
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={isSyncing}
            onClick={syncFindings}
          >
            <RefreshCw
              className={isSyncing ? 'animate-spin motion-reduce:animate-none' : undefined}
              aria-hidden="true"
            />
            {isSyncing ? 'Syncing findings...' : 'Sync findings'}
          </Button>
        </div>
      </div>
    </ActionBar>
  );
}

function FindingStateButton({
  value,
  activeState,
  count,
  icon: Icon,
  onChange,
}: {
  value: FindingState;
  activeState: FindingState;
  count: number;
  icon: LucideIcon;
  onChange: (state: FindingState) => void;
}) {
  const isActive = value === activeState;

  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={() => onChange(value)}
      className={cn(
        'focus-visible:ring-ring flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:flex-none',
        isActive
          ? 'bg-surface-selected text-foreground'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span>
        <span className="font-mono tabular-nums">{count}</span> {value}
      </span>
    </button>
  );
}

function FindingsActionBar() {
  const [findingState, setFindingState] = useState<FindingState>('open');
  const [repository, setRepository] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [sort, setSort] = useState('severity-desc');
  const [isSyncing, setIsSyncing] = useState(false);

  function syncFindings() {
    setIsSyncing(true);
    window.setTimeout(() => setIsSyncing(false), 900);
  }

  return (
    <ActionBar label="Findings controls">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <fieldset className="min-w-0">
          <legend className="sr-only">Finding state</legend>
          <div className="border-input bg-input-background flex min-h-11 w-full items-center gap-1 rounded-lg border p-1 sm:min-h-9 sm:w-fit">
            <FindingStateButton
              value="open"
              activeState={findingState}
              count={318}
              icon={AlertCircle}
              onChange={setFindingState}
            />
            <FindingStateButton
              value="closed"
              activeState={findingState}
              count={21}
              icon={CheckCircle2}
              onChange={setFindingState}
            />
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
          <Badge
            variant="secondary"
            className="min-h-8 px-3"
            aria-label="2 of 3 analysis slots used"
          >
            <span className="font-mono tabular-nums">2/3</span> analysis capacity
          </Badge>
          <SyncStatus label="Last synced about 2 hours ago" />
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={isSyncing}
            onClick={syncFindings}
          >
            <RefreshCw
              className={isSyncing ? 'animate-spin motion-reduce:animate-none' : undefined}
              aria-hidden="true"
            />
            {isSyncing ? 'Syncing findings...' : 'Sync findings'}
          </Button>
        </div>
      </div>

      <div className="border-border mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_minmax(11rem,1fr)_minmax(12rem,1fr)]">
        <ActionBarField id="findings-repository" label="Repository">
          <RepositorySelect
            id="findings-repository"
            value={repository}
            onValueChange={setRepository}
          />
        </ActionBarField>

        <ActionBarField id="findings-severity" label="Severity">
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="findings-severity" className="min-h-11 w-full sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>

        <ActionBarField id="findings-outcome" label="Analysis outcome">
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger id="findings-outcome" className="min-h-11 w-full sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              <SelectItem value="exploitable">Exploitable</SelectItem>
              <SelectItem value="not-exploitable">Not exploitable</SelectItem>
              <SelectItem value="needs-review">Needs review</SelectItem>
              <SelectItem value="not-analyzed">Not analyzed</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>

        <ActionBarField id="findings-sort" label="Sort by">
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger id="findings-sort" className="min-h-11 w-full sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="severity-desc">Severity, highest first</SelectItem>
              <SelectItem value="severity-asc">Severity, lowest first</SelectItem>
              <SelectItem value="sla">SLA deadline, soonest first</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>
      </div>
    </ActionBar>
  );
}

function AuditReportActionBar() {
  const [dateRange, setDateRange] = useState('90-days');
  const [severity, setSeverity] = useState('all');
  const [findingState, setFindingState] = useState('all');
  const [repository, setRepository] = useState('all');
  const [isGenerating, setIsGenerating] = useState(false);

  function generateReport() {
    setIsGenerating(true);
    window.setTimeout(() => setIsGenerating(false), 900);
  }

  return (
    <ActionBar label="Audit report controls">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(18rem,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(13rem,1.3fr)_auto] xl:items-end">
        <ActionBarField
          id="audit-date-range"
          label="Report period"
          className="md:col-span-2 xl:col-span-1"
        >
          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger id="audit-date-range" className="min-h-11 w-full sm:min-h-9">
              <CalendarDays className="size-4" aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="90-days">Mar 20 to Jun 17, 2026</SelectItem>
              <SelectItem value="30-days">May 19 to Jun 17, 2026</SelectItem>
              <SelectItem value="today">Jun 17, 2026</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>

        <ActionBarField id="audit-severity" label="Severity">
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="audit-severity" className="min-h-11 w-full sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>

        <ActionBarField id="audit-state" label="State">
          <Select value={findingState} onValueChange={setFindingState}>
            <SelectTrigger id="audit-state" className="min-h-11 w-full sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="fixed">Fixed</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
            </SelectContent>
          </Select>
        </ActionBarField>

        <ActionBarField id="audit-repository" label="Repository">
          <RepositorySelect
            id="audit-repository"
            value={repository}
            onValueChange={setRepository}
          />
        </ActionBarField>

        <div className="flex items-end md:col-span-2 xl:col-span-1">
          <Button
            type="button"
            className="min-h-11 w-full sm:min-h-9 xl:w-auto"
            disabled={isGenerating}
            onClick={generateReport}
          >
            <RefreshCw
              className={isGenerating ? 'animate-spin motion-reduce:animate-none' : undefined}
              aria-hidden="true"
            />
            {isGenerating ? 'Generating report...' : 'Generate report'}
          </Button>
        </div>
      </div>
    </ActionBar>
  );
}

function SettingsActionBar({
  activeSection,
  onSectionChange,
}: {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const [hasChanges, setHasChanges] = useState(true);

  return (
    <ActionBar label="Settings controls">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <div className="min-w-0">
          <Tabs
            value={activeSection}
            className="min-w-0 sm:w-max sm:max-w-full"
            onValueChange={value => {
              const nextSection = settingsSections.find(section => section.value === value);
              if (nextSection) onSectionChange(nextSection.value);
            }}
          >
            <TabsList
              aria-label="Security Agent settings sections"
              className="border-input bg-input-background h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border p-1"
            >
              {settingsSections.map(section => {
                const Icon = section.icon;
                return (
                  <TabsTrigger
                    key={section.value}
                    value={section.value}
                    className={settingsTabClass}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {section.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center xl:justify-end">
          <span
            className={cn(
              'flex min-h-8 items-center gap-1.5 text-xs whitespace-nowrap',
              hasChanges ? 'text-status-warning' : 'text-muted-foreground'
            )}
          >
            {hasChanges ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            onClick={() => setHasChanges(true)}
          >
            <RotateCcw aria-hidden="true" />
            Reset defaults
          </Button>
          <Button
            type="button"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={!hasChanges}
            onClick={() => setHasChanges(false)}
          >
            <Save aria-hidden="true" />
            Save changes
          </Button>
        </div>
      </div>
    </ActionBar>
  );
}

function ContentStart({
  section,
  settingsSection,
}: {
  section: Section;
  settingsSection: SettingsSection;
}) {
  const content = {
    dashboard: {
      eyebrow: 'Dashboard content',
      title: 'Security overview',
      description: 'Priority guidance and repository risk begin after the shared control surface.',
    },
    findings: {
      eyebrow: 'Findings content',
      title: 'Security Findings',
      description:
        'Results reflect state, scope, analysis outcome, and sort controls from the bar.',
    },
    'audit-report': {
      eyebrow: 'Audit report content',
      title: 'Recorded Security Finding activity',
      description:
        'Generated evidence follows the report filters without adding another control card.',
    },
    settings: {
      eyebrow: 'Settings content',
      title: settingsSections.find(item => item.value === settingsSection)?.label ?? 'General',
      description: 'Configuration starts below persistent section navigation and save actions.',
    },
  } satisfies Record<Section, { eyebrow: string; title: string; description: string }>;
  const activeContent = content[section];

  return (
    <section className="border-border mt-6 border-t pt-6">
      <p className="text-muted-foreground type-eyebrow">{activeContent.eyebrow}</p>
      <h2 className="type-heading mt-2">{activeContent.title}</h2>
      <p className="text-muted-foreground type-body mt-2 max-w-[65ch]">
        {activeContent.description}
      </p>
    </section>
  );
}

function UnifiedActionBarStory({ initialSection }: { initialSection: Section }) {
  const [activeSection, setActiveSection] = useState<Section>(initialSection);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');

  return (
    <main className="bg-surface-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-[1180px]">
        <Tabs
          value={activeSection}
          onValueChange={value => {
            const nextSection = sections.find(section => section.value === value);
            if (nextSection) setActiveSection(nextSection.value);
          }}
        >
          <TabsList
            aria-label="Security Agent sections"
            className="border-border h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0"
          >
            {sections.map(section => {
              const Icon = section.icon;
              return (
                <TabsTrigger key={section.value} value={section.value} className={sectionTabClass}>
                  <Icon className="size-4" aria-hidden="true" />
                  {section.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="dashboard" className="mt-8">
            <DashboardActionBar />
            <ContentStart section="dashboard" settingsSection={settingsSection} />
          </TabsContent>
          <TabsContent value="findings" className="mt-8">
            <FindingsActionBar />
            <ContentStart section="findings" settingsSection={settingsSection} />
          </TabsContent>
          <TabsContent value="audit-report" className="mt-8">
            <AuditReportActionBar />
            <ContentStart section="audit-report" settingsSection={settingsSection} />
          </TabsContent>
          <TabsContent value="settings" className="mt-8">
            <SettingsActionBar
              activeSection={settingsSection}
              onSectionChange={setSettingsSection}
            />
            <ContentStart section="settings" settingsSection={settingsSection} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

export const Dashboard: Story = {
  render: () => <UnifiedActionBarStory initialSection="dashboard" />,
};

export const Findings: Story = {
  render: () => <UnifiedActionBarStory initialSection="findings" />,
};

export const AuditReport: Story = {
  name: 'Audit report',
  render: () => <UnifiedActionBarStory initialSection="audit-report" />,
};

export const Settings: Story = {
  render: () => <UnifiedActionBarStory initialSection="settings" />,
};
