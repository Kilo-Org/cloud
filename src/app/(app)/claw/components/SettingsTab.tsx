'use client';

import { AlertCircle, AlertTriangle, Hash, RotateCcw, Save, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useControllerVersion, useKiloClawConfig } from '@/hooks/useKiloClaw';
import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailTile } from './DetailTile';

import { ChannelTokenInput } from './ChannelTokenInput';
import { CHANNELS, CHANNEL_TYPES, type ChannelDefinition } from './channel-config';
import { ConfirmActionDialog } from './ConfirmActionDialog';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

/**
 * Models available via the kilocode gateway's baked-in catalog in openclaw.
 * Only these models are selectable as the default until openclaw supports
 * dynamic model discovery from the gateway's /models endpoint.
 */
const KILOCODE_CATALOG_IDS = new Set([
  'anthropic/claude-opus-4.6',
  'z-ai/glm-5:free',
  'minimax/minimax-m2.5:free',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.2',
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'x-ai/grok-code-fast-1',
  'moonshotai/kimi-k2.5',
]);

/** Returns true if calver `version` is >= `minVersion` (e.g. "2026.2.26"). Fails closed on malformed input. */
function calverAtLeast(version: string | null | undefined, minVersion: string): boolean {
  if (!version) return false;
  const parts = version.split('.').map(Number);
  const minParts = minVersion.split('.').map(Number);
  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // equal
}

