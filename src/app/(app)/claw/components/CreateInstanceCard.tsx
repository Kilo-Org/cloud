'use client';

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ChannelTokenInput } from './ChannelTokenInput';
import { CHANNELS, CHANNEL_TYPES, type ChannelType } from './channel-config';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function CreateInstanceCard({ mutations }: { mutations: ClawMutations }) {
  const posthog = usePostHog();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [selectedModel, setSelectedModel] = useState('');
  const [addedChannels, setAddedChannels] = useState<Set<ChannelType>>(new Set());
  const [tokens, setTokens] = useState<Record<string, string>>({});

  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  function addChannel(channel: ChannelType) {
    setAddedChannels(prev => new Set([...prev, channel]));
  }

  function removeChannel(channel: ChannelType) {
    setAddedChannels(prev => {
      const next = new Set(prev);
      next.delete(channel);
      return next;
    });
    // Clear tokens for removed channel
    const fieldKeys = CHANNELS[channel].fields.map(f => f.key);
    setTokens(prev => {
      const next = { ...prev };
      for (const key of fieldKeys) delete next[key];
      return next;
    });
  }

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  function buildChannelsPayload() {
    const channels: Record<string, string> = {};
    let hasAny = false;
    for (const channel of addedChannels) {
      for (const field of CHANNELS[channel].fields) {
        const val = tokens[field.key]?.trim();
        if (val) {
          channels[field.key] = val;
          hasAny = true;
        }
      }
    }
    return hasAny ? channels : undefined;
  }

  function handleCreate() {
    posthog?.capture('claw_create_instance_clicked', {
      selected_model: selectedModel || null,
      channels: [...addedChannels],
    });

    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    // Validate Slack requires both tokens
    if (addedChannels.has('slack')) {
      const bot = tokens.slackBotToken?.trim();
      const app = tokens.slackAppToken?.trim();
      if ((bot && !app) || (!bot && app)) {
        toast.error('Slack requires both a Bot Token and an App Token.');
        return;
      }
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    mutations.provision.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
        channels: buildChannelsPayload(),
      },
      {
        onSuccess: () => toast.success('Instance created'),
        onError: err => toast.error(`Failed to create: ${err.message}`),
      }
    );
  }

  const availableChannels = CHANNEL_TYPES.filter(c => !addedChannels.has(c));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Instance</CardTitle>
        <CardDescription>
          Choose a default model to provision your first KiloClaw instance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ModelCombobox
          label=""
          models={modelOptions}
          value={selectedModel}
          onValueChange={setSelectedModel}
          isLoading={isLoadingModels}
          disabled={mutations.provision.isPending || isLoadingModels}
        />

        <div className="space-y-3">
          <Label>Channels (optional)</Label>

          {availableChannels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {availableChannels.map(channel => {
                const cfg = CHANNELS[channel];
                const Icon = cfg.icon;
                return (
                  <Button
                    key={channel}
                    variant="outline"
                    size="sm"
                    onClick={() => addChannel(channel)}
                    disabled={mutations.provision.isPending}
                  >
                    <Icon className="mr-1.5 h-4 w-4" />
                    {cfg.label}
                  </Button>
                );
              })}
            </div>
          )}

          {[...addedChannels].map(channel => {
            const cfg = CHANNELS[channel];
            const Icon = cfg.icon;
            return (
              <div key={channel} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="h-4 w-4" />
                    {cfg.label}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeChannel(channel)}
                    disabled={mutations.provision.isPending}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {cfg.fields.map(field => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`create-${field.key}`} className="text-xs">
                      {field.label}
                    </Label>
                    <ChannelTokenInput
                      id={`create-${field.key}`}
                      placeholder={field.placeholder}
                      value={tokens[field.key] ?? ''}
                      onChange={v => setToken(field.key, v)}
                      disabled={mutations.provision.isPending}
                    />
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">{cfg.help}</p>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleCreate} disabled={mutations.provision.isPending}>
            <Plus className="mr-2 h-4 w-4" />
            {mutations.provision.isPending ? 'Creating...' : 'Create & Provision'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
