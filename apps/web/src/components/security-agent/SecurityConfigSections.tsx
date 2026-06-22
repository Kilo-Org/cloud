'use client';

import type { Dispatch, SetStateAction } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Clock,
  GitPullRequest,
  Info,
  Mail,
  ScanSearch,
  Settings,
} from 'lucide-react';
import { RepositoryMultiSelect } from '@/components/code-reviews/RepositoryMultiSelect';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type {
  AnalysisMode,
  AutoAnalysisMinSeverity,
  AutoDismissConfidenceThreshold,
  AutoRemediationMinSeverity,
  NotificationMinSeverity,
  SecurityConfigFormState,
  SecurityRepository,
  SlaConfig,
} from './security-config-types';
import { toRepositoryOptions } from './security-config-types';

type StateProps = {
  state: SecurityConfigFormState;
  setState: Dispatch<SetStateAction<SecurityConfigFormState>>;
};

type SectionHeaderProps = {
  icon: typeof Settings;
  title: string;
  description: string;
  titleAccessory?: React.ReactNode;
  action?: React.ReactNode;
  hasContent?: boolean;
};

function SectionHeader({
  icon: Icon,
  title,
  description,
  titleAccessory,
  action,
  hasContent = true,
}: SectionHeaderProps) {
  return (
    <CardHeader className={hasContent ? 'pb-3' : 'pb-6'}>
      <div
        className={cn(
          'flex flex-col gap-3 sm:flex-row sm:justify-between',
          hasContent ? 'sm:items-start' : 'sm:items-center'
        )}
      >
        <div className={cn('flex gap-3', hasContent ? 'items-start' : 'items-center')}>
          <div className="bg-surface-overlay text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg font-semibold">{title}</CardTitle>
              {titleAccessory}
            </div>
            <p className="text-muted-foreground text-xs">{description}</p>
          </div>
        </div>
        {action}
      </div>
    </CardHeader>
  );
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="bg-background border-border flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        <p id={`${id}-description`} className="text-muted-foreground text-sm">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-description`}
        className="shrink-0 self-end sm:self-auto"
      />
    </div>
  );
}

function SectionToggle({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="space-y-0.5 text-right">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <div id={`${id}-state`} className="text-muted-foreground text-xs font-medium">
          {checked ? 'On' : 'Off'}
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-state`}
      />
    </div>
  );
}

function SecondarySwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="bg-muted/20 border-border/60 flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p id={`${id}-description`} className="text-muted-foreground text-xs">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-description`}
        className="shrink-0 self-end sm:self-auto"
      />
    </div>
  );
}

type RadioOption<Value extends string> = {
  value: Value;
  label: string;
  description: string;
};

