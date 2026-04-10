'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpCircle,
  Check,
  Cpu,
  HardDrive,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Stethoscope,
  Terminal,
  X,
} from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { Banner } from '@/components/shared/Banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  useKiloCliRunHistory,
  useKiloCliRunStatus,
  type useKiloClawMutations,
} from '@/hooks/useKiloClaw';
import { useOrgKiloCliRunHistory, useOrgKiloCliRunStatus } from '@/hooks/useOrgKiloClaw';
import { selectCurrentCliRun } from '@/lib/kiloclaw/cli-run-selection';
import { useClawContext } from './ClawContext';
import { useClawUpdateAvailable } from '../hooks/useClawUpdateAvailable';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { RunDoctorDialog } from './RunDoctorDialog';
import { StartKiloCliRunDialog } from './StartKiloCliRunDialog';
import { AnimatedDots } from './AnimatedDots';
import { OpenClawButton } from './OpenClawButton';

const VOLUME_SIZE_GB = 10;
// Default machine spec fallback (matches kiloclaw DEFAULT_MACHINE_GUEST)
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 3072;

function useCurrentCliRun(
  organizationId: string | undefined,
  instanceId: string | undefined,
  enabled: boolean
) {
  const personalHistory = useKiloCliRunHistory(enabled && organizationId === undefined);
  const orgHistory = useOrgKiloCliRunHistory(
    organizationId,
    enabled && organizationId !== undefined
  );

  if (!instanceId) {
    return null;
  }

  const runs = organizationId === undefined ? personalHistory.data?.runs : orgHistory.data?.runs;

  return selectCurrentCliRun(runs, instanceId);
}

function formatRunStatus(status: string | null): string {
  switch (status) {
    case 'running':
      return 'in progress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function runBannerColor(status: string | null) {
  switch (status) {
    case 'running':
      return 'blue' as const;
    case 'completed':
      return 'emerald' as const;
    case 'cancelled':
      return 'amber' as const;
    case 'failed':
      return 'red' as const;
    default:
      return 'blue' as const;
  }
}

function isTerminalCliRun(status: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function getRunCompletedAt(run: {
  completed_at?: string | null;
  started_at?: string | null;
}): string | null {
  return run.completed_at ?? run.started_at ?? null;
}

const CLI_RUN_BANNER_TTL_MS = 24 * 60 * 60 * 1000;

type CliRunBannerDismissal = {
  expiresAt: number;
};

function getCliRunBannerExpiry(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }

  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time + CLI_RUN_BANNER_TTL_MS : null;
}

function isCliRunBannerDismissed(key: string | null, expiresAt: number | null): boolean {
  if (!key || !expiresAt || typeof window === 'undefined') {
    return false;
  }

  const raw = localStorage.getItem(key);
  if (!raw) {
    return false;
  }

  if (Date.now() >= expiresAt) {
    localStorage.removeItem(key);
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'expiresAt' in parsed &&
      typeof (parsed as CliRunBannerDismissal).expiresAt === 'number' &&
      Date.now() >= (parsed as CliRunBannerDismissal).expiresAt
    ) {
      localStorage.removeItem(key);
      return false;
    }
  } catch {
    localStorage.removeItem(key);
    return false;
  }

  return true;
}

function dismissCliRunBanner(key: string, expiresAt: number): void {
  const value = { expiresAt } satisfies CliRunBannerDismissal;
  localStorage.setItem(key, JSON.stringify(value));
}

