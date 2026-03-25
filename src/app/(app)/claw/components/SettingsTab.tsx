'use client';

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FileCode,
  Hash,
  Info,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { calverAtLeast, cleanVersion, getRunningVersionBadge } from '@/lib/kiloclaw/version';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import {
  useControllerVersion,
  useKiloClawConfig,
  useKiloClawLatestVersion,
  useKiloClawMyPin,
} from '@/hooks/useKiloClaw';
import { useTRPC } from '@/lib/trpc/utils';
import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';
import { getSettingsModelOptions } from './modelSupport';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailTile } from './DetailTile';

import { getEntriesByCategory } from '@kilocode/kiloclaw-secret-catalog';
import { SecretEntrySection } from './SecretEntrySection';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { PairingSection } from './PairingSection';
import { VersionPinCard } from './VersionPinCard';
import { WorkspaceFileEditor } from './WorkspaceFileEditor';
import { PermissionPresetCards } from './PermissionPresetCards';
import { type ExecPreset, configToExecPreset, execPresetToConfig } from './claw.types';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

// ---------------------------------------------------------------------------
// 1Password setup guide dialog
// ---------------------------------------------------------------------------

function OnePasswordSetupGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Info className="h-3.5 w-3.5" />
          Setup Guide
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>1Password Setup</DialogTitle>
          <DialogDescription>
            Give your agent access to look up credentials and manage vault items.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <p className="text-amber-400 text-xs font-medium">
              Warning: this gives your agent read/write access to the vault(s) you grant. Create a
              dedicated vault with only the credentials your agent needs.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">1. Create a Service Account</p>
            <p className="text-muted-foreground text-xs">
              Go to{' '}
              <a
                href="https://developer.1password.com/docs/service-accounts/get-started/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                developer.1password.com
              </a>{' '}
              and create a new service account.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">2. Scope to a dedicated vault</p>
            <p className="text-muted-foreground text-xs">
              Grant the service account access to a dedicated &quot;Agent&quot; vault — not your
              primary vault. Only store credentials your agent needs in this vault.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">3. Copy the token</p>
            <p className="text-muted-foreground text-xs">
              Copy the service account token (starts with{' '}
              <code className="bg-muted rounded px-1">ops_</code>) and paste it into the field
              above.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">4. Save and upgrade</p>
            <p className="text-muted-foreground text-xs">
              After saving, use <strong>Upgrade to latest</strong> (not just Redeploy) to activate
              the integration. Your agent can then use the{' '}
              <code className="bg-muted rounded px-1">op</code> CLI to look up credentials, e.g.{' '}
              <code className="bg-muted rounded px-1">op item get &quot;My Login&quot;</code>.
            </p>
          </div>

          <p className="text-muted-foreground border-t pt-3 text-xs">
            Learn more at{' '}
            <a
              href="https://developer.1password.com/docs/service-accounts/get-started/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              1Password Service Accounts docs
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AgentCard setup guide dialog
// ---------------------------------------------------------------------------

function AgentCardSetupGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Info className="h-3.5 w-3.5" />
          Advanced Setup Required
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AgentCard Setup</DialogTitle>
          <DialogDescription>
            Give your agent the ability to create and spend virtual debit cards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <p className="text-amber-400 text-xs font-medium">
              Warning: this can permit your agent to spend real money. Use caution.
            </p>
            <p className="text-amber-400/70 mt-1 text-xs">
              AgentCard is currently in beta. Card issuance may be limited or waitlisted.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">1. Create an AgentCard account</p>
            <p className="text-muted-foreground text-xs">Run these commands:</p>
            <pre className="bg-muted mt-1 rounded-md p-2 text-xs">
              <code>npm install -g agent-cards{'\n'}agent-cards signup</code>
            </pre>
          </div>

          <div>
            <p className="mb-2 font-medium">2. Add a payment method</p>
            <p className="text-muted-foreground text-xs">
              Run <code className="bg-muted rounded px-1">agent-cards payment-method</code> to link
              a card via Stripe. This funds any virtual cards your agent creates.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">3. Copy your API key</p>
            <p className="text-muted-foreground text-xs">
              Open <code className="bg-muted rounded px-1">~/.agent-cards/config.json</code> and
              copy the <strong>jwt</strong> value into the field above.
            </p>
          </div>

          <div>
            <p className="mb-2 font-medium">4. Upgrade your instance</p>
            <p className="text-muted-foreground text-xs">
              This feature requires the most recent version of OpenClaw. After saving your
              credentials, use <strong>Upgrade</strong> (not Redeploy) to install the latest image
              and activate AgentCard. Your agent will then have access to tools like{' '}
              <code className="bg-muted rounded px-1">create_card</code>,{' '}
              <code className="bg-muted rounded px-1">list_cards</code>, and{' '}
              <code className="bg-muted rounded px-1">check_balance</code>.
            </p>
          </div>

          <p className="text-muted-foreground border-t pt-3 text-xs">
            Learn more at{' '}
            <a
              href="https://agentcard.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              agentcard.sh
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Google Account (collapsible card, matches SecretEntrySection card style)
// ---------------------------------------------------------------------------

