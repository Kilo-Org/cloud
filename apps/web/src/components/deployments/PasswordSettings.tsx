'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/Button';
import { Loader2, ShieldOff, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { useDeploymentQueries } from './DeploymentContext';
import type { DeploymentQueries, DeploymentMutations } from '@/lib/user-deployments/router-types';
import {
  PasswordProtection,
  validatePasswordForm,
  type PasswordFormState,
} from './PasswordFormFields';

type PasswordSettingsProps = {
  deploymentId: string;
};

/** Message shown when password features aren't available (non-org deployments) */
function PasswordUnavailableMessage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">Password Protection</h3>
          <p className="mt-1 text-sm text-gray-400">
            Restrict access to your deployment with a password
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-6 text-center">
        <Shield className="mx-auto size-8 text-gray-500" />
        <p className="mt-3 text-sm text-gray-500">
          Password protection is only available for organization deployments.
        </p>
      </div>
    </div>
  );
}

type PasswordSettingsContentProps = {
  deploymentId: string;
  getPasswordStatusQuery: NonNullable<DeploymentQueries['getPasswordStatus']>;
  setPasswordMutation: NonNullable<DeploymentMutations['setPassword']>;
  removePasswordMutation: NonNullable<DeploymentMutations['removePassword']>;
};

/** Inner component that handles password settings with hooks called unconditionally */
function PasswordSettingsContent({
  deploymentId,
  getPasswordStatusQuery,
  setPasswordMutation,
  removePasswordMutation,
}: PasswordSettingsContentProps) {
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>({
    password: '',
    confirmPassword: '',
    enabled: false,
  });
  const [isConfirmingDisable, setIsConfirmingDisable] = useState(false);

  // All hooks are called unconditionally at the top of the component
  const { data: passwordStatus, isLoading, error, refetch } = getPasswordStatusQuery(deploymentId);
  const isProtected = passwordStatus?.protected === true;

  // Sync form state with server state when data loads
  useEffect(() => {
    if (passwordStatus) {
      setPasswordForm(prev => ({
        ...prev,
        enabled: passwordStatus.protected,
      }));
    }
  }, [passwordStatus]);

  const handleSave = () => {
    const result = validatePasswordForm(passwordForm);
    if (!result.valid) {
      toast.error(result.error);
      return;
    }

    setPasswordMutation.mutate(
      { deploymentId, password: passwordForm.password },
      {
        onSuccess: () => {
          toast.success(isProtected ? 'Password updated' : 'Password protection enabled');
          setPasswordForm(prev => ({ ...prev, password: '', confirmPassword: '' }));
          void refetch();
        },
        onError: err => {
          toast.error(`Failed to set password: ${err.message}`);
        },
      }
    );
  };

  const handleDisableRequest = () => {
    // When toggle is turned off for existing protection, show confirmation
    setIsConfirmingDisable(true);
  };

  const handleConfirmDisable = () => {
    removePasswordMutation.mutate(
      { deploymentId },
      {
        onSuccess: () => {
          toast.success('Password protection removed');
          setIsConfirmingDisable(false);
          setPasswordForm({ password: '', confirmPassword: '', enabled: false });
          void refetch();
        },
        onError: err => {
          toast.error(`Failed to remove password: ${err.message}`);
        },
      }
    );
  };

  const handleCancelDisable = () => {
    setIsConfirmingDisable(false);
    // Reset toggle back to enabled
    setPasswordForm(prev => ({ ...prev, enabled: true }));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/50 bg-red-400/10 p-4">
        <p className="text-sm text-red-400">Failed to load password status: {error.message}</p>
      </div>
    );
  }

  // Show confirmation dialog for disabling
  if (isConfirmingDisable) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
          <h3 className="text-sm font-medium text-amber-400">Remove Password Protection?</h3>
          <p className="mt-2 text-xs text-gray-400">
            This will make your deployment publicly accessible. Anyone with the URL will be able to
            view it.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCancelDisable}
            disabled={removePasswordMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirmDisable}
            disabled={removePasswordMutation.isPending}
            className="gap-1.5"
          >
            {removePasswordMutation.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Removing...
              </>
            ) : (
              <>
                <ShieldOff className="size-4" />
                Remove Protection
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PasswordProtection
      value={passwordForm}
      onChange={setPasswordForm}
      disabled={setPasswordMutation.isPending || removePasswordMutation.isPending}
      isExistingProtection={isProtected}
      onDisable={handleDisableRequest}
      onSave={handleSave}
      isSaving={setPasswordMutation.isPending}
      showSaveButton={passwordForm.enabled}
      saveButtonText={isProtected ? 'Update Password' : 'Enable Protection'}
    />
  );
}

/** Main exported component that handles conditional rendering */
export function PasswordSettings({ deploymentId }: PasswordSettingsProps) {
  const { queries, mutations } = useDeploymentQueries();

  // Check if password mutations are available (org-only feature)
  const setPasswordMutation = mutations.setPassword;
  const removePasswordMutation = mutations.removePassword;
  const getPasswordStatusQuery = queries.getPasswordStatus;

  // If password features aren't available, show a message
  if (!setPasswordMutation || !removePasswordMutation || !getPasswordStatusQuery) {
    return <PasswordUnavailableMessage />;
  }

  // Render the content component with all hooks available
  return (
    <PasswordSettingsContent
      deploymentId={deploymentId}
      getPasswordStatusQuery={getPasswordStatusQuery}
      setPasswordMutation={setPasswordMutation}
      removePasswordMutation={removePasswordMutation}
    />
  );
}