function formatMemory(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function InstanceControls({
  status,
  mutations,
  onRedeploySuccess,
  upgradeRequested,
  onUpgradeHandled,
  gatewayReady,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onRedeploySuccess?: () => void;
  upgradeRequested?: boolean;
  onUpgradeHandled?: () => void;
  gatewayReady?: boolean;
}) {
  const posthog = usePostHog();
  const gatewayUrl = useGatewayUrl(status);
  const { organizationId, currentRunPath } = useClawContext();
  const isRunning = status.status === 'running';
  const currentRun = useCurrentCliRun(organizationId, status.instanceId ?? undefined, isRunning);
  const personalRunStatus = useKiloCliRunStatus(
    organizationId === undefined ? (currentRun?.id ?? null) : null
  );
  const orgRunStatus = useOrgKiloCliRunStatus(
    organizationId ?? '',
    organizationId !== undefined ? (currentRun?.id ?? null) : null
  );
  const liveRunStatus = organizationId === undefined ? personalRunStatus.data : orgRunStatus.data;
  const currentRunStatus = liveRunStatus?.hasRun ? liveRunStatus.status : currentRun?.status;
  const currentRunCompletedAt = liveRunStatus?.hasRun
    ? (liveRunStatus.completedAt ?? currentRun?.completed_at ?? currentRun?.started_at ?? null)
    : getRunCompletedAt(currentRun ?? {});
  const activeRun = currentRun && currentRunStatus === 'running' ? currentRun : null;
  const currentRunHref = currentRun && currentRunPath ? `${currentRunPath}/${currentRun.id}` : null;
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const runDismissKey = currentRun ? `claw-cli-run-banner-dismissed:${currentRun.id}` : null;
  const runBannerExpiresAt = getCliRunBannerExpiry(currentRunCompletedAt);
  const terminalRunVisible =
    currentRun &&
    isTerminalCliRun(currentRunStatus ?? null) &&
    dismissedRunId !== currentRun.id &&
    runBannerExpiresAt !== null &&
    Date.now() < runBannerExpiresAt &&
    !isCliRunBannerDismissed(runDismissKey, runBannerExpiresAt);
  const showRunBanner = activeRun !== null || terminalRunVisible;
  const isProvisioned = status.status === 'provisioned';
  const isStarting = status.status === 'starting';
  const isRestarting = status.status === 'restarting';
  const isRecovering = status.status === 'recovering';
  const isStopped = status.status === 'stopped';
  const isStartable = isStopped || isProvisioned;
  const isDestroying = status.status === 'destroying';
  // Auto-start runs only on fresh provision (status=provisioned), not re-provision
  const isAutoStarting = isProvisioned && mutations.provision.isPending;
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [kiloRunOpen, setKiloRunOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const [redeployMode, setRedeployMode] = useState<'redeploy' | 'upgrade'>('redeploy');

  const { updateAvailable, catalogNewerThanImage, latestAvailableVersion, latestVersion } =
    useClawUpdateAvailable(status);

  const upgradeVersion = latestAvailableVersion ?? latestVersion?.imageTag ?? '';
  const dismissKey = `claw-upgrade-banner-dismissed:${upgradeVersion}`;

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  const isDismissedInStorage = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const raw = localStorage.getItem(dismissKey);
    if (!raw) return false;
    return Date.now() - Number(raw) < TWENTY_FOUR_HOURS_MS;
  }, [dismissKey]);

  const [manuallyDismissed, setManuallyDismissed] = useState(false);

  // Reset the in-session dismiss flag when the target version changes.
  useEffect(() => {
    setManuallyDismissed(false);
  }, [dismissKey]);

  const dismissBanner = useCallback(() => {
    localStorage.setItem(dismissKey, String(Date.now()));
    setManuallyDismissed(true);
  }, [dismissKey]);

  const showUpgradeBanner = updateAvailable && !isDismissedInStorage && !manuallyDismissed;

  const handleSaveName = () => {
    const trimmed = nameValue.trim();
    mutations.rename.mutate(
      { name: trimmed || null },
      {
        onSuccess: () => {
          setIsEditingName(false);
          toast.success('Instance renamed');
        },
        onError: err => {
          toast.error(err.message);
        },
      }
    );
  };

  // Toggle-flag pattern: parent sets upgradeRequested=true, we open the dialog
  // with "upgrade" preselected, then immediately reset via onUpgradeHandled.
  // Safe for single-click flows; won't re-fire if already true (no state change).
  useEffect(() => {
    if (upgradeRequested) {
      setRedeployMode('upgrade');
      setConfirmRedeploy(true);
      onUpgradeHandled?.();
    }
  }, [upgradeRequested, onUpgradeHandled]);

  return (
    <div>
      <div className="flex items-center gap-2">
        {isEditingName ? (
          <>
            <Input
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              maxLength={50}
              className="h-8 w-64"
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') {
                  setIsEditingName(false);
                  setNameValue(status.name ?? '');
                }
              }}
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSaveName}>
              <Check className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setIsEditingName(false);
                setNameValue(status.name ?? '');
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">{status.name || 'Unnamed instance'}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                setNameValue(status.name ?? '');
                setIsEditingName(true);
              }}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h3 className="text-foreground mb-1 text-sm font-medium">Instance Controls</h3>
          <p className="text-muted-foreground text-xs">Manage power state and gateway lifecycle.</p>
        </div>
        <div className="flex w-full justify-around gap-2 sm:w-auto sm:justify-end">
          <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
            <Cpu className="h-3.5 w-3.5" />
            {status.machineSize?.cpus ?? DEFAULT_CPUS} vCPU,{' '}
            {formatMemory(status.machineSize?.memory_mb ?? DEFAULT_MEMORY_MB)} RAM
          </Badge>
          <Badge variant="outline" className="text-muted-foreground gap-1.5 font-normal">
            <HardDrive className="h-3.5 w-3.5" />
            {VOLUME_SIZE_GB} GB SSD
          </Badge>
        </div>
      </div>
      {showUpgradeBanner && (
        <Banner color="amber" className="mb-4">
          <Banner.Icon>
            <ArrowUpCircle />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title>
              {catalogNewerThanImage
                ? `A newer OpenClaw version (${latestAvailableVersion}) is available`
                : `A newer image (${latestVersion?.imageTag ?? 'unknown'}) is available`}
            </Banner.Title>
            <Banner.Description>
              Upgrade your instance to get the latest features and fixes.
            </Banner.Description>
          </Banner.Content>
          <Banner.Button
            className="text-white"
            onClick={() => {
              setRedeployMode('upgrade');
              setConfirmRedeploy(true);
            }}
          >
            Upgrade now
          </Banner.Button>
          <button
            type="button"
            onClick={dismissBanner}
            className="text-amber-400/60 hover:text-amber-400 transition-colors"
            aria-label="Dismiss upgrade banner"
          >
            <X className="h-4 w-4" />
          </button>
        </Banner>
      )}
      {showRunBanner && currentRun && currentRunHref && (
        <Banner color={runBannerColor(currentRunStatus ?? null)} className="mb-4">
          <Banner.Icon>
            <Terminal />
          </Banner.Icon>
          <Banner.Content>
            <Banner.Title className="flex items-center gap-2">
              Recovery run {formatRunStatus(currentRunStatus ?? null)}
              {currentRun.initiated_by === 'admin' && (
                <Badge variant="secondary">Admin-initiated</Badge>
              )}
            </Banner.Title>
            <Banner.Description>
              {currentRunStatus === 'running'
                ? 'A Kilo CLI recovery run is already running on this instance. You can open the live output to monitor progress or cancel it.'
                : 'The most recent Kilo CLI recovery run has stopped. You can view its output or start a new run.'}
            </Banner.Description>
          </Banner.Content>
          <Banner.Button href={currentRunHref} className="text-white">
            View run
          </Banner.Button>
          {isTerminalCliRun(currentRunStatus ?? null) && runDismissKey && runBannerExpiresAt && (
            <button
              type="button"
              onClick={() => {
                dismissCliRunBanner(runDismissKey, runBannerExpiresAt);
                setDismissedRunId(currentRun.id);
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Dismiss recovery run banner"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </Banner>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <OpenClawButton
          canShow={isRunning && !!gatewayReady}
          gatewayUrl={gatewayUrl}
          label="Open Control UI"
          className="h-8 px-3 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          disabled={
            !isStartable ||
            mutations.start.isPending ||
            isAutoStarting ||
            isDestroying ||
            isStarting ||
            isRestarting ||
            isRecovering
          }
          onClick={() => {
            posthog?.capture('claw_start_instance_clicked', { instance_status: status.status });
            mutations.start.mutate(undefined, {
              onError: err => toast.error(err.message, { duration: 10000 }),
            });
          }}
        >
          <Play className="h-4 w-4" />
          {mutations.start.isPending || isAutoStarting || isStarting ? (
            <>
              Starting
              <AnimatedDots />
            </>
          ) : (
            'Start Machine'
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
          disabled={
            !isRunning ||
            mutations.restartOpenClaw.isPending ||
            isDestroying ||
            isStarting ||
            isRestarting ||
            isRecovering
          }
          onClick={() => {
            posthog?.capture('claw_restart_openclaw_prompted', {
              instance_status: status.status,
            });
            setConfirmRestart(true);
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Restart OpenClaw
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          disabled={
            (!isRunning && !isStopped) ||
            !status.flyMachineId ||
            mutations.restartMachine.isPending ||
            isDestroying ||
            isStarting ||
            isRestarting ||
            isRecovering
          }
          onClick={() => {
            posthog?.capture('claw_redeploy_prompted', { instance_status: status.status });
            setRedeployMode('redeploy');
            setConfirmRedeploy(true);
          }}
        >
          <RotateCw className="h-4 w-4" />
          Redeploy or Upgrade
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300"
          disabled={
            !isRunning ||
            mutations.runDoctor.isPending ||
            isDestroying ||
            isStarting ||
            isRestarting ||
            isRecovering
          }
          onClick={() => {
            posthog?.capture('claw_doctor_clicked', { instance_status: status.status });
            setDoctorOpen(true);
          }}
        >
          <Stethoscope className="h-4 w-4" />
          OpenClaw Doctor
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
          disabled={
            !isRunning ||
            isDestroying ||
            isStarting ||
            isRestarting ||
            isRecovering ||
            activeRun !== null
          }
          onClick={() => {
            posthog?.capture('claw_kilo_run_clicked', { instance_status: status.status });
            setKiloRunOpen(true);
          }}
        >
          <Terminal className="h-4 w-4" />
          Recover with Kilo
        </Button>
      </div>
      <ConfirmActionDialog
        open={confirmRestart}
        onOpenChange={open => {
          if (!open) posthog?.capture('claw_restart_openclaw_cancelled');
          setConfirmRestart(open);
        }}
        title="Restart OpenClaw"
        description="This will restart the gateway process inside the running machine. Active sessions will be briefly interrupted and reconnect automatically."
        confirmLabel="Restart"
        confirmIcon={<RefreshCw className="h-4 w-4" />}
        isPending={mutations.restartOpenClaw.isPending}
        pendingLabel="Restarting"
        className="border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300"
        onConfirm={() => {
          posthog?.capture('claw_restart_openclaw_clicked', {
            instance_status: status.status,
          });
          mutations.restartOpenClaw.mutate(undefined, {
            onSuccess: () => {
              toast.success('OpenClaw restarting');
              setConfirmRestart(false);
            },
            onError: err => toast.error(err.message, { duration: 10000 }),
          });
        }}
      />
      <Dialog
        open={confirmRedeploy}
        onOpenChange={open => {
          if (mutations.restartMachine.isPending) return;
          if (!open) posthog?.capture('claw_redeploy_cancelled');
          setConfirmRedeploy(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Redeploy or Upgrade</DialogTitle>
            <DialogDescription>
              This will stop the machine, rebuild environment variables and secrets, and restart it.
              The machine will be briefly offline.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            value={redeployMode}
            onValueChange={v => {
              if (v === 'redeploy' || v === 'upgrade') setRedeployMode(v);
            }}
            className="gap-3 py-2"
          >
            <div className="flex items-start gap-3">
              <RadioGroupItem value="redeploy" id="redeploy" className="mt-0.5" />
              <Label htmlFor="redeploy" className="block cursor-pointer leading-tight">
                <span className="text-foreground text-sm font-medium">Redeploy</span>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  Restart with your current version of KiloClaw and apply pending config changes.
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="upgrade" id="upgrade" className="mt-0.5" />
              <Label htmlFor="upgrade" className="block cursor-pointer leading-tight">
                <span className="text-foreground text-sm font-medium">Upgrade to latest</span>
                <span className="text-muted-foreground mt-0.5 block text-xs">
                  Upgrade to the latest supported KiloClaw version, redeploy and apply pending
                  config changes.
                </span>
              </Label>
            </div>
          </RadioGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRedeploy(false)}
              disabled={mutations.restartMachine.isPending}
            >
              Cancel
            </Button>
            <Button
              className="border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
              onClick={() => {
                const imageTag = redeployMode === 'upgrade' ? 'latest' : undefined;
                posthog?.capture('claw_redeploy_clicked', {
                  instance_status: status.status,
                  redeploy_mode: redeployMode,
                });
                mutations.restartMachine.mutate(imageTag ? { imageTag } : undefined, {
                  onSuccess: () => {
                    toast.success(
                      redeployMode === 'upgrade' ? 'Upgrading to latest image' : 'Redeploying'
                    );
                    setConfirmRedeploy(false);
                    onRedeploySuccess?.();
                  },
                  onError: err => toast.error(err.message, { duration: 10000 }),
                });
              }}
              disabled={mutations.restartMachine.isPending || isRestarting || isRecovering}
            >
              {mutations.restartMachine.isPending ? (
                <>
                  {redeployMode === 'redeploy' ? 'Redeploying' : 'Upgrading'}
                  <AnimatedDots />
                </>
              ) : isRestarting || isRecovering ? (
                <>
                  {isRecovering ? 'Recovering' : 'Restarting'}
                  <AnimatedDots />
                </>
              ) : (
                <>
                  <RotateCw className="h-4 w-4" />
                  {redeployMode === 'redeploy' ? 'Redeploy' : 'Upgrade & Redeploy'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RunDoctorDialog
        open={doctorOpen}
        onOpenChange={setDoctorOpen}
        mutation={mutations.runDoctor}
      />
      <StartKiloCliRunDialog
        open={kiloRunOpen}
        onOpenChange={setKiloRunOpen}
        machineStatus={status.status}
        organizationId={organizationId}
        mutations={mutations}
      />
    </div>
  );
}
