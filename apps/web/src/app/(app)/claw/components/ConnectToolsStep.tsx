'use client';

import { useState } from 'react';
import { Calendar, Check, Plug, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { OnboardingStepView } from './OnboardingStepView';

type ConnectToolsStepViewProps = {
  currentStep: number;
  totalSteps: number;
  status: 'not_configured' | 'disconnected' | 'connected' | 'error';
  loading: boolean;
  connecting: boolean;
  savingManual: boolean;
  readyToConnect: boolean;
  manualConfigured: boolean;
  onConnect: () => void;
  onSkip: () => void;
  onContinue: () => void;
  onSaveManualCredentials: (credentials: {
    composioUserApiKey: string;
    composioOrg: string;
  }) => void;
};

function statusLabel(status: ConnectToolsStepViewProps['status']): string {
  if (status === 'connected') return 'Connected';
  if (status === 'error') return "Couldn't verify";
  return 'Optional';
}

const brandPrimaryButtonClassName =
  'bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 focus-visible:ring-brand-primary/50';

export function ConnectToolsStepView({
  currentStep,
  totalSteps,
  status,
  loading,
  connecting,
  savingManual,
  readyToConnect,
  manualConfigured,
  onConnect,
  onSkip,
  onContinue,
  onSaveManualCredentials,
}: ConnectToolsStepViewProps) {
  const [showManual, setShowManual] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [org, setOrg] = useState('');
  const manualReady = userApiKey.trim().startsWith('uak_') && org.trim().length > 0;
  const connectionBlocked = !readyToConnect || loading;

  const primaryLabel = (() => {
    if (status === 'connected') return 'Continue';
    if (manualConfigured) return 'Continue with manual setup';
    if (connecting) return 'Opening Composio…';
    if (loading) return 'Checking connection…';
    if (!readyToConnect) return 'Waiting for instance setup';
    return 'Connect Google Calendar';
  })();

  function handlePrimaryAction() {
    if (status === 'connected' || manualConfigured) {
      onContinue();
      return;
    }
    onConnect();
  }

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Tools`}
      title="Connect Google Calendar"
      description="Kilo uses Composio to connect read-only calendar context to this sandbox."
    >
      <div className="border-border bg-card flex flex-col gap-5 rounded-lg border p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
              <Calendar className="h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-foreground text-base font-semibold">Google Calendar</h3>
                <span className="text-muted-foreground text-xs">Powered by Composio</span>
              </div>
              <p className="text-muted-foreground max-w-xl text-sm">
                Give your agent calendar context for briefings and time-aware tasks. Kilo requests
                read access only.
              </p>
            </div>
          </div>
          <span
            className={cn(
              'w-fit rounded-full px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase ring-1',
              status === 'connected'
                ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                : status === 'error'
                  ? 'bg-destructive/10 text-destructive ring-destructive/30'
                  : 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20'
            )}
          >
            {loading ? 'Checking' : statusLabel(status)}
          </span>
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
              <Check className="h-3 w-3" />
            </span>
            <div className="space-y-0.5">
              <p className="text-foreground font-medium">Read-only calendar context</p>
              <p className="text-muted-foreground text-xs">No event creation, edits, or deletes.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
              <Check className="h-3 w-3" />
            </span>
            <div className="space-y-0.5">
              <p className="text-foreground font-medium">Scoped to this sandbox</p>
              <p className="text-muted-foreground text-xs">
                Use Kilo-managed setup or your own Composio account.
              </p>
            </div>
          </div>
        </div>

        {status === 'error' ? (
          <div className="text-muted-foreground flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
            <TriangleAlert className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>We could not verify the Composio connection. Try again or skip for now.</span>
          </div>
        ) : null}

        {manualConfigured ? (
          <div className="text-muted-foreground border-border bg-muted/30 flex items-start gap-2 rounded-md border p-3 text-xs">
            <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your own Composio credentials are saved for this sandbox. Connect Google Calendar from
              the sandbox with <code className="font-mono">composio link google_calendar</code>.
            </span>
          </div>
        ) : null}

        {connectionBlocked && !manualConfigured && status !== 'connected' ? (
          <p className="text-muted-foreground text-xs">
            Instance setup is still running. You can skip this step and connect later.
          </p>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setShowManual(value => !value)}
            aria-expanded={showManual}
            className="text-muted-foreground hover:text-foreground flex items-start gap-2 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Plug className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span>Use your own Composio credentials</span>
              <span className="text-muted-foreground/80 text-xs font-normal">
                Advanced: signs the sandbox CLI into your Composio account.
              </span>
            </span>
          </button>
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => onSkip()}
              className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Skip for now
            </button>
            <Button
              variant="primary"
              disabled={
                status !== 'connected' && !manualConfigured && (connectionBlocked || connecting)
              }
              onClick={handlePrimaryAction}
              className={brandPrimaryButtonClassName}
            >
              {primaryLabel}
            </Button>
          </div>
        </div>

        {showManual ? (
          <div className="border-border flex flex-col gap-4 border-t pt-5">
            <div className="space-y-1">
              <h3 className="text-foreground text-sm font-semibold">
                Use your own Composio account
              </h3>
              <p className="text-muted-foreground text-sm">
                These credentials override Kilo-managed Composio for this sandbox. The CLI signs
                into your account; connect tools later with{' '}
                <code className="font-mono">composio link google_calendar</code>.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                User API key
                <Input
                  value={userApiKey}
                  onChange={event => setUserApiKey(event.target.value)}
                  placeholder="uak_..."
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Organization
                <Input
                  value={org}
                  onChange={event => setOrg(event.target.value)}
                  placeholder="org or workspace name"
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              {!readyToConnect ? (
                <p className="text-muted-foreground text-xs">
                  Wait for instance setup before saving credentials.
                </p>
              ) : (
                <span />
              )}
              <Button
                variant="outline"
                disabled={!manualReady || !readyToConnect || savingManual}
                onClick={() =>
                  onSaveManualCredentials({
                    composioUserApiKey: userApiKey.trim(),
                    composioOrg: org.trim(),
                  })
                }
              >
                {savingManual
                  ? 'Saving…'
                  : readyToConnect
                    ? 'Save Composio credentials'
                    : 'Waiting for instance setup'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </OnboardingStepView>
  );
}
