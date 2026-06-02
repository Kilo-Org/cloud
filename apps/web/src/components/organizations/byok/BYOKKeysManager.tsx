'use client';

import { useReducer, useState } from 'react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Trash2,
  Edit,
  Eye,
  EyeOff,
  Plus,
  Info,
  Lock,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DirectUserByokInferenceProviderIdSchema,
  UserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
  type VercelUserByokInferenceProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { DIRECT_BYOK_PROVIDERS_META } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import * as z from 'zod';

// Exhaustive map of Vercel BYOK providers to their display names. The `satisfies`
// clause forces new entries here whenever a provider is added to
// VercelUserByokInferenceProviderIdSchema.
const VERCEL_BYOK_PROVIDER_NAMES = {
  anthropic: 'Anthropic',
  bedrock: 'AWS Bedrock',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  inception: 'Inception',
  fireworks: 'Fireworks',
  google: 'Google AI Studio',
  minimax: 'MiniMax',
  mistral: 'Mistral AI (other models)',
  moonshotai: 'Moonshot AI',
  novita: 'Novita',
  perplexity: 'Perplexity',
  xai: 'xAI',
  xiaomi: 'Xiaomi (pay as you go)',
  zai: 'Z.ai (pay as you go)',
} satisfies Record<VercelUserByokInferenceProviderId, string>;

const VERCEL_BYOK_PROVIDERS = [
  ...Object.entries(VERCEL_BYOK_PROVIDER_NAMES).map(([id, name]) => ({ id, name })),
  { id: DirectUserByokInferenceProviderIdSchema.enum.codestral, name: 'Mistral AI (Codestral)' },
];

const DIRECT_BYOK_PROVIDERS_LIST = Object.entries(DIRECT_BYOK_PROVIDERS_META).map(([id, name]) => ({
  id,
  name,
}));

const BYOK_PROVIDERS = [...DIRECT_BYOK_PROVIDERS_LIST, ...VERCEL_BYOK_PROVIDERS].toSorted((a, b) =>
  a.name.localeCompare(b.name)
);

function BYOKDescription({ showsCodingPlanKey = false }: { showsCodingPlanKey?: boolean }) {
  return (
    <div className="text-muted-foreground space-y-2">
      <p>Keys you create here use provider billing instead of your Kilo balance.</p>
      {showsCodingPlanKey ? (
        <p>
          Token Plan Plus configured your MiniMax key using Kilo Credits. Updating, disabling, or
          deleting that key changes routing only; subscription billing continues until canceled in
          Subscriptions.
        </p>
      ) : null}
    </div>
  );
}

function BYOKSetupGuideLink() {
  return (
    <a
      href="https://kilo.ai/docs/getting-started/byok"
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
    >
      View the BYOK setup guide
    </a>
  );
}

