'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, RotateCw, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useKiloClawMutations } from '@/hooks/useKiloClaw';
import type { PlatformStatusResponse } from '@/lib/kiloclaw/types';
import { AnimatedDots } from './AnimatedDots';

function getErrorUpstreamCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined;
  const data = (error as Record<string, unknown>).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as Record<string, unknown>).upstreamCode;
  return typeof code === 'string' ? code : undefined;
}

export function StartKiloCliRunDialog({
  open,
  onOpenChange,
  machineStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineStatus: PlatformStatusResponse['status'];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const mutations = useKiloClawMutations();
  const startMutation = mutations.startKiloCliRun;
  const redeployMutation = mutations.restartMachine;

  const needsRedeploy =
    startMutation.isError &&
    getErrorUpstreamCode(startMutation.error) === 'controller_route_unavailable';
  const machineReady = machineStatus === 'running';

  // Clear stale "needs redeploy" error when the machine status changes away
  // from running (e.g. restarting after a redeploy was dispatched). This
  // ensures reopening the dialog shows the prompt form, not the old error.
  useEffect(() => {
    if (needsRedeploy && machineStatus !== 'running') {
      startMutation.reset();
    }
  }, [needsRedeploy, machineStatus, startMutation]);

  const handleStart = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    startMutation.mutate(
      { prompt: trimmed },
      {
        onSuccess: data => {
          onOpenChange(false);
          router.push(`/claw/kilo-cli-run/${data.id}`);
        },
        onError: err => {
          // controller_route_unavailable triggers the inline redeploy UI; skip the toast to avoid duplicating it
          if (getErrorUpstreamCode(err) !== 'controller_route_unavailable') {
            toast.error(err.message);
          }
        },
      }
    );
  };

  const handleRedeploy = () => {
    redeployMutation.mutate(
      { imageTag: 'latest' },
      {
        onSuccess: () => {
          startMutation.reset();
        },
        onError: err => toast.error(err.message, { duration: 10000 }),
      }
    );
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && redeployMutation.isPending) return;
    if (!nextOpen) {
      setPrompt('');
      startMutation.reset();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-137.5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Recover with Kilo CLI Agent
          </DialogTitle>
          <DialogDescription>
            {needsRedeploy
              ? 'Your instance needs to be redeployed before the recovery agent can run.'
              : !machineReady
                ? 'Waiting for your instance to come back online before the recovery agent can run.'
                : 'If your KiloClaw instance is stuck or failing, the Kilo CLI agent can help diagnose and fix the problem. Describe the issue below and the agent will work autonomously to resolve it.'}
          </DialogDescription>
        </DialogHeader>

        {needsRedeploy ? (
          <>
            <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-sm text-amber-200">
                Your KiloClaw instance is running an older version that doesn&apos;t support the
                recovery agent. Upgrade to the latest version to use this feature.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={redeployMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                className="border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
                onClick={handleRedeploy}
                disabled={redeployMutation.isPending}
              >
                {redeployMutation.isPending ? (
                  <>
                    Upgrading
                    <AnimatedDots />
                  </>
                ) : (
                  <>
                    <RotateCw className="h-4 w-4" />
                    Upgrade &amp; Redeploy
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {!machineReady && (
              <div className="flex items-start gap-3 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
                <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-blue-400" />
                <p className="text-sm text-blue-200">
                  Your instance is restarting. The recovery agent will be available once it&apos;s
                  back online.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Textarea
                placeholder="Describe the problem you're trying to solve (e.g. &quot;I can't connect to the gateway&quot; or &quot;The bot's cron jobs aren't checking in&quot;)"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="min-h-30 resize-none"
                maxLength={10_000}
                autoFocus
                disabled={!machineReady}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleStart();
                  }
                }}
              />
              <p className="text-muted-foreground text-xs">
                Press Cmd+Enter to start. The agent will attempt to fix the issue using{' '}
                <code className="text-[11px]">kilo run --auto</code>.
              </p>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStart}
                disabled={!machineReady || !prompt.trim() || startMutation.isPending}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {startMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Terminal className="h-4 w-4" />
                    Run Recovery
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
