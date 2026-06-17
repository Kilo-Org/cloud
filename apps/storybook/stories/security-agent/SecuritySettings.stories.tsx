'use client';

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { Bell, Bot, Check, Clock, RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import {
  AgentStatusSection,
  AnalysisModeSection,
  AutoAnalysisSection,
  AutoDismissSection,
  AutoRemediationSection,
  ModelSection,
  NotificationSection,
  RepositorySection,
  SlaSection,
} from '@/components/security-agent/SecurityConfigSections';
import type {
  SecurityConfigFormState,
  SecurityRepository,
} from '@/components/security-agent/security-config-types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const meta: Meta = {
  title: 'Security Agent/Settings',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Four focused Security Agent settings sections for repository scope, automation policy, notifications, and remediation deadlines.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;
type SettingsTab = 'general' | 'automation' | 'notifications' | 'sla';

const repositories: SecurityRepository[] = [
  {
    id: 101,
    fullName: 'Kilo-Org/cloud',
    name: 'cloud',
    private: true,
  },
  {
    id: 102,
    fullName: 'Kilo-Org/kilocode',
    name: 'kilocode',
    private: false,
  },
  {
    id: 103,
    fullName: 'Kilo-Org/kilocode-landing',
    name: 'kilocode-landing',
    private: false,
  },
  {
    id: 104,
    fullName: 'Kilo-Org/security-agent-testbed',
    name: 'security-agent-testbed',
    private: true,
  },
];

const models: ModelOption[] = [
  { id: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
];

const initialSettings: SecurityConfigFormState = {
  slaConfig: {
    critical: 15,
    high: 30,
    medium: 45,
    low: 90,
  },
  slaEnabled: true,
  repositorySelectionMode: 'selected',
  selectedRepositoryIds: [101, 102, 104],
  triageModelSlug: 'openai/gpt-5-mini',
  analysisModelSlug: 'anthropic/claude-sonnet-4.5',
  analysisMode: 'auto',
  autoDismissEnabled: true,
  autoDismissConfidenceThreshold: 'high',
  autoAnalysisEnabled: true,
  autoAnalysisMinSeverity: 'high',
  autoAnalysisIncludeExisting: false,
  autoRemediationEnabled: true,
  autoRemediationMinSeverity: 'high',
  autoRemediationIncludeExisting: false,
  remediationModelSlug: 'google/gemini-2.5-pro',
  slaNotificationsEnabled: true,
  slaNotificationMinSeverity: 'high',
  slaNotificationWarningDays: 3,
  newFindingNotificationsEnabled: true,
  newFindingNotificationMinSeverity: 'high',
};

const tabTriggerClass =
  'gap-2 border border-transparent px-3 py-2 text-muted-foreground hover:bg-surface-hover hover:text-foreground data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected data-[state=active]:text-foreground data-[state=active]:shadow-sm';

const tabs = [
  { value: 'general', label: 'General', icon: SlidersHorizontal },
  { value: 'automation', label: 'Automation', icon: Bot },
  { value: 'notifications', label: 'Notifications', icon: Bell },
  { value: 'sla', label: 'SLA', icon: Clock },
] satisfies Array<{ value: SettingsTab; label: string; icon: typeof SlidersHorizontal }>;

function SettingsPageShell({ children }: { children: ReactNode }) {
  return (
    <main className="bg-surface-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex max-w-3xl flex-col gap-2">
          <div className="text-muted-foreground type-eyebrow">Security Agent settings</div>
          <h1 className="type-title">Configure Security Agent</h1>
          <p className="text-muted-foreground type-body max-w-[70ch]">
            Choose repository scope, automation policy, notifications, and remediation deadlines for
            your organization.
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}

function SettingsSection({
  tab,
  state,
  setState,
}: {
  tab: SettingsTab;
  state: SecurityConfigFormState;
  setState: Dispatch<SetStateAction<SecurityConfigFormState>>;
}) {
  if (tab === 'general') {
    return (
      <div className="space-y-6">
        <AgentStatusSection
          enabled
          isToggling={false}
          availableRepositoryCount={repositories.length}
          repositoryCount={state.selectedRepositoryIds.length}
          slaEnabled={state.slaEnabled}
          onToggle={() => undefined}
        />
        <RepositorySection state={state} setState={setState} repositories={repositories} />
        <ModelSection state={state} setState={setState} models={models} isLoading={false} />
        <AnalysisModeSection state={state} setState={setState} />
      </div>
    );
  }

  if (tab === 'automation') {
    return (
      <div className="space-y-6">
        <AutoAnalysisSection state={state} setState={setState} />
        <AutoRemediationSection state={state} setState={setState} />
        <AutoDismissSection state={state} setState={setState} />
      </div>
    );
  }

  if (tab === 'notifications') {
    return <NotificationSection state={state} setState={setState} isOrganization />;
  }

  return <SlaSection state={state} setState={setState} isOrganization />;
}

function SecuritySettingsStory({ initialTab }: { initialTab: SettingsTab }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [state, setState] = useState<SecurityConfigFormState>(initialSettings);
  const [saved, setSaved] = useState(false);
  const setStateAndMarkUnsaved: Dispatch<SetStateAction<SecurityConfigFormState>> = update => {
    setSaved(false);
    setState(update);
  };

  return (
    <SettingsPageShell>
      <Tabs
        value={activeTab}
        onValueChange={value => {
          const nextTab = tabs.find(tab => tab.value === value)?.value;
          if (nextTab) setActiveTab(nextTab);
        }}
        className="space-y-6"
      >
        <TabsList
          aria-label="Security Agent settings sections"
          className="border-border bg-surface-raised h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border p-1.5 shadow-sm sm:w-fit"
        >
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} className={tabTriggerClass}>
                <Icon className="size-4" aria-hidden="true" />
                {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {tabs.map(tab => (
          <TabsContent key={tab.value} value={tab.value} className="mt-0">
            <SettingsSection tab={tab.value} state={state} setState={setStateAndMarkUnsaved} />
          </TabsContent>
        ))}
      </Tabs>

      <footer className="border-border flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setState(initialSettings);
            setSaved(false);
          }}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          Reset to defaults
        </Button>
        <Button type="button" onClick={() => setSaved(true)}>
          {saved ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Save className="size-4" aria-hidden="true" />
          )}
          {saved ? 'Changes saved' : 'Save changes'}
        </Button>
      </footer>
    </SettingsPageShell>
  );
}

export const General: Story = {
  render: () => <SecuritySettingsStory initialTab="general" />,
};

export const Automation: Story = {
  render: () => <SecuritySettingsStory initialTab="automation" />,
};

export const Notifications: Story = {
  render: () => <SecuritySettingsStory initialTab="notifications" />,
};

export const Sla: Story = {
  name: 'SLA',
  render: () => <SecuritySettingsStory initialTab="sla" />,
};