function ChannelSection({
  channel,
  configured,
  mutations,
  onChannelsChanged,
  channelType,
  dirtyChannels,
}: {
  channel: ChannelDefinition;
  configured: boolean;
  mutations: ClawMutations;
  onChannelsChanged?: (channelType: string) => void;
  channelType: string;
  dirtyChannels: Set<string>;
}) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [formatError, setFormatError] = useState<string | null>(null);
  const isSaving = mutations.patchChannels.isPending;
  const Icon = channel.icon;
  const isChannelDirty = dirtyChannels.has(channelType);

  function setToken(key: string, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
    setFormatError(null);
  }

  function hasAllTokensFilled() {
    return channel.fields.every(f => tokens[f.key]?.trim());
  }

  function handleSave() {
    if (!hasAllTokensFilled()) {
      if (channel.fields.length > 1) {
        toast.error(`All token fields are required for ${channel.label}.`);
      } else {
        toast.error('Enter a token or use Remove to clear it.');
      }
      return;
    }

    for (const field of channel.fields) {
      const error = field.validate?.(tokens[field.key].trim());
      if (error) {
        setFormatError(error);
        toast.error(error);
        return;
      }
    }

    const patch: Record<string, string> = {};
    for (const field of channel.fields) {
      patch[field.key] = tokens[field.key].trim();
    }

    mutations.patchChannels.mutate(patch, {
      onSuccess: () => {
        toast.success(
          `${channel.label} token${channel.fields.length > 1 ? 's' : ''} saved. Hit Redeploy to apply.`
        );
        setTokens({});
        onChannelsChanged?.(channelType);
      },
      onError: err => toast.error(`Failed to save: ${err.message}`),
    });
  }

  function handleRemove() {
    const patch: Record<string, null> = {};
    for (const field of channel.fields) {
      patch[field.key] = null;
    }

    mutations.patchChannels.mutate(patch, {
      onSuccess: () => {
        toast.success(
          `${channel.label} token${channel.fields.length > 1 ? 's' : ''} removed. Hit Redeploy to apply.`
        );
        setTokens({});
        onChannelsChanged?.(channelType);
      },
      onError: err => toast.error(`Failed to remove: ${err.message}`),
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <Label className="shrink-0">{channel.label}</Label>
        <span className="text-muted-foreground text-xs">
          {configured ? 'Configured' : 'Not configured'}
        </span>
        {(formatError || isChannelDirty) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertCircle
                className={`h-4 w-4 ${formatError ? 'text-red-500' : 'text-amber-500'}`}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p>{formatError ? 'Improper token format' : 'Redeploy to apply changes'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {channel.fields.map(field => (
        <div key={field.key} className="flex items-center gap-2">
          {channel.fields.length > 1 && (
            <Label htmlFor={`settings-${field.key}`} className="w-20 shrink-0 text-xs">
              {field.label}
            </Label>
          )}
          <ChannelTokenInput
            id={`settings-${field.key}`}
            placeholder={configured ? field.placeholderConfigured : field.placeholder}
            value={tokens[field.key] ?? ''}
            onChange={v => setToken(field.key, v)}
            disabled={isSaving}
            className="flex-1"
          />
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isSaving || !hasAllTokensFilled()}>
          <Save className="h-4 w-4" />
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
        {configured && (
          <Button variant="outline" size="sm" onClick={handleRemove} disabled={isSaving}>
            <X className="h-4 w-4" />
            Remove
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        {channel.help}
        {dirtyChannels.size > 0 && ' Hit Redeploy to apply channel changes.'}
      </p>
    </div>
  );
}

export function SettingsTab({
  status,
  mutations,
  onChannelsChanged,
  dirtyChannels,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onChannelsChanged?: (channelType: string) => void;
  dirtyChannels: Set<string>;
}) {
  const posthog = usePostHog();
  const { data: config } = useKiloClawConfig();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (modelsData?.data || [])
        .filter(model => KILOCODE_CATALOG_IDS.has(model.id))
        .map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  const { selectedModel, setSelectedModel } = useDefaultModelSelection(
    config?.kilocodeDefaultModel,
    modelOptions
  );

  const isSaving = mutations.patchConfig.isPending;
  const isDestroying = status.status === 'destroying';
  const isRunning = status.status === 'running';
  const { data: controllerVersion } = useControllerVersion(isRunning);
  const supportsConfigRestore = calverAtLeast(controllerVersion?.version, '2026.2.26');

  const channelStatus = config?.channels ?? {
    telegram: false,
    discord: false,
    slackBot: false,
    slackApp: false,
  };

  function handleSave() {
    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    posthog?.capture('claw_save_config_clicked', {
      selected_model: selectedModel || null,
      instance_status: status.status,
    });

    mutations.patchConfig.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
      },
      {
        onSuccess: () => toast.success('Configuration saved. Model change applied.'),
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DetailTile label="Env Vars" value={String(status.envVarCount)} icon={Hash} />
        <DetailTile label="Secrets" value={String(status.secretCount)} icon={Hash} />
        <DetailTile label="Channels" value={String(status.channelCount)} icon={Hash} />
      </div>

      <Separator />

      <div>
        <h2 className="text-foreground mb-4 text-lg font-semibold">KiloCode Configuration</h2>

        <div className="space-y-4">
          <div>
            <h3 className="text-foreground mb-1 text-sm font-medium">Default Model</h3>
            <p className="text-muted-foreground mb-2 text-xs">
              The model used for new conversations. Can be changed per-conversation in the OpenClaw
              Control UI.
            </p>
          </div>

          <ModelCombobox
            label=""
            models={modelOptions}
            value={selectedModel}
            onValueChange={setSelectedModel}
            isLoading={isLoadingModels}
            disabled={isSaving || isLoadingModels}
          />

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>

          {config && (
            <p className="text-muted-foreground text-xs">
              Current default model: {config.kilocodeDefaultModel || 'not set'}
            </p>
          )}
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Channels</h3>
        <p className="text-muted-foreground mb-4 text-xs">
          Connect messaging channels. Advanced settings (DM policy, allow lists, groups) can be
          configured in the OpenClaw Control UI after connecting.
        </p>

        <div className="space-y-6">
          {CHANNEL_TYPES.map(type => (
            <ChannelSection
              key={type}
              channel={CHANNELS[type]}
              configured={CHANNELS[type].configuredCheck(channelStatus)}
              mutations={mutations}
              onChannelsChanged={onChannelsChanged}
              channelType={type}
              dirtyChannels={dirtyChannels}
            />
          ))}
        </div>
      </div>

      <Separator />

      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Stop or destroy this instance. Destroy permanently removes associated data.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        !supportsConfigRestore ||
                        !isRunning ||
                        mutations.restoreConfig.isPending ||
                        isDestroying
                      }
                      onClick={() => {
                        posthog?.capture('claw_restore_config_clicked', {
                          instance_status: status.status,
                        });
                        setConfirmRestore(true);
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Restore Default Config
                    </Button>
                  </span>
                </TooltipTrigger>
                {!supportsConfigRestore && (
                  <TooltipContent>Unavailable until redeploy</TooltipContent>
                )}
              </Tooltip>

              <Button
                variant="outline"
                size="sm"
                disabled={!isRunning || mutations.stop.isPending || isDestroying}
                onClick={() => {
                  posthog?.capture('claw_stop_instance_clicked', {
                    instance_status: status.status,
                    source: 'settings_danger_zone',
                  });
                  mutations.stop.mutate(undefined, {
                    onSuccess: () => toast.success('Instance stopped'),
                    onError: err => toast.error(err.message),
                  });
                }}
              >
                <Square className="h-4 w-4" />
                Stop Instance
              </Button>

              {!confirmDestroy ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isDestroying || mutations.destroy.isPending}
                  onClick={() => {
                    posthog?.capture('claw_destroy_instance_clicked', {
                      instance_status: status.status,
                    });
                    setConfirmDestroy(true);
                  }}
                >
                  {isDestroying ? 'Destroying...' : 'Destroy Instance'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isDestroying || mutations.destroy.isPending}
                    onClick={() => {
                      posthog?.capture('claw_destroy_instance_confirmed', {
                        instance_status: status.status,
                      });
                      mutations.destroy.mutate(undefined, {
                        onSuccess: () => {
                          toast.success('Instance destroyed');
                          setConfirmDestroy(false);
                        },
                        onError: err => toast.error(err.message),
                      });
                    }}
                  >
                    {isDestroying ? 'Destroying...' : 'Yes, destroy'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      posthog?.capture('claw_destroy_instance_cancelled');
                      setConfirmDestroy(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {supportsConfigRestore && (
        <ConfirmActionDialog
          open={confirmRestore}
          onOpenChange={setConfirmRestore}
          title="Restore Default Config"
          description="This will rewrite openclaw.json to defaults based on the machine's current environment variables and restart the gateway process. Any manual config changes made via the Control UI will be lost. This does not pull fresh settings from your dashboard — use Redeploy for that."
          confirmLabel="Restore & Restart"
          confirmIcon={<RotateCcw className="mr-1 h-4 w-4" />}
          isPending={mutations.restoreConfig.isPending}
          pendingLabel="Restoring..."
          onConfirm={() => {
            posthog?.capture('claw_restore_config_confirmed', {
              instance_status: status.status,
            });
            mutations.restoreConfig.mutate(undefined, {
              onSuccess: data => {
                if (data.signaled) {
                  toast.success('Config restored and gateway restarting');
                } else {
                  toast.success(
                    'Config restored, but the gateway was not running — restart the instance to apply'
                  );
                }
                setConfirmRestore(false);
              },
              onError: err => toast.error(`Failed to restore config: ${err.message}`),
            });
          }}
        />
      )}
    </div>
  );
}
