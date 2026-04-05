'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { useRefreshRepositories } from '@/hooks/useRefreshRepositories';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/Button';
import { Button as UIButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, ExternalLink, Plus, AlertTriangle, RefreshCw, Info } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { validateBranch } from '@/lib/user-deployments/validation';
import { RepositoryCombobox, type RepositoryOption } from '@/components/shared/RepositoryCombobox';
import { BranchCombobox, type BranchOption } from '@/components/shared/BranchCombobox';
import { EnvVarInput, type EnvVarInputValue } from './EnvVarInput';
import {
  PasswordProtection,
  validatePasswordForm,
  type PasswordFormState,
} from './PasswordFormFields';
import Link from 'next/link';
import { useDeploymentQueries } from './DeploymentContext';
import { useQuery } from '@tanstack/react-query';
import { envVarKeySchema } from '@/lib/user-deployments/env-vars-validation';

type NewDeploymentDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  organizationId?: string | null;
};

type ValidationErrors = {
  branch?: string;
};

export function NewDeploymentDialog({
  isOpen,
  onClose,
  onSuccess,
  organizationId,
}: NewDeploymentDialogProps) {
  // Form state
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>('');
  const [selectedRepository, setSelectedRepository] = useState<string>('');
  const [branch, setBranch] = useState('main');
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [touched, setTouched] = useState<{ branch: boolean }>({ branch: false });
  const [envVars, setEnvVars] = useState<EnvVarInputValue[]>([]);
  const [activeTab, setActiveTab] = useState<'repository' | 'environment' | 'password'>(
    'repository'
  );
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>({
    password: '',
    confirmPassword: '',
    enabled: false,
  });

  const { queries: deploymentQueries, mutations } = useDeploymentQueries();

  // Check if password features are available (org-only)
  const hasPasswordFeature = !!mutations.setPassword;

  // Check deployment eligibility through the deployment context
  const { data: deploymentEligibility } = deploymentQueries.checkDeploymentEligibility();
  const canCreateDeployment = deploymentEligibility?.canCreateDeployment ?? true;
  const creditsPageUrl = organizationId ? `/organizations/${organizationId}` : '/credits';
  const trpc = useTRPC();
  const orgId = organizationId ?? undefined;
  const ghInput = orgId ? { organizationId: orgId } : undefined;

  // Query integrations using direct tRPC calls
  const {
    data: integrations,
    isLoading: isLoadingIntegration,
    error: integrationError,
  } = useQuery(trpc.githubApps.listIntegrations.queryOptions(ghInput));

  // Get the selected integration
  const selectedIntegration = integrations?.find(i => i.id === selectedIntegrationId);

  // Query repositories for the selected integration
  const {
    data: repositories,
    isLoading: isLoadingRepositories,
    error: repositoriesError,
  } = useQuery({
    ...trpc.githubApps.listRepositories.queryOptions({
      organizationId: orgId,
      integrationId: selectedIntegrationId,
      forceRefresh: false,
    }),
    enabled: !!selectedIntegrationId,
  });

  // Query branches for the selected repository
  const {
    data: branchesData,
    isLoading: isLoadingBranches,
    error: branchesError,
  } = useQuery({
    ...trpc.githubApps.listBranches.queryOptions({
      organizationId: orgId,
      integrationId: selectedIntegrationId,
      repositoryFullName: selectedRepository,
    }),
    enabled: !!selectedIntegrationId && !!selectedRepository,
  });

  // Transform repositories to match RepositoryOption format
  const repositoryOptions: RepositoryOption[] =
    repositories?.repositories?.map(repo => ({
      id: repo.id,
      fullName: repo.full_name,
      private: repo.private,
    })) ?? [];

  // Transform branches to match BranchOption format
  const branchOptions: BranchOption[] = branchesData?.branches ?? [];

  // Track if we should use the fallback text input (when branch fetching fails)
  const useBranchFallback = !!branchesError;

  // Auto-select integration if there's only one
  useEffect(() => {
    if (integrations && integrations.length === 1 && !selectedIntegrationId) {
      setSelectedIntegrationId(integrations[0].id);
    }
  }, [integrations, selectedIntegrationId]);

  // Auto-select default branch when branches are loaded
  useEffect(() => {
    if (branchesData?.branches && branchesData.branches.length > 0) {
      const defaultBranch = branchesData.branches.find(b => b.isDefault);
      if (defaultBranch) {
        setBranch(defaultBranch.name);
      } else {
        // If no default branch marked, use the first one
        setBranch(branchesData.branches[0].name);
      }
    }
  }, [branchesData?.branches]);

  // Reset branch when repository changes
  useEffect(() => {
    if (!selectedRepository) {
      setBranch('main');
    }
  }, [selectedRepository]);

  // Refresh repositories hook
  const { refresh: refreshRepositories, isRefreshing: isRefreshingRepos } = useRefreshRepositories({
    getRefreshQueryOptions: useCallback(
      () =>
        trpc.githubApps.listRepositories.queryOptions({
          organizationId: orgId,
          integrationId: selectedIntegrationId,
          forceRefresh: true,
        }),
      [orgId, selectedIntegrationId, trpc]
    ),
    getCacheQueryKey: useCallback(
      () =>
        trpc.githubApps.listRepositories.queryKey({
          organizationId: orgId,
          integrationId: selectedIntegrationId,
          forceRefresh: false,
        }),
      [orgId, selectedIntegrationId, trpc]
    ),
  });

  const createDeploymentMutation = mutations.createDeployment;

  const handleClose = () => {
    setSelectedIntegrationId('');
    setSelectedRepository('');
    setBranch('main');
    setErrors({});
    setTouched({ branch: false });
    setEnvVars([]);
    setActiveTab('repository');
    setPasswordForm({ password: '', confirmPassword: '', enabled: false });
    onClose();
  };

  const validateField = (field: 'branch', value: string) => {
    const error = validateBranch(value);
    setErrors(prev => ({ ...prev, [field]: error }));
    return !error;
  };

  const handleBranchChange = (value: string) => {
    setBranch(value);
    if (touched.branch) {
      validateField('branch', value);
    }
  };

  const handleBranchBlur = () => {
    setTouched(prev => ({ ...prev, branch: true }));
    validateField('branch', branch);
  };

  const handleAddEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '', isSecret: false }]);
  };

  const handleRemoveEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const handleEnvVarChange = (index: number, value: EnvVarInputValue) => {
    const newEnvVars = [...envVars];
    newEnvVars[index] = value;
    setEnvVars(newEnvVars);
  };

  const validatePassword = () => {
    const result = validatePasswordForm(passwordForm);
    if (!result.valid) {
      toast.error(result.error);
      return false;
    }
    return true;
  };

  const validateEnvVars = () => {
    // Validate all env var keys
    for (const envVar of envVars) {
      if (envVar.key || envVar.value) {
        // Only validate if either key or value is filled
        if (!envVar.key) {
          toast.error('Environment variable key cannot be empty');
          return false;
        }
        if (!envVar.value) {
          toast.error('Environment variable value cannot be empty');
          return false;
        }
        try {
          envVarKeySchema.parse(envVar.key);
        } catch (err) {
          if (err && typeof err === 'object' && 'errors' in err) {
            const zodError = err as { errors: Array<{ message: string }> };
            toast.error(zodError.errors[0]?.message || 'Invalid environment variable key');
          } else {
            toast.error('Invalid environment variable key');
          }
          return false;
        }
      }
    }
    return true;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Mark all fields as touched
    setTouched({ branch: true });

    // Validate all fields
    const branchValid = validateField('branch', branch);

    if (!branchValid || !selectedRepository) {
      return;
    }

    if (!selectedIntegrationId) {
      toast.error('Please select a repository');
      return;
    }

    // Validate env vars
    if (!validateEnvVars()) {
      return;
    }

    // Validate password if enabled
    if (!validatePassword()) {
      return;
    }

    // Filter out empty env vars
    const validEnvVars = envVars.filter(ev => ev.key && ev.value);

    createDeploymentMutation.mutate(
      {
        platformIntegrationId: selectedIntegrationId,
        repositoryFullName: selectedRepository,
        branch,
        envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
      },
      {
        onSuccess: result => {
          if (result.success) {
            // If password protection is enabled, set it after deployment is created
            if (passwordForm.enabled && passwordForm.password && mutations.setPassword) {
              mutations.setPassword.mutate(
                { deploymentId: result.deploymentId, password: passwordForm.password },
                {
                  onSuccess: () => {
                    toast.success('Deployment created with password protection!');
                    handleClose();
                    onSuccess();
                  },
                  onError: error => {
                    // Show persistent warning - deployment is public but password protection failed
                    toast.warning(
                      'Deployment created but is currently PUBLIC. Password protection failed - please enable it in deployment settings.',
                      {
                        description: error.message,
                        duration: 10000, // Show for 10 seconds to ensure user sees it
                      }
                    );
                    handleClose();
                    onSuccess();
                  },
                }
              );
            } else {
              toast.success('Deployment created!');
              handleClose();
              onSuccess();
            }
          } else if (result.error === 'payment_required') {
            toast('Payment required to create deployments.', {
              description: 'Visit the billing page to add a payment method.',
            });
          }
        },
        onError: error => {
          // Only for actual unexpected errors
          toast.error(`Failed to create deployment: ${error.message}`);
        },
      }
    );
  };

  const isFormValid =
    !errors.branch && selectedIntegrationId && selectedRepository && branch && canCreateDeployment;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="!top-[50%] !left-[50%] flex max-h-[90vh] !translate-x-[-50%] !translate-y-[-50%] flex-col gap-0 overflow-hidden p-0 sm:max-w-[500px]">
        <div className="p-6 pb-2">
          <DialogHeader>
            <DialogTitle>Create New Deployment</DialogTitle>
          </DialogHeader>
          {!canCreateDeployment && (
            <Alert variant="warning" className="mt-3">
              <AlertTriangle className="size-4" />
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>You need to add credits to your account to create deployments.</span>
                <Link href={creditsPageUrl}>
                  <Button variant="secondary" size="sm" className="shrink-0">
                    Add Credits
                  </Button>
                </Link>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <form
          id="create-deployment-form"
          onSubmit={handleSubmit}
          className="flex-1 overflow-hidden"
          autoComplete="off"
        >
          <Tabs
            value={activeTab}
            onValueChange={value =>
              setActiveTab(value as 'repository' | 'environment' | 'password')
            }
            className="flex h-full flex-col"
          >
            <div className="px-6">
              <TabsList
                className={cn('grid w-full', hasPasswordFeature ? 'grid-cols-3' : 'grid-cols-2')}
              >
                <TabsTrigger value="repository">Repository</TabsTrigger>
                <TabsTrigger value="environment">Environment</TabsTrigger>
                {hasPasswordFeature && <TabsTrigger value="password">Password</TabsTrigger>}
              </TabsList>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <TabsContent value="repository" className="mt-0 space-y-4">
                {/* Integration */}
                <div className="space-y-2">
                  <Label htmlFor="integration">
                    Integration <span className="text-red-400">*</span>
                  </Label>
                  {isLoadingIntegration ? (
                    <>
                      <Skeleton className="h-9 w-full" />
                      <p className="text-xs text-gray-500">Loading integrations...</p>
                    </>
                  ) : integrationError ? (
                    <>
                      <div className="rounded-md border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm text-red-400">
                        Failed to load integrations: {integrationError.message}
                      </div>
                      <p className="text-xs text-gray-500">Please try again or contact support</p>
                    </>
                  ) : !integrations || integrations.length === 0 ? (
                    <>
                      <div className="rounded-md border border-gray-600 bg-gray-800/50 px-3 py-2 text-sm text-gray-400">
                        No integrations available
                      </div>
                      <p className="text-xs text-gray-500">
                        Install an integration to deploy from your repositories.{' '}
                        <Link
                          href={
                            organizationId
                              ? `/organizations/${organizationId}/integrations`
                              : '/integrations'
                          }
                          target="_blank"
                          className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        >
                          Manage Integrations
                          <ExternalLink className="size-3" />
                        </Link>
                      </p>
                    </>
                  ) : (
                    <>
                      <Select
                        value={selectedIntegrationId}
                        onValueChange={setSelectedIntegrationId}
                      >
                        <SelectTrigger id="integration" className="w-full">
                          <SelectValue placeholder="Select an integration" />
                        </SelectTrigger>
                        <SelectContent>
                          {integrations.map(integration => (
                            <SelectItem key={integration.id} value={integration.id}>
                              {integration.platform_account_login || integration.platform} (
                              {integration.platform})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-gray-500">Select the integration to deploy from</p>
                    </>
                  )}
                </div>

                {/* Repository Selection */}
                {selectedIntegration && !selectedIntegration.suspended_at && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>
                        Repository <span className="text-red-400">*</span>
                      </Label>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          Last synced:{' '}
                          {repositories?.syncedAt
                            ? formatDistanceToNow(new Date(repositories.syncedAt), {
                                addSuffix: true,
                              })
                            : 'Never'}
                        </span>
                        <UIButton
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={refreshRepositories}
                          disabled={isRefreshingRepos}
                        >
                          <RefreshCw
                            className={cn('h-4 w-4', isRefreshingRepos && 'animate-spin')}
                          />
                        </UIButton>
                      </div>
                    </div>
                    <RepositoryCombobox
                      helperText="Select the repository you want to deploy"
                      repositories={repositoryOptions}
                      value={selectedRepository}
                      onValueChange={setSelectedRepository}
                      isLoading={isLoadingRepositories}
                      error={repositoriesError?.message}
                      placeholder="Select a repository"
                      searchPlaceholder="Search repositories..."
                      required
                      hideLabel
                    />
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-gray-400">
                      <Info className="mt-0.5 size-3 shrink-0" />
                      Supports Next.js (v14–16) and static sites (HTML/CSS/JS, Hugo, Jekyll,
                      Eleventy)
                    </p>
                  </div>
                )}

                {/* Branch Selection */}
                {selectedRepository && (
                  <div className="space-y-2">
                    {useBranchFallback ? (
                      // Fallback to text input when branch fetching fails
                      <>
                        <Label htmlFor="branch">
                          Branch <span className="text-red-400">*</span>
                        </Label>
                        <Input
                          id="branch"
                          type="text"
                          value={branch}
                          onChange={e => handleBranchChange(e.target.value)}
                          onBlur={handleBranchBlur}
                          placeholder="main"
                          disabled={createDeploymentMutation.isPending}
                          aria-invalid={touched.branch && !!errors.branch}
                          className="font-mono"
                          autoComplete="off"
                        />
                        {touched.branch && errors.branch && (
                          <p className="text-sm text-red-400">{errors.branch}</p>
                        )}
                        <p className="text-xs text-gray-500">
                          The branch to deploy from your repository
                        </p>
                      </>
                    ) : (
                      // Use BranchCombobox when branches are loaded successfully
                      <BranchCombobox
                        helperText="Select the branch to deploy from your repository"
                        branches={branchOptions}
                        value={branch}
                        onValueChange={handleBranchChange}
                        isLoading={isLoadingBranches}
                        placeholder="Select a branch"
                        searchPlaceholder="Search branches..."
                        required
                      />
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="environment" className="mt-0 space-y-4">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-100">Environment Variables</h3>
                    <p className="mt-1 text-xs text-gray-500">
                      Configure environment variables for your deployment. These will be available
                      during build and runtime.
                    </p>
                  </div>

                  {envVars.length === 0 ? (
                    <div className="rounded-md border border-gray-700 bg-gray-800/30 p-6 text-center">
                      <p className="text-sm text-gray-500">No environment variables added yet</p>
                      <p className="mt-1 text-xs text-gray-600">
                        Click the button below to add your first variable
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {envVars.map((envVar, index) => (
                        <EnvVarInput
                          key={index}
                          value={envVar}
                          onChange={value => handleEnvVarChange(index, value)}
                          onRemove={() => handleRemoveEnvVar(index)}
                          disabled={createDeploymentMutation.isPending}
                        />
                      ))}
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleAddEnvVar}
                    disabled={createDeploymentMutation.isPending}
                    className="gap-1.5"
                  >
                    <Plus className="size-4" />
                    Add Variable
                  </Button>
                </div>
              </TabsContent>

              {hasPasswordFeature && (
                <TabsContent value="password" className="mt-0 space-y-4">
                  <PasswordProtection
                    value={passwordForm}
                    onChange={setPasswordForm}
                    disabled={createDeploymentMutation.isPending}
                  />
                </TabsContent>
              )}
            </div>
          </Tabs>
        </form>

        <div className="p-6 pt-2">
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="secondary"
              onClick={handleClose}
              disabled={createDeploymentMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-deployment-form"
              variant="primary"
              disabled={!isFormValid || createDeploymentMutation.isPending}
              className="gap-1.5"
            >
              {createDeploymentMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Deployment'
              )}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