function GoogleAccountCard({
  connected,
  gmailNotificationsEnabled,
  mutations,
  onRedeploy,
}: {
  connected: boolean;
  gmailNotificationsEnabled: boolean;
  mutations: ClawMutations;
  onRedeploy?: () => void;
}) {
  const trpc = useTRPC();
  const { data: setupData } = useQuery(
    trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      enabled: !connected,
      refetchInterval: 50 * 60 * 1000,
      refetchOnWindowFocus: false,
    })
  );
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const isDisconnecting = mutations.disconnectGoogle.isPending;
  const command = setupData?.command;

  function handleCopy() {
    if (!command) return;
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Google "G" icon as inline SVG
  const GoogleIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
            >
              <GoogleIcon className="h-5 w-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Google Account</span>
                  <Badge
                    variant={connected ? 'default' : 'secondary'}
                    className="px-1.5 py-0 text-[10px] leading-4"
                  >
                    {connected ? 'Connected' : 'Not connected'}
                  </Badge>
                </div>
                <span className="text-muted-foreground text-xs">
                  Access Gmail, Calendar, and Docs
                </span>
              </div>
              <ChevronDown
                className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
              />
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <Separator />
            <div className="space-y-4 px-4 py-3">
              {!connected && command && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">
                    Run this command in a terminal on your local machine to connect your Google
                    account:
                  </p>
                  <div className="relative">
                    <pre className="bg-muted overflow-x-auto rounded-md p-3 pr-10 text-xs">
                      <code>{command}</code>
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="absolute top-1 right-1 h-7 w-7 p-0"
                      onClick={handleCopy}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {connected && (
                <>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isDisconnecting}
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      <X className="h-4 w-4" />
                      {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                    </Button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-foreground text-sm font-medium">Gmail Notifications</h4>
                      <p className="text-muted-foreground text-xs">
                        Notify your bot when new emails arrive
                      </p>
                    </div>
                    <Button
                      variant={gmailNotificationsEnabled ? 'default' : 'outline'}
                      size="sm"
                      disabled={mutations.setGmailNotifications.isPending}
                      onClick={() => {
                        mutations.setGmailNotifications.mutate(
                          { enabled: !gmailNotificationsEnabled },
                          {
                            onSuccess: data => {
                              toast.success(
                                data.gmailNotificationsEnabled
                                  ? 'Gmail notifications enabled'
                                  : 'Gmail notifications disabled'
                              );
                            },
                            onError: err => toast.error(`Failed: ${err.message}`),
                          }
                        );
                      }}
                    >
                      {mutations.setGmailNotifications.isPending
                        ? 'Saving...'
                        : gmailNotificationsEnabled
                          ? 'Enabled'
                          : 'Disabled'}
                    </Button>
                  </div>
                </>
              )}

              {!connected && !command && (
                <p className="text-muted-foreground text-xs">Loading setup command...</p>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <ConfirmActionDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Google Account"
        description="This will remove your Google credentials. Reconnecting requires re-running the Docker setup flow (gcloud login, project setup, OAuth consent). Redeploy after disconnecting to apply."
        confirmLabel="Disconnect"
        confirmIcon={<X className="mr-1 h-4 w-4" />}
        isPending={isDisconnecting}
        pendingLabel="Disconnecting..."
        onConfirm={() => {
          mutations.disconnectGoogle.mutate(undefined, {
            onSuccess: () => {
              toast.success('Google account disconnected. Redeploy to apply.', {
                duration: 8000,
                ...(onRedeploy && {
                  action: { label: 'Redeploy', onClick: onRedeploy },
                }),
              });
              setConfirmDisconnect(false);
            },
            onError: err => toast.error(`Failed to disconnect: ${err.message}`),
          });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Default Permissions section
// ---------------------------------------------------------------------------

function PermissionPresetSection({
  isRunning,
  status,
  mutations,
  onRedeploy,
}: {
  isRunning: boolean;
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onRedeploy?: () => void;
}) {
  const currentPreset = configToExecPreset(status.execSecurity, status.execAsk);
  const [selected, setSelected] = useState<ExecPreset | null>(currentPreset);
  const saving = mutations.patchExecPreset.isPending || mutations.patchOpenclawConfig.isPending;
  const dirty = selected !== null && selected !== currentPreset;

  function handleSave() {
    if (!selected) return;
    const { security, ask } = execPresetToConfig(selected);

    // Persist to durable storage (survives redeploys)
    mutations.patchExecPreset.mutate(
      { security, ask },
      {
        onError: (err: { message: string }) => toast.error(`Failed to save: ${err.message}`),
      }
    );

    // Apply to the live openclaw.json if the instance is running
    if (isRunning) {
      mutations.patchOpenclawConfig.mutate(
        { patch: { tools: { exec: { security, ask } } } },
        {
          onSuccess: () => {
            toast.success('Default permissions saved. Redeploy to ensure the change persists.', {
              duration: 8000,
              ...(onRedeploy && {
                action: { label: 'Redeploy', onClick: onRedeploy },
              }),
            });
          },
          onError: (err: { message: string }) =>
            toast.error(`Saved to storage but failed to apply live: ${err.message}`),
        }
      );
    } else {
      toast.success(
        'Default permissions saved. Start your instance and redeploy for the change to take effect.'
      );
    }
  }

  return (
    <div>
      <h2 className="text-foreground mb-3 text-base font-semibold">Default Permissions</h2>
      <div className="rounded-lg border p-5">
        <p className="text-muted-foreground mb-1 text-sm">
          Choose how your bot handles actions by default. This sets the{' '}
          <strong className="text-foreground">default permission level</strong> for all tool
          executions.
        </p>
        <p className="mb-4 text-xs text-amber-400">
          You must redeploy your instance for this change to take effect.
        </p>
        <PermissionPresetCards selected={selected} onSelect={setSelected} />
        <div className="mt-4 flex justify-end">
          <Button size="sm" disabled={!dirty || saving} onClick={handleSave}>
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsTab
// ---------------------------------------------------------------------------

export function SettingsTab({
  status,
  mutations,
  onSecretsChanged,
  dirtySecrets,
  onRedeploy,
  onUpgrade,
  onRequestUpgrade,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  dirtySecrets: Set<string>;
  onRedeploy?: () => void;
  /** Callback that triggers an image upgrade (pull latest) instead of a plain restart. */
  onUpgrade?: () => void;
  /** Callback that requests an upgrade via the InstanceControls dialog. */
  onRequestUpgrade?: () => void;
}) {
  const posthog = usePostHog();
  const { data: config } = useKiloClawConfig();
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const isRunning = status.status === 'running';
  const {
    data: controllerVersion,
    isLoading: isLoadingControllerVersion,
    isError: isControllerVersionError,
  } = useControllerVersion(isRunning);
  const { data: myPin } = useKiloClawMyPin();
  const { data: latestVersion } = useKiloClawLatestVersion();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const trackedVersion = cleanVersion(status.openclawVersion);
  const runningVersion = cleanVersion(controllerVersion?.openclawVersion);
  const latestAvailableVersion = cleanVersion(latestVersion?.openclawVersion);
  const hasModelSelectionError = isRunning && isControllerVersionError;
  const modelSelectionError = hasModelSelectionError
    ? 'Failed to load the running OpenClaw version. Retry before changing the default model.'
    : undefined;
  const isLoadingModelSelection = isLoadingModels || (isRunning && isLoadingControllerVersion);
  const [editConfigOpen, setEditConfigOpen] = useState(false);
  const [manageVersionOpen, setManageVersionOpen] = useState(false);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getSettingsModelOptions({
        models: (modelsData?.data || []).map(model => ({ id: model.id, name: model.name })),
        trackedOpenClawVersion: trackedVersion,
        runningOpenClawVersion: runningVersion,
        isRunning,
        isLoadingRunningVersion: isLoadingControllerVersion,
        hasRunningVersionError: hasModelSelectionError,
      }),
    [
      hasModelSelectionError,
      isLoadingControllerVersion,
      isRunning,
      modelsData,
      runningVersion,
      trackedVersion,
    ]
  );

  const { selectedModel, setSelectedModel } = useDefaultModelSelection(
    config?.kilocodeDefaultModel,
    modelOptions
  );

  const configModel = config?.kilocodeDefaultModel?.replace(/^kilocode\//, '') ?? '';
  const [lastSavedModel, setLastSavedModel] = useState<string | null>(null);
  const savedModel = lastSavedModel ?? configModel;
  const modelDirty = selectedModel !== savedModel;
  const isSaving = mutations.patchConfig.isPending;
  const isStarting = status.status === 'starting';
  const isRestarting = status.status === 'restarting';
  const isDestroying = status.status === 'destroying';
  const supportsConfigRestore = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    '2026.2.26'
  );

  const configuredSecrets = config?.configuredSecrets ?? {};
  const toolEntries = getEntriesByCategory('tool');

  function handleSave() {
    if (hasModelSelectionError) {
      toast.error(modelSelectionError);
      return;
    }

    if (isLoadingModelSelection) {
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
        onSuccess: () => {
          setLastSavedModel(selectedModel);
          toast.success('Configuration saved. Model change applied.');
        },
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  useEffect(() => {
    if (!isRunning) setEditConfigOpen(false);
  }, [isRunning]);

  const needsImageUpgrade = isRunning && controllerVersion && !controllerVersion.version;
  const isModified = getRunningVersionBadge(runningVersion, trackedVersion) === 'modified';
  const catalogNewerThanImage =
    !!trackedVersion &&
    !!latestAvailableVersion &&
    latestAvailableVersion !== trackedVersion &&
    calverAtLeast(latestAvailableVersion, trackedVersion);
  const isPinned = !!myPin;
  const hasVersionInfo = isRunning && trackedVersion && trackedVersion !== ':latest';
  // Only compare image tags when variants match — latestVersion is always
  // for the "default" variant, so skip for non-default instances to avoid
  // false "Update available" badges that would switch their variant.
  const variantsMatch =
    !status.imageVariant ||
    status.imageVariant === 'default' ||
    status.imageVariant === latestVersion?.variant;
  const imageTagDiffers =
    hasVersionInfo &&
    variantsMatch &&
    !!status.trackedImageTag &&
    !!latestVersion?.imageTag &&
    status.trackedImageTag !== latestVersion.imageTag;
  const updateAvailable = catalogNewerThanImage
    ? !isModified ||
      (!!runningVersion &&
        calverAtLeast(latestAvailableVersion, runningVersion) &&
        latestAvailableVersion !== runningVersion)
    : imageTagDiffers;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Stats tiles ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DetailTile label="Env Vars" value={String(status.envVarCount)} icon={Hash} />
        <DetailTile label="Secrets" value={String(status.secretCount)} icon={Hash} />
        <DetailTile
          label="Channel Connected"
          value={String(status.channelCount)}
          icon={status.channelCount > 0 ? Check : Hash}
        />
      </div>

      {/* ── Pairing Requests ── */}
      {isRunning && <PairingSection mutations={mutations} />}

      {/* ── OpenClaw Instance card ── */}
      <div className="rounded-lg border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="text-muted-foreground h-5 w-5 shrink-0" />
            <div>
              <p className="text-sm font-medium">OpenClaw Instance</p>
              {hasVersionInfo && (
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  <span>
                    Version:{' '}
                    <strong className="text-foreground">{runningVersion ?? trackedVersion}</strong>
                  </span>
                  <span className="text-muted-foreground/40">|</span>
                  <span>
                    Variant:{' '}
                    <strong className="text-foreground">{status.imageVariant || 'default'}</strong>
                  </span>
                  <span className="text-muted-foreground/40">|</span>
                  {isPinned ? (
                    <span className="text-amber-400">Pinned</span>
                  ) : (
                    <span className="text-green-400">Following latest</span>
                  )}
                  {needsImageUpgrade && (
                    <Badge
                      variant="outline"
                      className="border-blue-500/30 bg-blue-500/15 text-blue-400"
                    >
                      Upgrade required
                    </Badge>
                  )}
                  {updateAvailable && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" onClick={onRequestUpgrade} className="cursor-pointer">
                          <Badge
                            variant="outline"
                            className="border-orange-500/30 bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
                          >
                            Update available
                          </Badge>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {catalogNewerThanImage
                            ? `A newer OpenClaw version (${latestAvailableVersion}) is available — click to upgrade`
                            : `A newer image (${latestVersion?.imageTag ?? 'unknown'}) is available — click to upgrade`}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {isModified && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="border-zinc-500/30 bg-zinc-500/15 text-zinc-400"
                        >
                          Modified
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          OpenClaw was self-updated on this machine — redeploying will revert to the
                          image version ({trackedVersion})
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setManageVersionOpen(v => !v)}>
            Manage Version
          </Button>
        </div>

        {/* Expandable version pinning */}
        {manageVersionOpen && (
          <div className="mt-4 border-t pt-4">
            <VersionPinCard
              trackedImageTag={status.trackedImageTag}
              latestImageTag={variantsMatch ? (latestVersion?.imageTag ?? null) : null}
            />
          </div>
        )}
      </div>

      {/* ── Model Configuration ── */}
      <div>
        <h2 className="text-foreground mb-3 text-base font-semibold">Model Configuration</h2>
        <div className="rounded-lg border px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Default Model</p>
              <p className="text-muted-foreground text-xs">
                Used for new conversations. Can be changed per-conversation.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ModelCombobox
                label=""
                models={modelOptions}
                value={selectedModel}
                onValueChange={setSelectedModel}
                error={modelSelectionError}
                isLoading={isLoadingModelSelection}
                disabled={isSaving || isLoadingModelSelection || hasModelSelectionError}
                className="min-w-0 flex-1 sm:min-w-[300px]"
              />
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || hasModelSelectionError || !modelDirty}
                variant={modelDirty ? 'default' : 'outline'}
              >
                <Save className="h-4 w-4" />
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Default Permissions ── */}
      <PermissionPresetSection
        isRunning={isRunning}
        status={status}
        mutations={mutations}
        onRedeploy={onRedeploy}
      />

      {/* ── Messaging Channels ── */}
      <div>
        <h2 className="text-foreground mb-3 text-base font-semibold">Messaging Channels</h2>
        <div className="space-y-3">
          {getEntriesByCategory('channel').map(entry => (
            <SecretEntrySection
              key={entry.id}
              entry={entry}
              configured={configuredSecrets[entry.id] ?? false}
              mutations={mutations}
              onSecretsChanged={onSecretsChanged}
              isDirty={dirtySecrets.has(entry.id)}
              onRedeploy={onRedeploy}
            />
          ))}
        </div>
      </div>

      {/* ── Search ── */}
      {toolEntries.some(e => e.id === 'brave-search') && (
        <div>
          <h2 className="text-foreground mb-3 text-base font-semibold">Search</h2>
          <div className="space-y-3">
            {toolEntries
              .filter(e => e.id === 'brave-search')
              .map(entry => (
                <SecretEntrySection
                  key={entry.id}
                  entry={entry}
                  configured={configuredSecrets[entry.id] ?? false}
                  mutations={mutations}
                  onSecretsChanged={onSecretsChanged}
                  isDirty={dirtySecrets.has(entry.id)}
                />
              ))}
          </div>
        </div>
      )}

      {/* ── Developer Tools ── */}
      {toolEntries.some(e => e.id === 'github') && (
        <div>
          <h2 className="text-foreground mb-3 text-base font-semibold">Developer Tools</h2>
          <div className="space-y-3">
            {toolEntries
              .filter(e => e.id === 'github')
              .map(entry => (
                <SecretEntrySection
                  key={entry.id}
                  entry={entry}
                  configured={configuredSecrets[entry.id] ?? false}
                  mutations={mutations}
                  onSecretsChanged={onSecretsChanged}
                  isDirty={dirtySecrets.has(entry.id)}
                  onRedeploy={onRedeploy}
                  actionRowExtra={
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                      We recommend using a{' '}
                      <a
                        href="https://docs.github.com/en/get-started/start-your-journey/creating-an-account-on-github"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        dedicated account
                      </a>{' '}
                      with a{' '}
                      <a
                        href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        fine-grained token
                      </a>{' '}
                      minimally scoped to specific repos and permissions.
                    </span>
                  }
                />
              ))}
          </div>
        </div>
      )}

      {/* ── Payments ── */}
      {toolEntries.some(e => e.id === 'agentcard') && (
        <div>
          <h2 className="text-foreground mb-3 text-base font-semibold">Payments</h2>
          <div className="space-y-3">
            {toolEntries
              .filter(e => e.id === 'agentcard')
              .map(entry => (
                <SecretEntrySection
                  key={entry.id}
                  entry={entry}
                  configured={configuredSecrets[entry.id] ?? false}
                  mutations={mutations}
                  onSecretsChanged={onSecretsChanged}
                  isDirty={dirtySecrets.has(entry.id)}
                  onRedeploy={onUpgrade ?? onRedeploy}
                  redeployLabel="Upgrade"
                  actionRowExtra={<AgentCardSetupGuide />}
                />
              ))}
          </div>
        </div>
      )}

      {/* ── Password Managers ── */}
      {toolEntries.some(e => e.id === 'onepassword') && (
        <div>
          <h2 className="text-foreground mb-3 text-base font-semibold">Password Managers</h2>
          <div className="space-y-3">
            {toolEntries
              .filter(e => e.id === 'onepassword')
              .map(entry => (
                <SecretEntrySection
                  key={entry.id}
                  entry={entry}
                  configured={configuredSecrets[entry.id] ?? false}
                  mutations={mutations}
                  onSecretsChanged={onSecretsChanged}
                  isDirty={dirtySecrets.has(entry.id)}
                  actionRowExtra={<OnePasswordSetupGuide />}
                />
              ))}
          </div>
        </div>
      )}

      {/* ── Productivity ── */}
      <div>
        <h2 className="text-foreground mb-3 text-base font-semibold">Productivity</h2>
        <div className="space-y-3">
          <GoogleAccountCard
            connected={status.googleConnected}
            gmailNotificationsEnabled={status.gmailNotificationsEnabled}
            mutations={mutations}
            onRedeploy={onRedeploy}
          />
        </div>
      </div>

      {/* ── Danger Zone ── */}
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
                        isDestroying ||
                        isRestarting
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
                disabled={!isRunning || isDestroying || isRestarting}
                onClick={() => setEditConfigOpen(true)}
              >
                <FileCode className="h-4 w-4" />
                Edit Files
              </Button>

              <Button
                variant="outline"
                size="sm"
                disabled={
                  !isRunning ||
                  mutations.stop.isPending ||
                  isDestroying ||
                  isStarting ||
                  isRestarting
                }
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

            {editConfigOpen && (
              <div className="mt-4">
                <WorkspaceFileEditor
                  enabled={isRunning}
                  mutations={mutations}
                  onOpenChange={setEditConfigOpen}
                />
              </div>
            )}
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
                setEditConfigOpen(false);
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