function SupportedModelsList({ models }: { models: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (models.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {models.length} supported model{models.length !== 1 ? 's' : ''}
      </button>
      {expanded && (
        <ul className="text-muted-foreground mt-1 ml-4 space-y-0.5 text-xs">
          {models.map(model => (
            <li key={model}>{model}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type BYOKKeysManagerProps = {
  organizationId?: string;
};

type InstalledKeyWarningAction =
  | { type: 'disable'; keyId: string }
  | { type: 'update'; keyId: string }
  | { type: 'delete'; keyId: string; providerName: string };

type BYOKDialogState = {
  isDialogOpen: boolean;
  editingKeyId: string | null;
  selectedProvider: string;
  apiKey: string;
  showApiKey: boolean;
  awsCredentialError: string | null;
  installedKeyWarningAction: InstalledKeyWarningAction | null;
};

const INITIAL_BYOK_DIALOG_STATE: BYOKDialogState = {
  isDialogOpen: false,
  editingKeyId: null,
  selectedProvider: '',
  apiKey: '',
  showApiKey: false,
  awsCredentialError: null,
  installedKeyWarningAction: null,
};

function updateBYOKDialogState(state: BYOKDialogState, update: Partial<BYOKDialogState>) {
  return { ...state, ...update };
}

export function BYOKKeysManager({ organizationId }: BYOKKeysManagerProps) {
  const [dialogState, updateDialogState] = useReducer(
    updateBYOKDialogState,
    INITIAL_BYOK_DIALOG_STATE
  );
  const {
    isDialogOpen,
    editingKeyId,
    selectedProvider,
    apiKey,
    showApiKey,
    awsCredentialError,
    installedKeyWarningAction,
  } = dialogState;
  const setIsDialogOpen = (isDialogOpen: boolean) => updateDialogState({ isDialogOpen });
  const setEditingKeyId = (editingKeyId: string | null) => updateDialogState({ editingKeyId });
  const setSelectedProvider = (selectedProvider: string) => updateDialogState({ selectedProvider });
  const setApiKey = (apiKey: string) => updateDialogState({ apiKey });
  const setShowApiKey = (showApiKey: boolean) => updateDialogState({ showApiKey });
  const setAwsCredentialError = (awsCredentialError: string | null) =>
    updateDialogState({ awsCredentialError });
  const setInstalledKeyWarningAction = (
    installedKeyWarningAction: InstalledKeyWarningAction | null
  ) => updateDialogState({ installedKeyWarningAction });

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Build query options - only include organizationId if provided
  const listQueryInput = organizationId ? { organizationId } : {};

  const { data: keys, isLoading: keysLoading } = useQuery(
    trpc.byok.list.queryOptions(listQueryInput)
  );

  const { data: supportedModels } = useQuery(trpc.byok.listSupportedModels.queryOptions());
  const showsCodingPlanKey =
    !organizationId &&
    (keys?.some(key => key.provider_id === 'minimax' && key.management_source === 'coding_plan') ??
      false);

  const createMutation = useMutation(
    trpc.byok.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.byok.list.queryKey(listQueryInput),
        });
        toast.success('API key added successfully');
        closeDialog();
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to add API key: ${error.message}`);
      },
    })
  );

  const updateMutation = useMutation(
    trpc.byok.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.byok.list.queryKey(listQueryInput),
        });
        toast.success('API key updated successfully');
        closeDialog();
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to update API key: ${error.message}`);
      },
    })
  );

  const deleteMutation = useMutation(
    trpc.byok.delete.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.byok.list.queryKey(listQueryInput),
        });
        toast.success('API key deleted successfully');
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to delete API key: ${error.message}`);
      },
    })
  );

  const setEnabledMutation = useMutation(
    trpc.byok.setEnabled.mutationOptions({
      onSuccess: data => {
        void queryClient.invalidateQueries({
          queryKey: trpc.byok.list.queryKey(listQueryInput),
        });
        toast.success(data.is_enabled ? 'API key enabled' : 'API key disabled');
      },
      onError: (error: { message: string }) => {
        toast.error(`Failed to update API key status: ${error.message}`);
      },
    })
  );

  const testMutation = useMutation(
    trpc.byok.testApiKey.mutationOptions({
      onSuccess: result => {
        if (result.success) {
          toast.success(result.message);
        } else {
          toast.error(result.message);
        }
      },
      onError: (error: { message: string }) => {
        toast.error(`Test failed: ${error.message}`);
      },
    })
  );

  // Check if a provider already has a key
  const hasExistingKey = (providerSlug: string) => {
    return keys?.some(k => k.provider_id === providerSlug) ?? false;
  };

  const isInstalledCodingPlanKey = (keyId: string) =>
    !organizationId &&
    (keys?.some(key => key.id === keyId && key.management_source === 'coding_plan') ?? false);

  const validateAwsCredentials = (value: string): string | null => {
    if (!value) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return 'Invalid JSON — please enter a valid JSON object.';
    }
    const result = AwsCredentialsSchema.safeParse(parsed);
    if (!result.success) {
      return `Invalid AWS credentials:\n${z.prettifyError(result.error)}`;
    }
    return null;
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setEditingKeyId(null);
    setSelectedProvider('');
    setApiKey('');
    setShowApiKey(false);
    setAwsCredentialError(null);
  };

  const handleSave = () => {
    if (selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock) {
      const error = validateAwsCredentials(apiKey);
      setAwsCredentialError(error);
      if (error) return;
    }
    if (editingKeyId) {
      if (isInstalledCodingPlanKey(editingKeyId)) {
        setInstalledKeyWarningAction({ type: 'update', keyId: editingKeyId });
        return;
      }
      updateMutation.mutate({
        ...(organizationId && { organizationId }),
        id: editingKeyId,
        api_key: apiKey,
      });
    } else {
      const providerId = UserByokProviderIdSchema.safeParse(selectedProvider);
      if (!providerId.success) {
        toast.error('Select a supported provider.');
        return;
      }
      createMutation.mutate({
        ...(organizationId && { organizationId }),
        provider_id: providerId.data,
        api_key: apiKey,
      });
    }
  };

  const handleEdit = (keyId: string) => {
    setEditingKeyId(keyId);
    const key = keys?.find((k: { id: string; provider_id: string }) => k.id === keyId);
    if (key) {
      setSelectedProvider(key.provider_id);
    }
    setIsDialogOpen(true);
  };

  const handleDelete = (keyId: string, providerName: string) => {
    if (isInstalledCodingPlanKey(keyId)) {
      setInstalledKeyWarningAction({ type: 'delete', keyId, providerName });
      return;
    }
    if (confirm(`Are you sure you want to delete the API key for ${providerName}?`)) {
      deleteMutation.mutate({ ...(organizationId && { organizationId }), id: keyId });
    }
  };

  const handleToggleEnabled = (keyId: string, is_enabled: boolean) => {
    if (!is_enabled && isInstalledCodingPlanKey(keyId)) {
      setInstalledKeyWarningAction({ type: 'disable', keyId });
      return;
    }
    setEnabledMutation.mutate({
      ...(organizationId && { organizationId }),
      id: keyId,
      is_enabled,
    });
  };

  const confirmInstalledKeyChange = () => {
    if (!installedKeyWarningAction) return;

    if (installedKeyWarningAction.type === 'update') {
      updateMutation.mutate({
        id: installedKeyWarningAction.keyId,
        api_key: apiKey,
      });
    } else if (installedKeyWarningAction.type === 'delete') {
      deleteMutation.mutate({ id: installedKeyWarningAction.keyId });
    } else {
      setEnabledMutation.mutate({ id: installedKeyWarningAction.keyId, is_enabled: false });
    }
    setInstalledKeyWarningAction(null);
  };

  if (keysLoading) {
    return (
      <div className="space-y-4">
        <BYOKDescription showsCodingPlanKey={showsCodingPlanKey} />
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-2">
              <CardTitle>BYOK API Keys</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground">Loading&hellip;</div>
          </CardContent>
          <CardFooter>
            <BYOKSetupGuideLink />
          </CardFooter>
        </Card>
      </div>
    );
  }

  function getInstalledKeyWarning(action: InstalledKeyWarningAction | null): {
    title: string;
    description: string;
    actionLabel: string;
  } {
    if (action?.type === 'update') {
      return {
        title: 'Replace Token Plan Plus MiniMax key?',
        description:
          'Replacing this key changes MiniMax routing and makes it user-managed. Token Plan Plus billing continues until you cancel it in Subscription Center.',
        actionLabel: 'Replace key',
      };
    }
    if (action?.type === 'delete') {
      return {
        title: `Delete ${action.providerName} key?`,
        description:
          'Deleting this key stops MiniMax routing through this configuration. Token Plan Plus billing continues until you cancel it in Subscription Center.',
        actionLabel: 'Delete key',
      };
    }
    return {
      title: 'Disable Token Plan Plus MiniMax key?',
      description:
        'Disabling this key stops MiniMax routing while it is disabled. Token Plan Plus billing continues until you cancel it in Subscription Center.',
      actionLabel: 'Disable key',
    };
  }

  // Map provider IDs to display names
  const getProviderDisplayName = (providerId: string) => {
    const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
    return provider?.name || providerId;
  };

  const getProviderModels = (providerId: string): string[] => {
    return supportedModels?.[providerId] ?? [];
  };
  const installedKeyWarning = getInstalledKeyWarning(installedKeyWarningAction);

  return (
    <div className="space-y-4">
      <BYOKDescription showsCodingPlanKey={showsCodingPlanKey} />
      <Card>
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
          <div className="flex flex-col gap-2">
            <CardTitle>BYOK API Keys</CardTitle>
          </div>
          <Button onClick={() => setIsDialogOpen(true)} size="sm">
            <Plus className="mr-2 size-4" />
            Add Key
          </Button>
        </CardHeader>
        <CardContent>
          {keys && keys.length > 0 ? (
            <div className="rounded-md border">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="p-4 text-left font-medium">Provider</th>
                    <th className="p-4 text-left font-medium">Created</th>
                    <th className="p-4 text-left font-medium">Enabled</th>
                    <th className="p-4 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map(
                    (key: {
                      id: string;
                      provider_id: string;
                      created_at: string;
                      management_source: 'user' | 'coding_plan';
                      is_enabled: boolean;
                    }) => (
                      <tr
                        key={key.id}
                        className={
                          !key.is_enabled
                            ? 'bg-muted/20 border-b last:border-0'
                            : 'border-b last:border-0'
                        }
                      >
                        <td className={!key.is_enabled ? 'text-muted-foreground p-4' : 'p-4'}>
                          <div>{getProviderDisplayName(key.provider_id)}</div>
                          {!organizationId &&
                          key.provider_id === 'minimax' &&
                          key.management_source === 'coding_plan' ? (
                            <p className="text-muted-foreground mt-1 text-xs">
                              Configured by Token Plan Plus. BYOK changes do not cancel subscription
                              billing.
                            </p>
                          ) : null}
                          <SupportedModelsList models={getProviderModels(key.provider_id)} />
                        </td>
                        <td className="text-muted-foreground p-4">
                          {new Date(key.created_at).toLocaleDateString()}
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={key.is_enabled}
                              onCheckedChange={isEnabled => handleToggleEnabled(key.id, isEnabled)}
                              disabled={setEnabledMutation.isPending}
                              aria-label={`Toggle ${getProviderDisplayName(key.provider_id)} BYOK key`}
                            />
                            <span className="text-sm">
                              {key.is_enabled ? 'Enabled' : 'Disabled'}
                            </span>
                          </div>
                        </td>
                        <td className="space-x-2 p-4 text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              testMutation.mutate({
                                ...(organizationId && { organizationId }),
                                id: key.id,
                              })
                            }
                            disabled={testMutation.isPending}
                            title="Test API key"
                            aria-label={`Test ${getProviderDisplayName(key.provider_id)} API key`}
                          >
                            <FlaskConical className="size-4" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleEdit(key.id)}
                            disabled={updateMutation.isPending}
                            aria-label={`Update ${getProviderDisplayName(key.provider_id)} API key`}
                          >
                            <Edit className="size-4" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              handleDelete(key.id, getProviderDisplayName(key.provider_id))
                            }
                            disabled={deleteMutation.isPending}
                            aria-label={`Delete ${getProviderDisplayName(key.provider_id)} API key`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed py-12 text-center">
              <p className="text-muted-foreground mb-4">No BYOK keys configured</p>
              <Button onClick={() => setIsDialogOpen(true)}>Add Your First Key</Button>
            </div>
          )}
        </CardContent>

        <Dialog open={isDialogOpen} onOpenChange={closeDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editingKeyId ? 'Update API Key' : 'Add API Key'}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="provider">Provider</Label>
                <Select
                  value={selectedProvider}
                  onValueChange={setSelectedProvider}
                  disabled={!!editingKeyId}
                >
                  <SelectTrigger id="provider">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {BYOK_PROVIDERS.map(provider => {
                      const isDisabled = !editingKeyId && hasExistingKey(provider.id);
                      return (
                        <SelectItem
                          key={provider.id}
                          value={provider.id}
                          disabled={isDisabled}
                          className={isDisabled ? 'opacity-50' : ''}
                        >
                          <div className="flex w-full items-center justify-between">
                            <span>{provider.name}</span>
                            {isDisabled && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground ml-2 text-xs">
                                    (configured)
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  <p>Already configured</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="apiKey">
                  {selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock
                    ? 'AWS Credentials'
                    : 'API Key'}
                </Label>
                {selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock ? (
                  <>
                    <textarea
                      id="apiKey"
                      value={apiKey}
                      onChange={e => {
                        setApiKey(e.target.value);
                        setAwsCredentialError(validateAwsCredentials(e.target.value));
                      }}
                      placeholder='{"accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1"}'
                      className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                      rows={4}
                      aria-label="AWS credentials"
                    />
                    {awsCredentialError && (
                      <Alert variant="destructive">
                        <AlertDescription className="whitespace-break-spaces">
                          {awsCredentialError}
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                ) : (
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder="Enter API key"
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="absolute top-0 right-0 h-full px-3"
                      onClick={() => setShowApiKey(!showApiKey)}
                      aria-label={showApiKey ? 'Hide API key value' : 'Reveal API key value'}
                    >
                      {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </div>
                )}
                {selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock && (
                  <Alert>
                    <Info className="size-4" />
                    <AlertDescription>
                      <p>Enter your AWS credentials as JSON:</p>
                      <code className="mt-1 block text-xs break-all">
                        {'{"accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1"}'}
                      </code>
                      <p className="mt-1">
                        Your IAM user needs <code className="text-xs">bedrock:InvokeModel</code> and{' '}
                        <code className="text-xs">bedrock:InvokeModelWithResponseStream</code>{' '}
                        permissions.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}
                {editingKeyId ? (
                  <Alert>
                    <Lock className="size-4" />
                    <AlertDescription>
                      An API key is already saved for this provider. Enter a new key to replace it.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert>
                    <Info className="size-4" />
                    <AlertDescription>
                      Your API key will be encrypted and stored securely. Once saved, it cannot be
                      viewed again.
                    </AlertDescription>
                  </Alert>
                )}
              </div>

              {selectedProvider && getProviderModels(selectedProvider).length > 0 && (
                <div className="space-y-2">
                  <Label>Supported Models</Label>
                  <div className="text-muted-foreground rounded-md border p-3 text-sm">
                    <ul className="max-h-32 space-y-0.5 overflow-y-auto">
                      {getProviderModels(selectedProvider).map(model => (
                        <li key={model} className="text-xs">
                          {model}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {selectedProvider &&
                (() => {
                  const directProvider = DIRECT_BYOK_PROVIDERS_LIST.find(
                    p => p.id === selectedProvider
                  );
                  if (directProvider) {
                    return (
                      <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="size-4 text-amber-500" />
                        <AlertDescription>
                          <p className="font-medium">
                            Important: You must use a model with{' '}
                            <strong>{directProvider.name}</strong> prefix to use this key
                          </p>
                          <p className="mt-1">
                            In your client, select a model entry from the list above. After saving,
                            you may need to wait a few minutes and restart your client for this
                            entry to appear.
                          </p>
                        </AlertDescription>
                      </Alert>
                    );
                  }
                  return (
                    <Alert>
                      <Info className="size-4" />
                      <AlertDescription>
                        Once saved, your key will automatically be used whenever your client
                        requests one of the supported models above. If multiple keys apply to the
                        same model, they are tried in unspecified order until one succeeds.
                      </AlertDescription>
                    </Alert>
                  );
                })()}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  !selectedProvider ||
                  !apiKey ||
                  (selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock &&
                    !!awsCredentialError) ||
                  createMutation.isPending ||
                  updateMutation.isPending
                }
              >
                {editingKeyId ? 'Update' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog
          open={installedKeyWarningAction !== null}
          onOpenChange={open => !open && setInstalledKeyWarningAction(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{installedKeyWarning.title}</AlertDialogTitle>
              <AlertDialogDescription>{installedKeyWarning.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep configuration</AlertDialogCancel>
              <AlertDialogAction
                variant={installedKeyWarningAction?.type === 'delete' ? 'destructive' : 'default'}
                onClick={confirmInstalledKeyChange}
              >
                {installedKeyWarning.actionLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <CardFooter>
          <BYOKSetupGuideLink />
        </CardFooter>
      </Card>
    </div>
  );
}
