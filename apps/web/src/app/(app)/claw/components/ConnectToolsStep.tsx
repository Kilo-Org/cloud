'use client';

import { useId, useState } from 'react';
import { Calendar, Check, ChevronDown, Plug, TriangleAlert } from 'lucide-react';
import { SECRET_CATALOG_MAP, validateFieldValue } from '@kilocode/kiloclaw-secret-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ChannelTokenInput } from './ChannelTokenInput';
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
  organizationContext: boolean;
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

const composioUserApiKeyPattern = SECRET_CATALOG_MAP.get('composio')?.fields.find(
  field => field.key === 'composioUserApiKey'
)?.validationPattern;

export function ConnectToolsStepView({
  currentStep,
  totalSteps,
  status,
  loading,
  connecting,
  savingManual,
  readyToConnect,
  manualConfigured,
  organizationContext,
  onConnect,
  onSkip,
  onContinue,
  onSaveManualCredentials,
}: ConnectToolsStepViewProps) {
  const manualPanelId = useId();
  const [showManual, setShowManual] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [org, setOrg] = useState('');
  const manualReady =
    validateFieldValue(userApiKey.trim(), composioUserApiKeyPattern) && org.trim().length > 0;
  const connectionBlocked = !readyToConnect || loading;

  const primaryLabel = (() => {
    if (status === 'connected') return 'Continue';
    if (manualConfigured) return 'Continue with manual setup';
    if (connecting) return 'Waiting for approval…';
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
      description="Connect calendar access for time-aware agent work. You review Google’s permission screen before approving."
    >
      <div className="flex flex-col gap-5">
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
                Kilo uses Composio to connect Google Calendar to this instance. The connection opens
                in a popup so you can return here when approval is complete.
              </p>
            </div>
          </div>
          <span
            className={cn(
              'w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wider uppercase ring-1',
              status === 'connected'
                ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                : status === 'error'
                  ? 'bg-destructive/10 text-destructive ring-destructive/30'
                  : 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/20'
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
              <p className="text-foreground font-medium">Review permissions with Google</p>
              <p className="text-muted-foreground text-xs">
                Google shows exactly what access Composio requests before you continue.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
              <Check className="h-3 w-3" />
            </span>
            <div className="space-y-0.5">
              <p className="text-foreground font-medium">
                {organizationContext
                  ? 'For you in this organization'
                  : 'For this OpenClaw instance'}
              </p>
              <p className="text-muted-foreground text-xs">
                {organizationContext
                  ? 'This connects Google Calendar for you in this organization context, not for every organization member.'
                  : 'Kilo-managed setup connects this OpenClaw instance to its Composio workspace.'}
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

        {status === 'connected' ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-300">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Google Calendar is connected. Continue to inbound email setup.</span>
          </div>
        ) : null}

        {connecting && status !== 'connected' ? (
          <div className="border-border bg-muted/30 text-muted-foreground flex items-start gap-2 rounded-md border p-3 text-xs">
            <Calendar className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Finish approving Google Calendar in the popup. This page will update when it closes.
            </span>
          </div>
        ) : null}

        {manualConfigured ? (
          <div className="text-muted-foreground border-border bg-muted/30 flex items-start gap-2 rounded-md border p-3 text-xs">
            <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your own Composio credentials are saved for this OpenClaw instance. Connect Google
              Calendar from the instance with{' '}
              <code className="font-mono">composio link googlecalendar</code>.
            </span>
          </div>
        ) : null}

        {connectionBlocked && !manualConfigured && status !== 'connected' ? (
          <p className="text-muted-foreground text-xs">
            Instance setup is still running. You can skip this step and connect later.
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setShowManual(value => !value)}
            disabled={connecting || savingManual}
            aria-expanded={showManual}
            aria-controls={manualPanelId}
            className="border-border bg-secondary/40 text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-9 w-fit items-center gap-2 rounded-md border px-3 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <Plug className="h-3.5 w-3.5 shrink-0" />
            <span>Advanced setup: use your own Composio account</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform',
                showManual && 'rotate-180'
              )}
            />
          </button>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => onSkip()}
              disabled={connecting || savingManual}
              className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              Skip for now
            </button>
            <Button
              variant="primary"
              disabled={
                savingManual ||
                (status !== 'connected' && !manualConfigured && (connectionBlocked || connecting))
              }
              onClick={handlePrimaryAction}
              className={brandPrimaryButtonClassName}
            >
              {primaryLabel}
            </Button>
          </div>
        </div>

        {showManual ? (
          <div id={manualPanelId} className="border-border flex flex-col gap-4 border-t pt-5">
            <div className="space-y-1">
              <h3 className="text-foreground text-sm font-semibold">
                Use your own Composio account
              </h3>
              <p className="text-muted-foreground text-sm">
                These credentials override Kilo-managed Composio for this OpenClaw instance. Once
                the instance is online, ask the agent to run{' '}
                <code className="font-mono">composio link googlecalendar</code> if Google Calendar
                is not already linked in your Composio account.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                User API key
                <ChannelTokenInput
                  id="composio-user-api-key"
                  value={userApiKey}
                  onChange={setUserApiKey}
                  placeholder="uak_..."
                  disabled={savingManual}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Organization
                <Input
                  value={org}
                  onChange={event => setOrg(event.target.value)}
                  placeholder="org or workspace name"
                  autoComplete="off"
                  disabled={savingManual}
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
