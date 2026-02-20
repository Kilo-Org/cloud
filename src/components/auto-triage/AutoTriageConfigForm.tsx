'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Settings, Save } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useState, useEffect } from 'react';
import { useOrganizationModels } from '@/components/cloud-agent/hooks/useOrganizationModels';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { cn } from '@/lib/utils';
import {
  RepositoryMultiSelect,
  type Repository,
} from '@/components/code-reviews/RepositoryMultiSelect';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';

type AutoTriageConfigFormProps = {
  organizationId?: string;
};

export function AutoTriageConfigForm({ organizationId }: AutoTriageConfigFormProps) {
  const trpc = useTRPC();

  // Fetch current config
  const {
    data: configData,
    isLoading,
    refetch,
  } = useQuery(
    organizationId
      ? trpc.organizations.autoTriage.getAutoTriageConfig.queryOptions({
          organizationId,
        })
      : trpc.personalAutoTriage.getAutoTriageConfig.queryOptions()
  );

  // Fetch GitHub repositories
  const {
    data: repositoriesData,
    isLoading: isLoadingRepositories,
    error: repositoriesError,
  } = useQuery(
    organizationId
      ? trpc.organizations.autoTriage.listGitHubRepositories.queryOptions({
          organizationId,
        })
      : trpc.personalAutoTriage.listGitHubRepositories.queryOptions()
  );

  // Fetch available models
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);

  // Local state
  const [isEnabled, setIsEnabled] = useState(false);
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>('all');
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([]);
  const [skipLabels, setSkipLabels] = useState<string>('');
  const [requiredLabels, setRequiredLabels] = useState<string>('');
  const [duplicateThreshold, setDuplicateThreshold] = useState([0.8]);
  const [autoFixThreshold, setAutoFixThreshold] = useState([0.9]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedModel, setSelectedModel] = useState(PRIMARY_DEFAULT_MODEL);
  const [maxClassificationTime, setMaxClassificationTime] = useState([5]);

  // Update local state when config loads
  useEffect(() => {
    if (configData) {
      setIsEnabled(configData.isEnabled);
      setRepositorySelectionMode(configData.repository_selection_mode || 'all');
      setSelectedRepositoryIds(configData.selected_repository_ids || []);
      setSkipLabels((configData.skip_labels || []).join(', '));
      setRequiredLabels((configData.required_labels || []).join(', '));
      setDuplicateThreshold([parseFloat(String(configData.duplicate_threshold)) || 0.8]);
      setAutoFixThreshold([parseFloat(String(configData.auto_fix_threshold)) || 0.9]);
      setCustomInstructions(configData.custom_instructions || '');
      setSelectedModel(configData.model_slug);
      setMaxClassificationTime([configData.max_classification_time_minutes || 5]);
    }
  }, [configData]);

  // Organization mutations
  const orgToggleMutation = useMutation(
    trpc.organizations.autoTriage.toggleAutoTriageAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Auto Triage enabled' : 'Auto Triage disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle auto triage', {
          description: error.message,
        });
      },
    })
  );

  const orgSaveMutation = useMutation(
    trpc.organizations.autoTriage.saveAutoTriageConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Auto triage configuration saved');
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  // Personal mutations
  const personalToggleMutation = useMutation(
    trpc.personalAutoTriage.toggleAutoTriageAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Auto Triage enabled' : 'Auto Triage disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle auto triage', {
          description: error.message,
        });
      },
    })
  );

  const personalSaveMutation = useMutation(
    trpc.personalAutoTriage.saveAutoTriageConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Auto triage configuration saved');
        await refetch();
      },
      onError: error => {
        toast.error('Failed to save configuration', {
          description: error.message,
        });
      },
    })
  );

  const handleToggle = (checked: boolean) => {
    if (organizationId) {
      orgToggleMutation.mutate({
        organizationId,
        isEnabled: checked,
      });
    } else {
      personalToggleMutation.mutate({
        isEnabled: checked,
      });
    }
  };

  const handleSave = () => {
    const skipLabelsArray = skipLabels
      .split(',')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const requiredLabelsArray = requiredLabels
      .split(',')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (organizationId) {
      orgSaveMutation.mutate({
        organizationId,
        enabled_for_issues: isEnabled,
        repository_selection_mode: repositorySelectionMode,
        selected_repository_ids: selectedRepositoryIds,
        skip_labels: skipLabelsArray,
        required_labels: requiredLabelsArray,
        duplicate_threshold: duplicateThreshold[0],
        auto_fix_threshold: autoFixThreshold[0],
        custom_instructions: customInstructions.trim() || null,
        model_slug: selectedModel,
        max_classification_time_minutes: maxClassificationTime[0],
      });
    } else {
      personalSaveMutation.mutate({
        enabled_for_issues: isEnabled,
        repository_selection_mode: repositorySelectionMode,
        selected_repository_ids: selectedRepositoryIds,
        skip_labels: skipLabelsArray,
        required_labels: requiredLabelsArray,
        duplicate_threshold: duplicateThreshold[0],
        auto_fix_threshold: autoFixThreshold[0],
        custom_instructions: customInstructions.trim() || null,
        model_slug: selectedModel,
        max_classification_time_minutes: maxClassificationTime[0],
      });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Auto Triage Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-4">
            <div className="bg-muted h-20 rounded" />
            <div className="bg-muted h-32 rounded" />
            <div className="bg-muted h-20 rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="mb-4">
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Auto Triage Configuration
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-8">
          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enable-agent" className="text-base font-semibold">
                Enable AI Auto Triage
              </Label>
              <p className="text-muted-foreground text-sm">
                Automatically triage GitHub issues when they are opened or updated
              </p>
            </div>
            <Switch
              id="enable-agent"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={orgToggleMutation.isPending || personalToggleMutation.isPending}
            />
          </div>

          {/* Configuration Fields */}
          <div className={cn('space-y-8', !isEnabled && 'pointer-events-none opacity-50')}>
            {/* AI Model Selection */}
            <ModelCombobox
              label="AI Model"
              models={modelOptions}
              value={selectedModel}
              onValueChange={setSelectedModel}
              isLoading={isLoadingModels}
              helperText="Al model to use for issue classification and analysis"
            />

            {/* Repository Selection */}
            <div className="space-y-3">
              <Label>Repository Selection</Label>
              <p className="text-muted-foreground text-sm">Repositories to automatically triage</p>

              {isLoadingRepositories ? (
                <div className="rounded-md border border-gray-600 bg-gray-800/50 p-3">
                  <p className="text-sm text-gray-400">Loading repositories...</p>
                </div>
              ) : repositoriesError ? (
                <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3">
                  <p className="text-sm text-red-200">
                    Failed to load repositories. Please try refreshing the page.
                  </p>
                </div>
              ) : !repositoriesData?.integrationInstalled ? (
                <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                  <p className="text-sm text-yellow-200">
                    {repositoriesData?.errorMessage ||
                      'GitHub integration is not connected. Please connect GitHub in the Integrations page to configure repository selection.'}
                  </p>
                </div>
              ) : repositoriesData.repositories.length === 0 ? (
                <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                  <p className="text-sm text-yellow-200">
                    No repositories found. Please ensure the GitHub App has access to your
                    repositories.
                  </p>
                </div>
              ) : (
                <>
                  <RadioGroup
                    value={repositorySelectionMode}
                    onValueChange={value => setRepositorySelectionMode(value as 'all' | 'selected')}
                    className="space-y-3"
                  >
                    <div className="flex items-center space-x-3">
                      <RadioGroupItem value="all" id="all-repos" />
                      <Label htmlFor="all-repos" className="cursor-pointer font-normal">
                        All repositories ({repositoriesData.repositories.length})
                      </Label>
                    </div>
                    <div className="flex items-start space-x-3">
                      <RadioGroupItem value="selected" id="selected-repos" className="mt-1" />
                      <Label htmlFor="selected-repos" className="cursor-pointer font-normal">
                        Selected repositories
                      </Label>
                    </div>
                  </RadioGroup>

                  {repositorySelectionMode === 'selected' && (
                    <div className="mt-4">
                      <RepositoryMultiSelect
                        repositories={
                          repositoriesData.repositories.map(repo => ({
                            id: repo.id,
                            name: repo.name,
                            full_name: repo.fullName,
                            private: repo.private,
                          })) as Repository[]
                        }
                        selectedIds={selectedRepositoryIds}
                        onSelectionChange={setSelectedRepositoryIds}
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Skip Labels */}
            <div className="space-y-3">
              <Label htmlFor="skip-labels">Skip Labels (Optional)</Label>
              <Input
                id="skip-labels"
                placeholder="e.g., wontfix, duplicate, invalid"
                value={skipLabels}
                onChange={e => setSkipLabels(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                Comma-separated list of labels that should skip auto triage
              </p>
            </div>

            {/* Required Labels */}
            <div className="space-y-3">
              <Label htmlFor="required-labels">Required Labels (Optional)</Label>
              <Input
                id="required-labels"
                placeholder="e.g., needs-triage, bug, feature"
                value={requiredLabels}
                onChange={e => setRequiredLabels(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                Comma-separated list of labels that must be present for auto triage to proceed
              </p>
            </div>

            {/* Duplicate Detection Threshold */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Duplicate Detection Threshold</Label>
                <span className="text-muted-foreground text-sm font-medium">
                  {Math.round(duplicateThreshold[0] * 100)}%
                </span>
              </div>
              <Slider
                min={0.5}
                max={1.0}
                step={0.05}
                value={duplicateThreshold}
                onValueChange={setDuplicateThreshold}
              />
              <p className="text-muted-foreground text-sm">
                Issues with similarity above this threshold will be flagged as duplicates. Higher
                values reduce false positives but may miss some duplicates.
              </p>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={orgSaveMutation.isPending || personalSaveMutation.isPending || !isEnabled}
              >
                <Save className="mr-2 h-4 w-4" />
                {orgSaveMutation.isPending || personalSaveMutation.isPending
                  ? 'Saving...'
                  : 'Save Configuration'}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