function OptionGrid<Value extends string>({
  name,
  value,
  options,
  columns,
  disabled,
  onChange,
}: {
  name: string;
  value: Value;
  options: RadioOption<Value>[];
  columns: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <RadioGroup value={value} onValueChange={next => onChange(next as Value)} className={columns}>
      {options.map(option => {
        const selected = value === option.value;

        return (
          <Label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={cn(
              'border-border bg-background hover:bg-muted flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
              selected &&
                'border-brand-primary/70 bg-brand-primary/15 hover:bg-brand-primary/20 ring-brand-primary/40 ring-1',
              disabled && 'cursor-not-allowed opacity-60 hover:bg-background'
            )}
          >
            <RadioGroupItem
              value={option.value}
              id={`${name}-${option.value}`}
              className={cn('mt-0.5', selected && 'border-brand-primary text-brand-primary')}
              disabled={disabled}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className={cn('block font-medium', selected && 'text-brand-primary')}>
                {option.label}
              </span>
              <span className="text-muted-foreground block min-h-10 text-xs leading-5 font-normal">
                {option.description}
              </span>
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );
}

const ANALYSIS_MODE_OPTIONS: RadioOption<AnalysisMode>[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Run triage first, then sandbox analysis only when needed (default).',
  },
  {
    value: 'shallow',
    label: 'Shallow (triage only)',
    description: 'Run quick triage without sandbox analysis to save time and credits.',
  },
  {
    value: 'deep',
    label: 'Deep (always sandbox)',
    description: 'Run full sandbox analysis for every finding.',
  },
];

const AUTO_ANALYSIS_OPTIONS: RadioOption<AutoAnalysisMinSeverity>[] = [
  { value: 'critical', label: 'Critical only', description: 'Analyze critical findings.' },
  { value: 'high', label: 'High and above', description: 'Analyze high and critical findings.' },
  {
    value: 'medium',
    label: 'Medium and above',
    description: 'Analyze medium, high, and critical findings.',
  },
  { value: 'all', label: 'All severities', description: 'Analyze every finding.' },
];

const AUTO_REMEDIATION_OPTIONS: RadioOption<AutoRemediationMinSeverity>[] = [
  {
    value: 'critical',
    label: 'Critical only',
    description: 'Open remediation PRs for critical exploitable findings.',
  },
  {
    value: 'high',
    label: 'High and above',
    description: 'Open remediation PRs for high and critical exploitable findings.',
  },
  {
    value: 'medium',
    label: 'Medium and above',
    description: 'Open remediation PRs for medium, high, and critical findings.',
  },
  {
    value: 'all',
    label: 'All severities',
    description: 'Open remediation PRs for every eligible exploitable finding.',
  },
];

const NOTIFICATION_SEVERITY_OPTIONS: RadioOption<NotificationMinSeverity>[] = [
  { value: 'critical', label: 'Critical only', description: 'Email for critical findings.' },
  { value: 'high', label: 'High and above', description: 'Email for high and critical findings.' },
  {
    value: 'medium',
    label: 'Medium and above',
    description: 'Email for medium, high, and critical findings.',
  },
  { value: 'low', label: 'Low and above', description: 'Email for every open severity.' },
];

const DISMISS_OPTIONS: RadioOption<AutoDismissConfidenceThreshold>[] = [
  {
    value: 'high',
    label: 'High confidence only',
    description: 'Dismiss only when AI confidence is high.',
  },
  {
    value: 'medium',
    label: 'Medium or higher',
    description: 'Dismiss when AI confidence is medium or high.',
  },
  {
    value: 'low',
    label: 'Any confidence',
    description: 'Dismiss every finding AI recommends dismissing. Use with caution.',
  },
];

export function RepositorySection({
  state,
  setState,
  repositories,
  isLoading,
}: StateProps & {
  repositories: SecurityRepository[];
  isLoading?: boolean;
}) {
  return (
    <Card>
      <SectionHeader
        icon={Settings}
        title="Repository selection"
        description="Choose which repositories Security Agent monitors."
      />
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="bg-muted border-border rounded-md border p-3 text-sm">
            Loading repositories...
          </div>
        ) : repositories.length === 0 ? (
          <div className="bg-muted border-border rounded-md border p-3 text-sm">
            No repositories found. Ensure GitHub App has access to your repositories.
          </div>
        ) : (
          <>
            <RadioGroup
              value={state.repositorySelectionMode}
              onValueChange={value =>
                setState(current => ({
                  ...current,
                  repositorySelectionMode: value === 'all' ? 'all' : 'selected',
                }))
              }
              className="space-y-3"
            >
              <div className="flex items-center gap-3">
                <RadioGroupItem value="all" id="all-repos" />
                <Label htmlFor="all-repos" className="cursor-pointer font-normal">
                  All repositories ({repositories.length})
                </Label>
              </div>
              <div className="flex items-center gap-3">
                <RadioGroupItem value="selected" id="selected-repos" />
                <Label htmlFor="selected-repos" className="cursor-pointer font-normal">
                  Selected repositories
                </Label>
              </div>
            </RadioGroup>
            {state.repositorySelectionMode === 'selected' && (
              <div className="space-y-2">
                <Label>Repositories</Label>
                <RepositoryMultiSelect
                  repositories={toRepositoryOptions(repositories)}
                  selectedIds={state.selectedRepositoryIds}
                  onSelectionChange={selectedRepositoryIds =>
                    setState(current => ({ ...current, selectedRepositoryIds }))
                  }
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentStatusSection({
  enabled,
  isToggling,
  availableRepositoryCount,
  repositoryCount,
  slaEnabled,
  onToggle,
}: {
  enabled: boolean;
  isToggling: boolean;
  availableRepositoryCount: number;
  repositoryCount: number;
  slaEnabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const description = enabled
    ? repositoryCount > 0
      ? `Sync Dependabot alerts every 6 hours for ${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}${slaEnabled ? ' and track SLAs' : ''}.`
      : 'Choose repositories below to begin syncing Dependabot alerts.'
    : availableRepositoryCount > 0
      ? 'Turn on Security Agent to choose repositories and start syncing Dependabot alerts.'
      : 'No repositories are available. Ensure GitHub App has access to your repositories.';

  return (
    <Card>
      <SectionHeader
        icon={Settings}
        title="Security Agent"
        description={description}
        hasContent={false}
        action={
          <SectionToggle
            id="security-agent-enabled"
            label="Enable Security Agent"
            checked={enabled}
            disabled={isToggling || availableRepositoryCount === 0}
            onCheckedChange={onToggle}
          />
        }
      />
    </Card>
  );
}

export function ModelSection({
  state,
  setState,
  models,
  isLoading,
}: StateProps & {
  models: Parameters<typeof ModelCombobox>[0]['models'];
  isLoading: boolean;
}) {
  return (
    <Card>
      <SectionHeader
        icon={Bot}
        title="AI models"
        description="Configure dedicated models for triage, analysis, and remediation."
      />
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div className="bg-background border-border rounded-lg border p-4">
          <ModelCombobox
            label="Triage model"
            models={models}
            value={state.triageModelSlug}
            onValueChange={triageModelSlug =>
              setState(current => ({ ...current, triageModelSlug }))
            }
            isLoading={isLoading}
            helperText="Used for initial triage and exploitability recommendations."
          />
        </div>
        <div className="bg-background border-border rounded-lg border p-4">
          <ModelCombobox
            label="Analysis model"
            models={models}
            value={state.analysisModelSlug}
            onValueChange={analysisModelSlug =>
              setState(current => ({ ...current, analysisModelSlug }))
            }
            isLoading={isLoading}
            helperText="Used for sandbox analysis and final extraction."
          />
        </div>
        <div className="bg-background border-border rounded-lg border p-4">
          <ModelCombobox
            label="Remediation model"
            models={models}
            value={state.remediationModelSlug}
            onValueChange={remediationModelSlug =>
              setState(current => ({ ...current, remediationModelSlug }))
            }
            isLoading={isLoading}
            helperText="Used by Cloud Agent when creating remediation PRs."
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function AnalysisModeSection({ state, setState }: StateProps) {
  return (
    <Card>
      <SectionHeader
        icon={ScanSearch}
        title="Analysis mode"
        description="Control vulnerability analysis depth."
      />
      <CardContent>
        <OptionGrid
          name="analysis-mode"
          value={state.analysisMode}
          options={ANALYSIS_MODE_OPTIONS}
          columns="grid gap-3 md:grid-cols-3"
          onChange={analysisMode => setState(current => ({ ...current, analysisMode }))}
        />
      </CardContent>
    </Card>
  );
}

export function AutoAnalysisSection({ state, setState }: StateProps) {
  return (
    <Card>
      <SectionHeader
        icon={ScanSearch}
        title="Auto-analysis"
        description="Automatically analyze findings as they are synced."
        hasContent={state.autoAnalysisEnabled}
        action={
          <SectionToggle
            id="auto-analysis-enabled"
            label="Enable auto-analysis"
            checked={state.autoAnalysisEnabled}
            onCheckedChange={autoAnalysisEnabled =>
              setState(current => ({ ...current, autoAnalysisEnabled }))
            }
          />
        }
      />
      {state.autoAnalysisEnabled && (
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Minimum severity</legend>
            <OptionGrid
              name="auto-analysis-severity"
              value={state.autoAnalysisMinSeverity}
              options={AUTO_ANALYSIS_OPTIONS}
              columns="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
              onChange={autoAnalysisMinSeverity =>
                setState(current => ({ ...current, autoAnalysisMinSeverity }))
              }
            />
          </fieldset>
          <SecondarySwitchRow
            id="auto-analysis-include-existing"
            label="Include existing findings"
            description="Also analyze previously synced findings. This may use additional credits."
            checked={state.autoAnalysisIncludeExisting}
            onCheckedChange={autoAnalysisIncludeExisting =>
              setState(current => ({ ...current, autoAnalysisIncludeExisting }))
            }
          />
        </CardContent>
      )}
    </Card>
  );
}

export function AutoRemediationSection({ state, setState }: StateProps) {
  return (
    <Card>
      <SectionHeader
        icon={GitPullRequest}
        title="Auto-remediation"
        description="Automatically open PRs for eligible exploitable findings."
        hasContent={state.autoRemediationEnabled}
        action={
          <SectionToggle
            id="auto-remediation-enabled"
            label="Enable auto-remediation"
            checked={state.autoRemediationEnabled}
            onCheckedChange={autoRemediationEnabled =>
              setState(current => ({ ...current, autoRemediationEnabled }))
            }
          />
        }
      />
      {state.autoRemediationEnabled && (
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Minimum severity</legend>
            <OptionGrid
              name="auto-remediation-severity"
              value={state.autoRemediationMinSeverity}
              options={AUTO_REMEDIATION_OPTIONS}
              columns="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
              onChange={autoRemediationMinSeverity =>
                setState(current => ({ ...current, autoRemediationMinSeverity }))
              }
            />
          </fieldset>
          <SecondarySwitchRow
            id="auto-remediation-include-existing"
            label="Include existing findings"
            description="Also queue already-analyzed eligible findings. Duplicate PRs stay suppressed."
            checked={state.autoRemediationIncludeExisting}
            onCheckedChange={autoRemediationIncludeExisting =>
              setState(current => ({ ...current, autoRemediationIncludeExisting }))
            }
          />
        </CardContent>
      )}
    </Card>
  );
}

export function AutoDismissSection({ state, setState }: StateProps) {
  return (
    <Card>
      <SectionHeader
        icon={AlertTriangle}
        title="Auto-dismiss"
        description="Automatically dismiss findings AI determines are not exploitable."
        hasContent={state.autoDismissEnabled}
        action={
          <SectionToggle
            id="auto-dismiss-enabled"
            label="Enable auto-dismiss"
            checked={state.autoDismissEnabled}
            onCheckedChange={autoDismissEnabled =>
              setState(current => ({ ...current, autoDismissEnabled }))
            }
          />
        }
      />
      {state.autoDismissEnabled && (
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Confidence threshold</legend>
            <OptionGrid
              name="dismiss-threshold"
              value={state.autoDismissConfidenceThreshold}
              options={DISMISS_OPTIONS}
              columns="grid gap-3 md:grid-cols-3"
              onChange={autoDismissConfidenceThreshold =>
                setState(current => ({ ...current, autoDismissConfidenceThreshold }))
              }
            />
          </fieldset>
        </CardContent>
      )}
    </Card>
  );
}

export function NotificationSection({
  state,
  setState,
  isOrganization,
  disabled,
}: StateProps & { isOrganization: boolean; disabled?: boolean }) {
  const newFindingLabel = isOrganization
    ? 'Email organization owners about new findings'
    : 'Email me about new findings';

  return (
    <Card>
      <SectionHeader
        icon={Mail}
        title="Finding Notifications"
        description={`${newFindingLabel}.`}
        hasContent={state.newFindingNotificationsEnabled}
        titleAccessory={
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About New-finding Notifications"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <Info className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
              Existing alerts imported on first sync count as new. New-finding notifications use
              minimum severity only.
            </TooltipContent>
          </Tooltip>
        }
        action={
          <SectionToggle
            id="new-finding-notifications-enabled"
            label={newFindingLabel}
            checked={state.newFindingNotificationsEnabled}
            disabled={disabled}
            onCheckedChange={newFindingNotificationsEnabled =>
              setState(current => ({ ...current, newFindingNotificationsEnabled }))
            }
          />
        }
      />
      {state.newFindingNotificationsEnabled && (
        <CardContent className="space-y-5">
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">New-finding minimum severity</legend>
            <OptionGrid
              name="new-finding-notification-severity"
              value={state.newFindingNotificationMinSeverity}
              options={NOTIFICATION_SEVERITY_OPTIONS}
              columns="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
              disabled={disabled}
              onChange={newFindingNotificationMinSeverity =>
                setState(current => ({ ...current, newFindingNotificationMinSeverity }))
              }
            />
          </fieldset>
        </CardContent>
      )}
    </Card>
  );
}

const SEVERITIES: Array<{
  key: keyof SlaConfig;
  label: string;
  description: string;
  icon: typeof Info;
}> = [
  {
    key: 'critical',
    label: 'Critical',
    description: 'Remote exploitation without authentication.',
    icon: AlertTriangle,
  },
  {
    key: 'high',
    label: 'High',
    description: 'Potential significant data exposure.',
    icon: AlertCircle,
  },
  {
    key: 'medium',
    label: 'Medium',
    description: 'Limited impact or specific conditions.',
    icon: Info,
  },
  { key: 'low', label: 'Low', description: 'Minimal security impact.', icon: Info },
];

export function SlaSection({
  state,
  setState,
  isOrganization,
  disabled,
}: StateProps & { isOrganization: boolean; disabled?: boolean }) {
  const slaLabel = isOrganization
    ? 'Email organization owners before and when findings breach SLA.'
    : 'Email me before and when findings breach SLA.';

  return (
    <Card>
      <SectionHeader
        icon={Clock}
        title="SLA Configuration"
        description="Set remediation deadlines and SLA notification rules."
        hasContent={state.slaEnabled}
        action={
          <SectionToggle
            id="sla-enabled"
            label="Enable SLA tracking"
            checked={state.slaEnabled}
            disabled={disabled}
            onCheckedChange={slaEnabled => setState(current => ({ ...current, slaEnabled }))}
          />
        }
      />
      {state.slaEnabled && (
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {SEVERITIES.map(({ key, label, description, icon: Icon }) => (
              <div
                key={key}
                className="bg-background border-border space-y-3 rounded-lg border p-4"
              >
                <div className="flex items-start gap-3">
                  <Icon
                    className="text-muted-foreground mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                  <div className="space-y-1">
                    <Label htmlFor={`sla-${key}`}>{label}</Label>
                    <p className="text-muted-foreground text-xs">{description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-8">
                  <Input
                    id={`sla-${key}`}
                    type="number"
                    min={1}
                    max={365}
                    value={state.slaConfig[key]}
                    disabled={disabled}
                    onChange={event => {
                      const value = Number.parseInt(event.target.value, 10);
                      if (Number.isNaN(value) || value < 1) return;
                      setState(current => ({
                        ...current,
                        slaConfig: { ...current.slaConfig, [key]: value },
                      }));
                    }}
                    className="w-20 text-center"
                    aria-describedby={`sla-${key}-unit`}
                  />
                  <span id={`sla-${key}-unit`} className="text-muted-foreground text-sm">
                    days
                  </span>
                </div>
              </div>
            ))}
          </div>

          <SwitchRow
            id="sla-notifications-enabled"
            label={slaLabel}
            description="Turn on warning and breach emails for findings that approach or pass SLA deadlines."
            checked={state.slaNotificationsEnabled}
            disabled={disabled}
            onCheckedChange={slaNotificationsEnabled =>
              setState(current => ({ ...current, slaNotificationsEnabled }))
            }
          />

          {state.slaNotificationsEnabled && (
            <>
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">SLA notification minimum severity</legend>
                <OptionGrid
                  name="sla-notification-severity"
                  value={state.slaNotificationMinSeverity}
                  options={NOTIFICATION_SEVERITY_OPTIONS}
                  columns="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
                  disabled={disabled}
                  onChange={slaNotificationMinSeverity =>
                    setState(current => ({ ...current, slaNotificationMinSeverity }))
                  }
                />
              </fieldset>

              <div className="bg-background border-border space-y-2 rounded-lg border p-4">
                <Label htmlFor="sla-notification-warning-days">SLA warning lead time</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="sla-notification-warning-days"
                    type="number"
                    min={1}
                    max={365}
                    value={state.slaNotificationWarningDays}
                    disabled={disabled}
                    onChange={event => {
                      const value = Number.parseInt(event.target.value, 10);
                      if (Number.isNaN(value) || value < 1 || value > 365) return;
                      setState(current => ({ ...current, slaNotificationWarningDays: value }));
                    }}
                    className="w-24 text-center"
                    aria-describedby="sla-notification-warning-days-help"
                  />
                  <span className="text-muted-foreground text-sm">days</span>
                </div>
                <p
                  id="sla-notification-warning-days-help"
                  className="text-muted-foreground text-xs"
                >
                  Send SLA Warning Notifications this many whole days before persisted deadline.
                </p>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
