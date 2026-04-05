'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import type { EnvVarInputValue } from './EnvVarInput';
import { EnvVarInput } from './EnvVarInput';
import { Loader2, Plus, EyeOff, Pencil, Trash2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { envVarKeySchema } from '@/lib/user-deployments/env-vars-validation';
import { useDeploymentQueries } from './DeploymentContext';

type EnvironmentSettingsProps = {
  deploymentId: string;
};

type EditingVar = {
  key: string;
  value: string;
  isSecret: boolean;
  originalKey: string; // Track original key for updates
};

export function EnvironmentSettings({ deploymentId }: EnvironmentSettingsProps) {
  const { queries, mutations } = useDeploymentQueries();
  const [isAdding, setIsAdding] = useState(false);
  const [editingVar, setEditingVar] = useState<EditingVar | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [newVar, setNewVar] = useState<EnvVarInputValue>({
    key: '',
    value: '',
    isSecret: false,
  });

  // Query env vars
  const { data: envVars, isLoading, error, refetch } = queries.listEnvVars(deploymentId);

  const setEnvVarMutation = mutations.setEnvVar;
  const deleteEnvVarMutation = mutations.deleteEnvVar;
  const renameEnvVarMutation = mutations.renameEnvVar;

  const handleAddVariable = () => {
    // Validate key
    try {
      envVarKeySchema.parse(newVar.key);
    } catch (err) {
      if (err && typeof err === 'object' && 'errors' in err) {
        const zodError = err as { errors: Array<{ message: string }> };
        toast.error(zodError.errors[0]?.message || 'Invalid key');
      } else {
        toast.error('Invalid key');
      }
      return;
    }

    if (!newVar.value) {
      toast.error('Value cannot be empty');
      return;
    }

    // Check for duplicate key
    if (envVars?.some(envVar => envVar.key === newVar.key)) {
      toast.error(`Environment variable "${newVar.key}" already exists`);
      return;
    }

    setEnvVarMutation.mutate(
      {
        deploymentId,
        key: newVar.key,
        value: newVar.value,
        isSecret: newVar.isSecret,
      },
      {
        onSuccess: () => {
          toast.success('Variable added');
          setNewVar({ key: '', value: '', isSecret: false });
          setIsAdding(false);
          setHasChanges(true);
          void refetch();
        },
        onError: error => {
          toast.error(`Failed to add: ${error.message}`);
        },
      }
    );
  };

  const handleUpdateVariable = () => {
    if (!editingVar) return;

    // Validate key
    try {
      envVarKeySchema.parse(editingVar.key);
    } catch (err) {
      if (err && typeof err === 'object' && 'errors' in err) {
        const zodError = err as { errors: Array<{ message: string }> };
        toast.error(zodError.errors[0]?.message || 'Invalid key');
      } else {
        toast.error('Invalid key');
      }
      return;
    }

    if (!editingVar.value) {
      toast.error('Value cannot be empty');
      return;
    }

    if (editingVar.key !== editingVar.originalKey) {
      renameEnvVarMutation.mutate(
        {
          deploymentId,
          oldKey: editingVar.originalKey,
          newKey: editingVar.key,
        },
        {
          onSuccess: () => {
            if (editingVar.value) {
              setEnvVarMutation.mutate(
                {
                  deploymentId,
                  key: editingVar.key,
                  value: editingVar.value,
                  isSecret: editingVar.isSecret,
                },
                {
                  onSuccess: () => {
                    toast.success('Variable updated');
                    setEditingVar(null);
                    setHasChanges(true);
                    void refetch();
                  },
                  onError: error => {
                    toast.error(`Update failed: ${error.message}`);
                  },
                }
              );
            } else {
              toast.success('Variable renamed');
              setEditingVar(null);
              setHasChanges(true);
              void refetch();
            }
          },
          onError: error => {
            toast.error(`Rename failed: ${error.message}`);
          },
        }
      );
    } else {
      setEnvVarMutation.mutate(
        {
          deploymentId,
          key: editingVar.key,
          value: editingVar.value,
          isSecret: editingVar.isSecret,
        },
        {
          onSuccess: () => {
            toast.success('Variable updated');
            setEditingVar(null);
            setHasChanges(true);
            void refetch();
          },
          onError: error => {
            toast.error(`Update failed: ${error.message}`);
          },
        }
      );
    }
  };

  const handleDeleteVariable = (key: string) => {
    deleteEnvVarMutation.mutate(
      { deploymentId, key },
      {
        onSuccess: () => {
          toast.success('Variable deleted');
          setDeleteConfirm(null);
          setHasChanges(true);
          void refetch();
        },
        onError: error => {
          toast.error(`Delete failed: ${error.message}`);
        },
      }
    );
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
        <p className="text-sm text-red-400">
          Failed to load environment variables: {error.message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {hasChanges && (
        <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="size-5 shrink-0 text-yellow-500" />
            <p className="text-sm font-medium text-yellow-500">
              Environment variable changes require redeployment
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-100">Environment Variables</h3>
          <p className="mt-1 text-sm text-gray-400">
            Manage environment variables for this deployment
          </p>
        </div>
        {!isAdding && (
          <Button variant="primary" size="sm" onClick={() => setIsAdding(true)} className="gap-1.5">
            <Plus className="size-4" />
            Add Variable
          </Button>
        )}
      </div>

      {/* Add new variable form */}
      {isAdding && (
        <EnvVarInput
          value={newVar}
          onChange={setNewVar}
          onRemove={() => {
            setIsAdding(false);
            setNewVar({ key: '', value: '', isSecret: false });
          }}
          onSave={handleAddVariable}
          disabled={setEnvVarMutation.isPending}
          showSave={true}
        />
      )}

      {/* List of existing variables */}
      {envVars && envVars.length > 0 ? (
        <div className="space-y-3">
          {envVars.map(envVar => {
            const isEditing = editingVar?.originalKey === envVar.key;

            if (isEditing && editingVar) {
              return (
                <EnvVarInput
                  key={envVar.key}
                  value={editingVar}
                  onChange={updated =>
                    setEditingVar({
                      ...updated,
                      originalKey: editingVar.originalKey,
                    })
                  }
                  onRemove={() => setEditingVar(null)}
                  onSave={handleUpdateVariable}
                  disabled={setEnvVarMutation.isPending || renameEnvVarMutation.isPending}
                  showSave={true}
                />
              );
            }

            return (
              <div
                key={envVar.key}
                className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800/50 p-4"
              >
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-semibold text-gray-100">{envVar.key}</code>
                    {envVar.isSecret && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400">
                        <EyeOff className="size-3" />
                        Secret
                      </span>
                    )}
                  </div>
                  <code className="block text-sm text-gray-400">
                    {envVar.isSecret ? '••••••••' : envVar.value}
                  </code>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setEditingVar({
                        key: envVar.key,
                        value: envVar.isSecret ? '' : envVar.value,
                        isSecret: envVar.isSecret,
                        originalKey: envVar.key,
                      })
                    }
                    className="gap-1.5"
                    aria-label="Edit variable"
                  >
                    <Pencil className="size-4" />
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteConfirm(envVar.key)}
                    className="gap-1.5"
                    aria-label="Delete variable"
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        !isAdding && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/30 py-12">
            <p className="text-center text-gray-500">No environment variables configured</p>
            <p className="text-center text-sm text-gray-600">
              Add variables to configure your deployment
            </p>
          </div>
        )
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-100">Delete Environment Variable</h3>
            <p className="mt-4 text-sm text-gray-400">
              Are you sure you want to delete the environment variable{' '}
              <code className="rounded bg-gray-700 px-1.5 py-0.5 font-mono text-gray-100">
                {deleteConfirm}
              </code>
              ? This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteEnvVarMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => handleDeleteVariable(deleteConfirm)}
                disabled={deleteEnvVarMutation.isPending}
                className="gap-1.5"
              >
                {deleteEnvVarMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" />
                    Delete Variable
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
