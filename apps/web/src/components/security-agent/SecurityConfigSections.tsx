'use client';

import type { Dispatch, SetStateAction } from 'react';
import { AlertCircle, AlertTriangle, Bot, Clock, Info, ScanSearch, Settings } from 'lucide-react';
import { RepositoryMultiSelect } from '@/components/code-reviews/RepositoryMultiSelect';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type {
  AnalysisMode,
  AutoAnalysisMinSeverity,
  AutoDismissConfidenceThreshold,
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
  action?: React.ReactNode;
};

function SectionHeader({ icon: Icon, title, description, action }: SectionHeaderProps) {
  return (
    <CardHeader className="pb-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold">{title}</CardTitle>
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
  onChange,
}: {
  name: string;
  value: Value;
  options: RadioOption<Value>[];
  columns: string;
  onChange: (value: Value) => void;
}) {
  return (
    <RadioGroup value={value} onValueChange={next => onChange(next as Value)} className={columns}>
      {options.map(option => (
        <Label
          key={option.value}
          htmlFor={`${name}-${option.value}`}
          className={cn(
            'border-border bg-background hover:bg-muted flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
            value === option.value && 'bg-muted ring-ring ring-1'
          )}
        >
          <RadioGroupItem value={option.value} id={`${name}-${option.value}`} className="mt-0.5" />
          <span className="space-y-1">
            <span className="block font-medium">{option.label}</span>
            <span className="text-muted-foreground block text-xs font-normal">
              {option.description}
            </span>
          </span>
        </Label>
      ))}
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
  repositoryCount,
  onToggle,
}: {
  enabled: boolean;
  isToggling: boolean;
  repositoryCount: number;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <Card>
      <SectionHeader
        icon={Settings}
        title="Security Agent"
        description="Enable automatic Dependabot alert syncing and SLA tracking."
      />
      <CardContent>
        <SwitchRow
          id="security-agent-enabled"
          label="Enable Security Agent"
          description={
            repositoryCount > 0
              ? `Sync Dependabot alerts every 6 hours for ${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}.`
              : 'Select repositories above to enable Security Agent.'
          }
          checked={enabled}
          disabled={isToggling || repositoryCount === 0}
          onCheckedChange={onToggle}
        />
      </CardContent>
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
        description="Configure dedicated models for quick triage and deep analysis."
      />
      <CardContent className="grid gap-4 md:grid-cols-2">
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
      />
      <CardContent className="space-y-4">
        <SwitchRow
          id="auto-analysis-enabled"
          label="Enable auto-analysis"
          description="Automatically triage and analyze new findings using selected analysis mode."
          checked={state.autoAnalysisEnabled}
          onCheckedChange={autoAnalysisEnabled =>
            setState(current => ({ ...current, autoAnalysisEnabled }))
          }
        />
        {state.autoAnalysisEnabled && (
          <>
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
            <SwitchRow
              id="auto-analysis-include-existing"
              label="Include existing findings"
              description="Also analyze previously synced findings. This may use additional credits."
              checked={state.autoAnalysisIncludeExisting}
              onCheckedChange={autoAnalysisIncludeExisting =>
                setState(current => ({ ...current, autoAnalysisIncludeExisting }))
              }
            />
          </>
        )}
      </CardContent>
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
      />
      <CardContent className="space-y-4">
        <SwitchRow
          id="auto-dismiss-enabled"
          label="Enable auto-dismiss"
          description="Automatically dismiss findings AI recommends for dismissal."
          checked={state.autoDismissEnabled}
          onCheckedChange={autoDismissEnabled =>
            setState(current => ({ ...current, autoDismissEnabled }))
          }
        />
        {state.autoDismissEnabled && (
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
        )}
      </CardContent>
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

export function SlaSection({ state, setState }: StateProps) {
  return (
    <Card>
      <SectionHeader
        icon={Clock}
        title="SLA configuration"
        description="Set remediation deadlines by severity."
      />
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {SEVERITIES.map(({ key, label, description, icon: Icon }) => (
            <div key={key} className="bg-background border-border space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
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
      </CardContent>
    </Card>
  );
}
