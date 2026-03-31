'use client';

import { useState } from 'react';
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
import { AnimatedDots } from './AnimatedDots';

function isNeedsRedeployError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof (error as { data?: unknown }).data === 'object' &&
    (error as { data?: { upstreamCode?: unknown } }).data !== null &&
    (error as { data: { upstreamCode?: unknown } }).data.upstreamCode ===
      'controller_route_unavailable'
  );
}

export function StartKiloCliRunDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const mutations = useKiloClawMutations();
  const startMutation = mutations.startKiloCliRun;
  const redeployMutation = mutations.restartMachine;

  const needsRedeploy = startMutation.isError && isNeedsRedeployError(startMutation.error);

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
      }
    );
  };

  const handleRedeploy = () => {
    redeployMutation.mutate(
      { imageTag: 'latest' },
      {
        onSuccess: () => {
          toast.success('Upgrading to latest version');
          onOpenChange(false);
        },
        onError: err => toast.error(err.message, { duration: 10000 }),
      }
    );
  };

  const handleOpenChange = (nextOpen: boolean) => {
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
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
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
            <div className="space-y-2">
              <Textarea
                placeholder="Describe the problem you're trying to solve (e.g. &quot;I can't connect to the gateway&quot; or &quot;The bot's cron jobs aren't checking in&quot;)"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="min-h-30 resize-none"
                maxLength={10_000}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleStart();
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
                disabled={!prompt.trim() || startMutation.isPending}
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
