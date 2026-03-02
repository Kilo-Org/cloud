'use client';

import { useState } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AutocompleteUserByokProviderIdSchema,
  VercelUserByokInferenceProviderIdSchema,
  AwsCredentialsSchema,
} from '@/lib/providers/openrouter/inference-provider-id';
import * as z from 'zod';

// Hardcoded BYOK providers list
const BYOK_PROVIDERS = [
  { id: VercelUserByokInferenceProviderIdSchema.enum.anthropic, name: 'Anthropic' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.bedrock, name: 'AWS Bedrock' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.openai, name: 'OpenAI' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.google, name: 'Google AI Studio' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.minimax, name: 'MiniMax' },
  { id: AutocompleteUserByokProviderIdSchema.enum.codestral, name: 'Mistral AI: Codestral' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.mistral, name: 'Mistral AI: Devstral' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.xai, name: 'xAI' },
  { id: VercelUserByokInferenceProviderIdSchema.enum.zai, name: 'Z.AI' },
] as const;

function BYOKDescription() {
  return (
    <p className="text-muted-foreground">
      Supply your own key provider API keys. Your Kilo balance will not be used when using these
      providers: you will be billed by the provider directly.
    </p>
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
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
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

export function BYOKKeysManager({ organizationId }: BYOKKeysManagerProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [awsCredentialError, setAwsCredentialError] = useState<string | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Build query options - only include organizationId if provided
  const listQueryInput = organizationId ? { organizationId } : {};

  const { data: keys, isLoading: keysLoading } = useQuery(
    trpc.byok.list.queryOptions(listQueryInput)
  );

  const { data: supportedModels } = useQuery(trpc.byok.listSupportedModels.queryOptions());

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
      updateMutation.mutate({
        ...(organizationId && { organizationId }),
        id: editingKeyId,
        api_key: apiKey,
      });
    } else {
      createMutation.mutate({
        ...(organizationId && { organizationId }),
        provider_id: selectedProvider,
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
    if (confirm(`Are you sure you want to delete the API key for ${providerName}?`)) {
      deleteMutation.mutate({ ...(organizationId && { organizationId }), id: keyId });
    }
  };

  const handleToggleEnabled = (keyId: string, is_enabled: boolean) => {
    setEnabledMutation.mutate({
      ...(organizationId && { organizationId }),
      id: keyId,
      is_enabled,
    });
  };

  if (keysLoading) {
    return (
      <div className="space-y-4">
        <BYOKDescription />
        <Card>
          <CardHeader>
            <CardTitle>BYOK API Keys</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground">Loading...</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Map provider IDs to display names
  const getProviderDisplayName = (providerId: string) => {
    const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
    return provider?.name || providerId;
  };

  const getProviderModels = (providerId: string): string[] => {
    return supportedModels?.[providerId] ?? [];
  };

  return (
    <div className="space-y-4">
      <BYOKDescription />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle>BYOK API Keys</CardTitle>
          <Button onClick={() => setIsDialogOpen(true)} size="sm">
            <Plus className="mr-2 h-4 w-4" />
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
                          >
                            <FlaskConical className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleEdit(key.id)}
                            disabled={updateMutation.isPending}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              handleDelete(key.id, getProviderDisplayName(key.provider_id))
                            }
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
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
                    >
                      {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                )}
                {selectedProvider === VercelUserByokInferenceProviderIdSchema.enum.bedrock && (
                  <Alert>
                    <Info className="h-4 w-4" />
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
                    <Lock className="h-4 w-4" />
                    <AlertDescription>
                      An API key is already saved for this provider. Enter a new key to replace it.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert>
                    <Info className="h-4 w-4" />
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
      </Card>
    </div>
  );
}
