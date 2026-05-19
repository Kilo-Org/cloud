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

  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      stepLabel={`Step ${currentStep} of ${totalSteps} · Tools`}
      title="Connect tools."
      description="Kilo uses Composio to connect tools to this sandbox. Start with Google Calendar, or bring your own Composio account."
      showProvisioningBanner
    >
      <div className="flex flex-col gap-4">
        <div className="border-border bg-card flex flex-col gap-5 rounded-lg border p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border">
                <Calendar className="h-5 w-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <h3 className="text-foreground text-base font-semibold">Google Calendar</h3>
                <p className="text-muted-foreground text-xs">
                  Powered by Composio · connects to this sandbox only
                </p>
              </div>
            </div>
            <span
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                status === 'connected'
                  ? 'border-emerald-500/40 text-emerald-500'
                  : status === 'error'
                    ? 'border-destructive/40 text-destructive'
                    : 'border-amber-500/40 text-amber-500'
              )}
            >
              {loading ? 'Checking' : statusLabel(status)}
            </span>
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-emerald-500/60 bg-emerald-500/10 text-emerald-500">
                <Check className="h-3 w-3" />
              </div>
              <div>
                <p className="text-foreground font-medium">
                  Let your agent inspect calendar context
                </p>
                <p className="text-muted-foreground text-xs">
                  Useful for briefings, scheduling context, and time-aware tasks.
                </p>
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
                  Your own Composio credentials are saved for this sandbox. Google Calendar is not
                  connected through Kilo-managed onboarding; connect tools from the sandbox with{' '}
                  <code className="font-mono">composio link &lt;toolkit&gt;</code>.
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => setShowManual(value => !value)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm font-medium transition-colors"
            >
              <Plug className="h-4 w-4" />
              Use your own Composio credentials
            </button>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => onSkip()}
                className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
              >
                Skip for now
              </button>
              {status === 'connected' ? (
                <Button variant="primary" onClick={() => onContinue()}>
                  Continue
                </Button>
              ) : manualConfigured ? (
                <Button variant="primary" onClick={() => onContinue()}>
                  Continue with manual setup
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!readyToConnect || loading || connecting}
                  onClick={() => onConnect()}
                >
                  {connecting
                    ? 'Opening Composio…'
                    : readyToConnect
                      ? 'Connect Google Calendar'
                      : 'Setting up your instance…'}
                </Button>
              )}
            </div>
          </div>
        </div>

        {showManual ? (
          <div className="border-border bg-card flex flex-col gap-4 rounded-lg border p-5 sm:p-6">
            <div className="flex flex-col gap-1">
              <h3 className="text-foreground text-base font-semibold">
                Use your own Composio account
              </h3>
              <p className="text-muted-foreground text-sm">
                These credentials override Kilo's managed Composio identity for this sandbox. The
                CLI will sign into your account; connect tools later with{' '}
                <code className="font-mono">composio link &lt;toolkit&gt;</code>.
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
            <div className="flex justify-end">
              <Button
                variant="primary"
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
                    : 'Setting up your instance…'}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </OnboardingStepView>
  );
}
