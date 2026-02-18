'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Save, Square, X } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useKiloClawConfig } from '@/hooks/useKiloClaw';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function SettingsTab({
  status,
  mutations,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
}) {
  const posthog = usePostHog();
  const { data: config } = useKiloClawConfig();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const modelOptions = useMemo<ModelOption[]>(
    () => (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
    [modelsData]
  );

  const { selectedModel, setSelectedModel } = useDefaultModelSelection(
    config?.kilocodeDefaultModel,
    modelOptions
  );

  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [channelsDirty, setChannelsDirty] = useState(false);

  const isSaving = mutations.patchConfig.isPending;
  const isSavingChannels = mutations.patchChannels.isPending;
  const isDestroying = status.status === 'destroying';
  const isRunning = status.status === 'running';

  const telegramConfigured = config?.channels?.telegram ?? false;

  function handleSaveChannels() {
    const trimmed = telegramBotToken.trim();
    if (!trimmed) {
      toast.error('Enter a bot token or use Remove to clear it.');
      return;
    }
    mutations.patchChannels.mutate(
      { telegramBotToken: trimmed },
      {
        onSuccess: () => {
          toast.success('Telegram token saved. Restart to apply.');
          setTelegramBotToken('');
          setChannelsDirty(true);
        },
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  function handleRemoveTelegram() {
    mutations.patchChannels.mutate(
      { telegramBotToken: null },
      {
        onSuccess: () => {
          toast.success('Telegram token removed. Restart to apply.');
          setTelegramBotToken('');
          setChannelsDirty(true);
        },
        onError: err => toast.error(`Failed to remove: ${err.message}`),
      }
    );
  }

  function handleSave() {
    posthog?.capture('claw_save_config_clicked', {
      selected_model: selectedModel || null,
      instance_status: status.status,
    });

    if (isLoadingModels) {
      toast.error('Models are still loading; try again in a moment.');
      return;
    }

    const modelsPayload = modelOptions.map(({ id, name }) => ({ id, name }));
    mutations.patchConfig.mutate(
      {
        kilocodeDefaultModel: selectedModel ? `kilocode/${selectedModel}` : null,
        kilocodeModels: modelsPayload.length > 0 ? modelsPayload : null,
      },
      {
        onSuccess: () => toast.success('Configuration saved'),
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">KiloCode Configuration</h3>
        <p className="text-muted-foreground mb-4 text-xs">
          API key is platform-managed and refreshed during save.
        </p>

        <div className="space-y-4">
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
              {isSaving ? 'Saving...' : 'Save & Provision'}
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

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="settings-telegram-token" className="w-32 shrink-0">
              Telegram
            </Label>
            <span className="text-muted-foreground text-xs">
              {telegramConfigured ? 'Configured' : 'Not configured'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                id="settings-telegram-token"
                type="text"
                placeholder={
                  telegramConfigured ? 'Enter new token to replace' : '123456:ABC-DEF...'
                }
                value={telegramBotToken}
                onChange={e => setTelegramBotToken(e.target.value)}
                disabled={isSavingChannels}
                data-1p-ignore
                autoComplete="off"
                className="pr-9"
                style={
                  showToken ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)
                }
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                tabIndex={-1}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleSaveChannels}
              disabled={isSavingChannels || !telegramBotToken.trim()}
            >
              <Save className="h-4 w-4" />
              {isSavingChannels ? 'Saving...' : 'Save'}
            </Button>
            {telegramConfigured && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemoveTelegram}
                disabled={isSavingChannels}
              >
                <X className="h-4 w-4" />
                Remove
              </Button>
            )}
          </div>

          <p className="text-muted-foreground text-xs">
            Get a token from{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              @BotFather
            </a>
            .{channelsDirty && ' Restart the instance for changes to take effect.'}
          </p>
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
    </div>
  );
}
