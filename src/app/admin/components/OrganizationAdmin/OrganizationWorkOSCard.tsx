'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Shield, Loader2, CheckCircle, Edit, X, Trash2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { LoadingCard } from '@/components/LoadingCard';
import { ErrorCard } from '@/components/ErrorCard';
import {
  useOrganizationWithMembers,
  useUpdateOrganizationSsoDomain,
  useClearOrganizationSsoDomain,
} from '@/app/api/organizations/hooks';
import { useState } from 'react';

type OrganizationWorkOSCardProps = {
  organizationId: string;
};

type WorkOSDomain = {
  domain: string;
  state: string;
};

function useOrganizationSSOConfig(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.sso.getConfig.queryOptions({ organizationId }));
}

function useCreateSSOConfig() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.sso.createConfig.mutationOptions({
      onSuccess: (data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.sso.getConfig.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        toast.success('Organization enrolled in WorkOS successfully');
      },
      onError: error => {
        toast.error(error.message || 'Failed to enroll organization in WorkOS');
      },
    })
  );
}

function useDeleteSSOConfig() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.sso.deleteConfig.mutationOptions({
      onSuccess: (data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.sso.getConfig.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        toast.success('SSO configuration deleted successfully');
      },
      onError: error => {
        toast.error(error.message || 'Failed to delete SSO configuration');
      },
    })
  );
}

type SsoDomainEditButtonProps = {
  organizationId: string;
  currentDomain: string | null | undefined;
};

