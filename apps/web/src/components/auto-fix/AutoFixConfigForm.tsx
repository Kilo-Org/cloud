'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';

type AutoFixConfigFormProps = {
  organizationId?: string;
};

export function AutoFixConfigForm({ organizationId }: AutoFixConfigFormProps) {
  const trpc = useTRPC();

  // Fetch current config
  const {
    data: configData,
    isLoading,
    refetch,
  } = useQuery(
    organizationId
      ? trpc.organizations.autoFix.getAutoFixConfig.queryOptions({
          organizationId,
        })
      : trpc.personalAutoFix.getAutoFixConfig.queryOptions()
  );

  // Fetch GitHub repositories
  const {
    data: repositoriesData,
    isLoading: isLoadingRepositories,
    error: repositoriesError,
  } = useQuery(
    organizationId
      ? trpc.organizations.autoFix.listGitHubRepositories.queryOptions({
          organizationId,
        })
      : trpc.personalAutoFix.listGitHubRepositories.queryOptions()
  );

  // Fetch available models
  const { modelOptions, isLoadingModels } = useOrganizationModels(organizationId);

  // Local state
  const [isEnabled, setIsEnabled] = useState(false);
  const [repositorySelectionMode, setRepositorySelectionMode] = useState<'all' | 'selected'>('all');
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<number[]>([]);
  const [skipLabels, setSkipLabels] = useState<string>('');
  const [requiredLabels, setRequiredLabels] = useState<string>('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [selectedModel, setSelectedModel] = useState(PRIMARY_DEFAULT_MODEL);
  const [maxPRCreationTime, setMaxPRCreationTime] = useState([15]);
  const [prTitleTemplate, setPrTitleTemplate] = useState('Fix #{issue_number}: {issue_title}');
  const [enabledForReviewComments, setEnabledForReviewComments] = useState(false);
  const [prBodyTemplate, setPrBodyTemplate] = useState('');
  const [prBaseBranch, setPrBaseBranch] = useState('main');

  // Update local state when config loads
  useEffect(() => {
    if (configData) {
      setIsEnabled(configData.isEnabled);
      setEnabledForReviewComments(configData.enabled_for_review_comments ?? false);
      setRepositorySelectionMode(configData.repository_selection_mode || 'all');
      setSelectedRepositoryIds(configData.selected_repository_ids || []);
      setSkipLabels((configData.skip_labels || []).join(', '));
      setRequiredLabels((configData.required_labels || []).join(', '));
      setCustomInstructions(configData.custom_instructions || '');
      setSelectedModel(configData.model_slug);
      setMaxPRCreationTime([configData.max_pr_creation_time_minutes || 15]);
      setPrTitleTemplate(configData.pr_title_template || 'Fix #{issue_number}: {issue_title}');
      setPrBodyTemplate(configData.pr_body_template || '');
      setPrBaseBranch(configData.pr_base_branch || 'main');
    }
  }, [configData]);

  // Organization mutations
  const orgToggleMutation = useMutation(
    trpc.organizations.autoFix.toggleAutoFixAgent.mutationOptions({
      onSuccess: async data => {
        toast.success(data.isEnabled ? 'Auto Fix enabled' : 'Auto Fix disabled');
        setIsEnabled(data.isEnabled);
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle auto fix', {
          description: error.message,
        });
      },
    })
  );

  const orgSaveMutation = useMutation(
    trpc.organizations.autoFix.saveAutoFixConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Auto fix configuration saved');
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
    trpc.personalAutoFix.toggleAutoFixAgent.mutationOptions({
      onSuccess: async data => {
        if (data.success) {
          toast.success(data.isEnabled ? 'Auto Fix enabled' : 'Auto Fix disabled');
          setIsEnabled(data.isEnabled);
        }
        await refetch();
      },
      onError: error => {
        toast.error('Failed to toggle auto fix', {
          description: error.message,
        });
      },
    })
  );

  const personalSaveMutation = useMutation(
    trpc.personalAutoFix.saveAutoFixConfig.mutationOptions({
      onSuccess: async () => {
        toast.success('Auto fix configuration saved');
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
    // When toggling the main switch, we also need to save the config
    // to update enabled_for_issues to match
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
        enabled_for_review_comments: enabledForReviewComments,
        repository_selection_mode: repositorySelectionMode,
        selected_repository_ids: selectedRepositoryIds,
        skip_labels: skipLabelsArray,
        required_labels: requiredLabelsArray,
        custom_instructions: customInstructions.trim() || null,
        model_slug: selectedModel,
        max_pr_creation_time_minutes: maxPRCreationTime[0],
        pr_title_template: prTitleTemplate,
        pr_body_template: prBodyTemplate.trim() || null,
        pr_base_branch: prBaseBranch,
      });
    } else {
      personalSaveMutation.mutate({
        enabled_for_issues: isEnabled,
        enabled_for_review_comments: enabledForReviewComments,
        repository_selection_mode: repositorySelectionMode,
        selected_repository_ids: selectedRepositoryIds,
        skip_labels: skipLabelsArray,
        required_labels: requiredLabelsArray,
        custom_instructions: customInstructions.trim() || null,
        model_slug: selectedModel,
        max_pr_creation_time_minutes: maxPRCreationTime[0],
        pr_title_template: prTitleTemplate,
        pr_body_template: prBodyTemplate.trim() || null,
        pr_base_branch: prBaseBranch,
      });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Auto Fix Configuration
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
          Auto Fix Configuration
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-8">
          {/* Enable/Disable Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enable-agent" className="text-base font-semibold">
                Enable AI Auto Fix
              </Label>
              <p className="text-muted-foreground text-sm">
                Automatically create pull requests for GitHub issues labeled with kilo-auto-fix
              </p>
            </div>
            <Switch
              id="enable-agent"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={orgToggleMutation.isPending || personalToggleMutation.isPending}
            />
          </div>

          {/* Review Comments Toggle */}
          <div
            className={cn(
              'flex items-center justify-between rounded-lg border p-4',
              !isEnabled && 'pointer-events-none opacity-50'
            )}
          >
            <div className="space-y-0.5">
              <Label htmlFor="enable-review-comments" className="text-base font-semibold">
                Fix PR Review Comments
              </Label>
              <p className="text-muted-foreground text-sm">
                Respond to <code className="bg-muted rounded px-1 py-0.5">@kilo fix</code> mentions
                in PR review comments with scoped code changes
              </p>
            </div>
            <Switch
              id="enable-review-comments"
              checked={enabledForReviewComments}
              onCheckedChange={setEnabledForReviewComments}
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
              helperText="Al model to use for creating pull requests"
            />

            {/* Repository Selection */}
            <div className="space-y-3">
              <Label>Repository Selection</Label>
              <p className="text-muted-foreground text-sm">
                Repositories to automatically create pull requests for
              </p>

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
                Comma-separated list of labels that should skip auto fix
              </p>
            </div>

            {/* Required Labels */}
            <div className="space-y-3">
              <Label htmlFor="required-labels">Required Labels (Optional)</Label>
              <Input
                id="required-labels"
                placeholder="e.g., needs-fix, bug, feature"
                value={requiredLabels}
                onChange={e => setRequiredLabels(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                Comma-separated list of labels that must be present for auto fix to proceed
              </p>
            </div>

            {/* PR Configuration */}
            <div className="space-y-6">
              <div className="space-y-3">
                <Label htmlFor="pr-title-template">PR Title Template</Label>
                <Input
                  id="pr-title-template"
                  placeholder="Fix #{issue_number}: {issue_title}"
                  value={prTitleTemplate}
                  onChange={e => setPrTitleTemplate(e.target.value)}
                />
                <p className="text-muted-foreground text-sm">
                  Template for PR titles. Available variables: {'{issue_number}'}, {'{issue_title}'}
                </p>
              </div>

              <div className="space-y-3">
                <Label htmlFor="pr-body-template">PR Body Template (Optional)</Label>
                <Textarea
                  id="pr-body-template"
                  placeholder="Fixes #{issue_number}&#10;&#10;This PR was automatically created by Kilo Auto Fix."
                  value={prBodyTemplate}
                  onChange={e => setPrBodyTemplate(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
                <p className="text-muted-foreground text-sm">
                  Template for PR descriptions. Available variables: {'{issue_number}'},{' '}
                  {'{issue_title}'}, {'{issue_url}'}
                </p>
              </div>

              <div className="space-y-3">
                <Label htmlFor="pr-base-branch">PR Base Branch</Label>
                <Input
                  id="pr-base-branch"
                  placeholder="main"
                  value={prBaseBranch}
                  onChange={e => setPrBaseBranch(e.target.value)}
                />
                <p className="text-muted-foreground text-sm">
                  Target branch for pull requests (e.g., main, master, develop)
                </p>
              </div>
            </div>

            {/* Timeout Configuration */}
            <div className="space-y-3">
              <Label>Maximum PR Creation Time: {maxPRCreationTime[0]} minutes</Label>
              <Slider
                value={maxPRCreationTime}
                onValueChange={setMaxPRCreationTime}
                min={5}
                max={30}
                step={1}
                className="w-full"
              />
              <p className="text-muted-foreground text-sm">
                Timeout for PR creation workflow (5-30 minutes)
              </p>
            </div>

            {/* Custom Instructions */}
            <div className="space-y-3">
              <Label htmlFor="custom-instructions">Custom Instructions (Optional)</Label>
              <Textarea
                id="custom-instructions"
                placeholder="e.g., 'Always add tests for bug fixes' or 'Follow the team's coding style guide'"
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-muted-foreground text-sm">
                Add specific guidelines for PR creation and code changes
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