function SsoDomainEditButton({ organizationId, currentDomain }: SsoDomainEditButtonProps) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [editValue, setEditValue] = useState(currentDomain || '');

  const updateSsoDomain = useUpdateOrganizationSsoDomain();
  const clearSsoDomain = useClearOrganizationSsoDomain();

  const handleEdit = () => {
    if (!editValue.trim()) {
      toast.error('Domain cannot be empty');
      return;
    }

    updateSsoDomain.mutate(
      { organizationId, ssoDomain: editValue.trim() },
      {
        onSuccess: () => {
          toast.success('SSO domain updated successfully');
          setIsEditDialogOpen(false);
        },
        onError: error => {
          toast.error(error.message || 'Failed to update SSO domain');
        },
      }
    );
  };

  const handleClear = () => {
    clearSsoDomain.mutate(
      { organizationId },
      {
        onSuccess: () => {
          toast.success('SSO domain cleared successfully');
          setIsClearDialogOpen(false);
          setEditValue('');
        },
        onError: error => {
          toast.error(error.message || 'Failed to clear SSO domain');
        },
      }
    );
  };

  const handleEditDialogOpen = () => {
    setEditValue(currentDomain || '');
    setIsEditDialogOpen(true);
  };

  return (
    <div className="flex items-center gap-1">
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" onClick={handleEditDialogOpen} className="h-6 w-6 p-0">
            <Edit className="h-3 w-3" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit SSO Domain</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Domain</label>
              <Input
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                placeholder="example.com"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsEditDialogOpen(false)}
              disabled={updateSsoDomain.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={updateSsoDomain.isPending}>
              {updateSsoDomain.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                'Update'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {currentDomain && (
        <Dialog open={isClearDialogOpen} onOpenChange={setIsClearDialogOpen}>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-6 w-6 p-0"
            >
              <X className="h-3 w-3" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear SSO Domain</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Are you sure you want to clear the SSO domain "{currentDomain}"? This action cannot
                be undone.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsClearDialogOpen(false)}
                disabled={clearSsoDomain.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleClear}
                disabled={clearSsoDomain.isPending}
              >
                {clearSsoDomain.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  'Clear Domain'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function OrganizationWorkOSCard({ organizationId }: OrganizationWorkOSCardProps) {
  const { data: organization, isLoading: orgLoading } = useOrganizationWithMembers(organizationId);
  const {
    data: ssoConfig,
    isLoading: ssoLoading,
    error,
  } = useOrganizationSSOConfig(organizationId);
  const createConfig = useCreateSSOConfig();
  const deleteConfig = useDeleteSSOConfig();

  const handleEnrollInWorkOS = () => {
    createConfig.mutate({ organizationId });
  };

  const handleDeleteSSO = () => {
    if (
      confirm(
        'Are you sure you want to delete the SSO configuration? This action cannot be undone.'
      )
    ) {
      deleteConfig.mutate({ organizationId });
    }
  };

  // Don't show the card if organization requires seats (not eligible for WorkOS)
  if (organization?.plan !== 'enterprise') {
    return null;
  }

  // Show loading state
  if (orgLoading || ssoLoading) {
    return (
      <LoadingCard
        title="WorkOS Integration"
        description="Loading WorkOS configuration..."
        rowCount={2}
      />
    );
  }

  // Show error state for non-404 errors
  if (error) {
    return (
      <ErrorCard
        title="WorkOS Integration"
        description="Failed to load WorkOS configuration"
        error={error}
        onRetry={() => window.location.reload()}
      />
    );
  }

  // Show existing WorkOS organization if it exists
  if (ssoConfig && typeof ssoConfig === 'object') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <Shield className="mr-2 inline h-5 w-5" />
            WorkOS Integration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <span className="text-sm font-medium text-green-700">
                Organization enrolled in WorkOS
              </span>
            </div>

            <div className="space-y-2">
              <div>
                <label className="text-muted-foreground text-sm font-medium">
                  WorkOS Organization ID
                </label>
                <p className="font-mono text-sm">{ssoConfig.id}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">
                  Organization Name
                </label>
                <p className="text-sm">{ssoConfig.name}</p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">Domain Verified</label>
                <p className="text-sm">
                  {ssoConfig.isDomainVerified ? (
                    <span className="text-green-600">Yes</span>
                  ) : (
                    <span className="text-yellow-600">Pending</span>
                  )}
                </p>
              </div>

              <div>
                <label className="text-muted-foreground text-sm font-medium">SSO Configured</label>
                <p className="text-sm">
                  {ssoConfig.hasConnection ? (
                    <span className="text-green-600">Yes</span>
                  ) : (
                    <span className="text-yellow-600">Pending</span>
                  )}
                </p>
              </div>

              {ssoConfig.domains && ssoConfig.domains.length > 0 && (
                <div>
                  <label className="text-muted-foreground text-sm font-medium">
                    Configured Domains
                  </label>
                  <ul className="space-y-1 text-sm">
                    {ssoConfig.domains.map((domain: WorkOSDomain) => (
                      <li key={domain.domain} className="flex items-center gap-2">
                        <span>{domain.domain}</span>
                        <span
                          className={`rounded px-2 py-1 text-xs ${
                            domain.state === 'verified'
                              ? 'bg-green-100 text-green-800'
                              : domain.state === 'pending'
                                ? 'bg-yellow-100 text-yellow-800'
                                : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {domain.state}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <label className="text-muted-foreground text-sm font-medium">
                    Organization SSO Domain
                  </label>
                  <SsoDomainEditButton
                    organizationId={organizationId}
                    currentDomain={organization?.sso_domain}
                  />
                </div>
                <p className="text-sm">
                  {organization?.sso_domain ? (
                    <span className="font-mono">{organization.sso_domain}</span>
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                </p>
              </div>
            </div>

            {/* Admin Controls */}
            <div className="space-y-4 border-t pt-4">
              <Button
                onClick={handleDeleteSSO}
                disabled={deleteConfig.isPending}
                variant="destructive"
                size="sm"
                className="w-full"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleteConfig.isPending ? 'Deleting...' : 'Delete SSO Configuration'}
              </Button>

              {/* Debug Info */}
              <details>
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  View Configuration Details (Admin Only)
                </summary>
                <div className="bg-muted mt-2 rounded-md p-4">
                  <pre className="overflow-auto text-xs">{JSON.stringify(ssoConfig, null, 2)}</pre>
                </div>
              </details>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show enrollment button if no WorkOS config exists
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Shield className="mr-2 inline h-5 w-5" />
          WorkOS Integration
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Configure SSO Integration</p>
            <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
              <li>
                Click the button below to{' '}
                <code className="bg-muted rounded px-1">Enroll in WorkOS</code>.
              </li>
              <li>Copy the email of this organization's owner.</li>
              <li>
                Navigate to{' '}
                <a
                  href="https://dashboard.workos.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  https://dashboard.workos.com/
                </a>
                .
              </li>
              <li>
                Go to the <code className="bg-muted rounded px-1">Production</code> section and
                click <code className="bg-muted rounded px-1">Organizations.</code>
              </li>
              <li>
                Under this organization name, click{' '}
                <code className="bg-muted rounded px-1">Manage</code> and{' '}
                <code className="bg-muted rounded px-1">Invite Admin</code>.
              </li>
              <li>Click only the top two (Domain Verification and SSO).</li>
              <li>Copy the link and email to the admin.</li>
              <li>Once they have activated the domain, put it in the Organization SSO Domain.</li>
            </ol>
          </div>

          <div className="space-y-2">
            <div>
              <div className="flex items-center gap-2">
                <label className="text-muted-foreground text-sm font-medium">
                  Organization SSO Domain
                </label>
                <SsoDomainEditButton
                  organizationId={organizationId}
                  currentDomain={organization?.sso_domain}
                />
              </div>
              <p className="text-sm">
                {organization?.sso_domain ? (
                  <span className="font-mono">{organization.sso_domain}</span>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </p>
            </div>
          </div>

          <Button
            onClick={handleEnrollInWorkOS}
            disabled={createConfig.isPending}
            className="w-full"
          >
            {createConfig.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Enrolling in WorkOS...
              </>
            ) : (
              'Enroll in WorkOS'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
