'use client';

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  FileCode,
  Hash,
  Info,
  Newspaper,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OpenclawImportCard } from './OpenclawImportCard';

import { usePostHog } from 'posthog-js/react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import type { KiloClawDashboardStatus, MorningBriefingStatusLite } from '@/lib/kiloclaw/types';
import { morningBriefingStatusOk } from '@/lib/kiloclaw/types';
import { calverAtLeast, cleanVersion, controllerCalverSupports } from '@/lib/kiloclaw/version';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import {
  useClawConfig,
  useClawMyPin,
  useClawGatewayReady,
  useClawMorningBriefingStatus,
  useClawReadMorningBriefing,
} from '../hooks/useClawHooks';
import { useClawUpdateAvailable } from '../hooks/useClawUpdateAvailable';
import { useClawContext } from './ClawContext';

import { useDefaultModelSelection } from '../hooks/useDefaultModelSelection';
import { getSettingsModelOptions } from './modelSupport';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailTile } from './DetailTile';
import { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL } from './embeddingModels';
import {
  INTEREST_TOPIC_PRESETS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPICS,
  MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH,
  MORNING_BRIEFING_INTERESTS_MIN_CONTROLLER_VERSION,
} from '@/lib/kiloclaw/morning-briefing-interests';
import { deriveMorningBriefingCardState } from './morning-briefing-card-state';

import { getEntriesByCategory } from '@kilocode/kiloclaw-secret-catalog';
import { SecretEntrySection } from './SecretEntrySection';
import { ExaSearchEntrySection } from './ExaSearchEntrySection';
import { AnimatedDots } from './AnimatedDots';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { PairingSection } from './PairingSection';
import { VersionPinCard } from './VersionPinCard';
import { EarlyAccessCard } from './EarlyAccessCard';
import { WorkspaceFileEditor } from './WorkspaceFileEditor';
import { PermissionPresetCards } from './PermissionPresetCards';
import { CustomSecretsSection } from './CustomSecretsSection';
import { WebhookIntegrationSection } from './WebhookIntegrationSection';
import { type ExecPreset, configToExecPreset, execPresetToConfig } from './claw.types';
type ClawMutations = ReturnType<typeof useKiloClawMutations>;

const EXA_SEARCH_UI_MIN_CONTROLLER_VERSION = '2026.4.14';
const MEMORY_MIN_OPENCLAW_VERSION = '2026.4.5';
const OPENCLAW_IMPORT_UI_MIN_CONTROLLER_VERSION = '2026.4.22';

function formatMorningBriefingSchedule(cron: string, timezone: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `Schedule: ${cron} (${timezone})`;
  }

  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = parts;
  const minute = Number.parseInt(minuteRaw, 10);
  const hour24 = Number.parseInt(hourRaw, 10);

  const isDaily = dayOfMonth === '*' && month === '*' && dayOfWeek === '*';
  const isValidTime =
    Number.isInteger(minute) &&
    Number.isInteger(hour24) &&
    minute >= 0 &&
    minute <= 59 &&
    hour24 >= 0 &&
    hour24 <= 23;

  if (!isDaily || !isValidTime) {
    return `Schedule: ${cron} (${timezone})`;
  }

  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const timeLabel = `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
  const timezoneLabel = timezone === 'America/Chicago' ? 'CT' : timezone;

  return `Automatically runs daily at ${timeLabel} ${timezoneLabel}`;
}

function joinFriendlyList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

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

function GoogleGIcon({ className }: { className?: string }) {
  return (
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
}

// ---------------------------------------------------------------------------
// Google Calendar (official Kilo OAuth client, credential_profile=kilo_owned)
// ---------------------------------------------------------------------------

// Read-only capability summary, mirrored from the onboarding calendar step
// (CalendarConnectStep.tsx) so the settings copy stays consistent.
const GOOGLE_CALENDAR_FEATURES: Array<{ included: boolean; label: string }> = [
  { included: true, label: 'Read your calendar events (titles, times, attendees, locations)' },
  { included: true, label: 'Read calendars you own and subscribe to' },
  { included: false, label: 'Create, modify, or delete events (we never request write access)' },
];

/**
 * Settings card for the officially-approved Kilo OAuth client. This is the
 * preferred Google Calendar connection and the successor to the legacy Gog
 * flow (GoogleAccountCard). Connect/disconnect reuse the existing
 * /api/integrations/google/{connect,disconnect} routes; disconnect is a native
 * same-origin form POST so the route's Origin check passes and the 303 redirect
 * lands back on settings with a success/error param.
 */
function GoogleCalendarCard({
  connected,
  oauthStatus,
  accountEmail,
  organizationId,
}: {
  connected: boolean;
  oauthStatus: 'active' | 'action_required' | 'disconnected';
  accountEmail: string | null;
  organizationId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const disconnectFormRef = useRef<HTMLFormElement>(null);

  const settingsPath = organizationId
    ? `/organizations/${organizationId}/claw/settings`
    : '/claw/settings';
  const connectParams = new URLSearchParams({ returnTo: settingsPath });
  if (organizationId) {
    connectParams.set('organizationId', organizationId);
  }
  const connectUrl = `/api/integrations/google/connect?${connectParams.toString()}`;
  const disconnectAction = organizationId
    ? `/api/integrations/google/disconnect?organizationId=${encodeURIComponent(organizationId)}`
    : '/api/integrations/google/disconnect';

  const needsReconnect = oauthStatus === 'action_required';
  const isHealthyConnected = connected && !needsReconnect;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
            >
              <GoogleGIcon className="h-5 w-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Google Calendar</span>
                  <Badge
                    variant={isHealthyConnected ? 'default' : 'secondary'}
                    className="px-1.5 py-0 text-[10px] leading-4"
                  >
                    {connected ? (needsReconnect ? 'Reconnect' : 'Connected') : 'Not connected'}
                  </Badge>
                </div>
                <span className="text-muted-foreground text-xs">
                  Read-only calendar access · via Kilo OAuth
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
              {isHealthyConnected ? (
                <>
                  <p className="text-muted-foreground text-xs">
                    {accountEmail ? `Connected as ${accountEmail}` : 'Connected'} · read-only access
                    to your calendar events.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDisconnecting}
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    <X className="h-4 w-4" />
                    {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </>
              ) : (
                <>
                  {needsReconnect && (
                    <p className="text-xs text-amber-500">
                      Your calendar connection needs to be re-authorized. Reconnect to resume
                      access.
                    </p>
                  )}
                  <ul className="space-y-2">
                    {GOOGLE_CALENDAR_FEATURES.map(feature => (
                      <li key={feature.label} className="flex items-start gap-2">
                        {feature.included ? (
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                        ) : (
                          <X className="text-muted-foreground/60 mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <span
                          className={
                            feature.included
                              ? 'text-muted-foreground text-xs'
                              : 'text-muted-foreground/70 text-xs'
                          }
                        >
                          {feature.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Button asChild size="sm">
                    <Link href={connectUrl}>
                      {needsReconnect ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Native form POST so the disconnect route's same-origin Origin check
          passes; the 303 redirect navigates back to settings. */}
      <form ref={disconnectFormRef} method="POST" action={disconnectAction} className="hidden" />

      <ConfirmActionDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Google Calendar"
        description="This removes Kilo's read-only access to your Google Calendar. You can reconnect anytime."
        confirmLabel="Disconnect"
        confirmIcon={<X className="mr-1 h-4 w-4" />}
        isPending={isDisconnecting}
        pendingLabel="Disconnecting..."
        onConfirm={() => {
          const form = disconnectFormRef.current;
          if (!form) {
            toast.error('Could not disconnect Google Calendar. Please try again.');
            return;
          }
          // The disconnect route always 303-redirects, so once we submit the
          // page navigates away; isDisconnecting intentionally stays true until
          // then. Only set it after confirming the form exists so a missing ref
          // can't leave the button permanently disabled.
          setIsDisconnecting(true);
          form.submit();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Google Account (collapsible card, matches SecretEntrySection card style)
// ---------------------------------------------------------------------------

function GoogleAccountCard({
  connected,
  gmailNotificationsEnabled,
  inboundEmailAddress,
  inboundEmailEnabled,
  mutations,
  onRedeploy,
}: {
  connected: boolean;
  gmailNotificationsEnabled: boolean;
  inboundEmailAddress: string | null;
  inboundEmailEnabled: boolean;
  mutations: ClawMutations;
  onRedeploy?: () => void;
}) {
  // This card is rendered only for users who already have the legacy Gog
  // connection (status.googleConnected). The self-service setup-command flow
  // is intentionally not surfaced; Gog is being retired in favor of the
  // official Google Calendar OAuth card above, so we only offer disconnect.
  const [open, setOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const isDisconnecting = mutations.disconnectGoogle.isPending;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
            >
              <GoogleGIcon className="h-5 w-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Google Account</span>
                  <Badge
                    variant={connected ? 'default' : 'secondary'}
                    className="px-1.5 py-0 text-[10px] leading-4"
                  >
                    {connected ? 'Connected' : 'Not connected'}
                  </Badge>
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
                    Legacy
                  </Badge>
                </div>
                <span className="text-muted-foreground text-xs">
                  Legacy Google connection, being retired
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
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="space-y-2 text-xs">
                  <p className="text-muted-foreground">
                    {
                      "This integration is being retired. We recommend disconnecting your current integration and switching to KiloCode's official Google approved OAuth client."
                    }
                  </p>
                  <p className="text-muted-foreground">
                    {'To reconnect, use the '}
                    <span className="text-foreground font-medium">Google Calendar</span>
                    {
                      " integration listed above. This integration uses KiloCode's official OAuth application and is fully supported going forward."
                    }
                  </p>
                  <p className="text-muted-foreground">
                    {"For email functionality, use your bot's automatically provisioned "}
                    <span className="text-foreground font-medium">Inbound Email</span>
                    {' address:'}
                  </p>
                  {/* Only present the alias as usable when delivery is actually
                      enabled — the backend rejects disabled aliases (410), so
                      showing a disabled one would send users to a dead path. */}
                  {inboundEmailAddress && inboundEmailEnabled ? (
                    <code className="bg-muted text-foreground inline-block max-w-full truncate rounded px-2 py-1 text-xs">
                      {inboundEmailAddress}
                    </code>
                  ) : (
                    <span className="text-muted-foreground">
                      {inboundEmailAddress
                        ? 'Inbound Email is currently disabled for this instance. Enable it in the Inbound Email section on this page before relying on it.'
                        : 'See the Inbound Email section on this page to set it up.'}
                    </span>
                  )}
                </div>
              </div>

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
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <ConfirmActionDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Google Account"
        description="This removes your legacy Google credentials. This connection method is being retired. To keep calendar access, use the Google Calendar (OAuth) card; for email, use your Inbound Email address. Redeploy after disconnecting to apply."
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

/**
 * Inline editor for the user's free-text location, surfaced inside the
 * Morning Briefing card. Drives the Local News source of the brief.
 *
 * When no location is set, surfaces an amber-bordered nudge with an
 * inline input. When a location is set, renders a read-only value with
 * an Edit affordance and a Clear button.
 *
 * Saves via the existing `updateConfig` mutation. Two delivery paths
 * downstream:
 *   - Instance running: the worker DO calls
 *     `gateway.updateMorningBriefingUserLocation`, which writes the
 *     new value into the plugin's `config.json`. The plugin reads
 *     that file at the start of every brief via
 *     `resolveLocationContextWithOverride`, so the next brief uses
 *     the new location with no restart.
 *   - Instance stopped: the DO updates state + Postgres, and the
 *     `KILOCLAW_USER_LOCATION` env var is rewritten on next boot so
 *     the plugin picks it up via the env-var fallback.
 * Either way, the next briefing run picks up the new value — no
 * manual restart needed.
 */
function MorningBriefingLocationEditor({
  mutations,
  userLocation,
  userTimezone,
  isRunning,
}: {
  mutations: ClawMutations;
  userLocation: string | null;
  userTimezone: string | null;
  /**
   * Editor is disabled when the instance is not running. The DO method
   * rejects saves while not running because the plugin reads
   * `config.json.userLocation` first and silently persisting a change
   * here would not affect the next briefing on the current boot.
   */
  isRunning: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(userLocation ?? '');
  const isSaving = mutations.updateUserLocation.isPending;
  const hasLocation = userLocation !== null && userLocation.trim().length > 0;
  const controlsDisabled = !isRunning || isSaving;

  function handleSave() {
    const value = draft.trim();
    if (value.length === 0) {
      toast.error('Location cannot be empty');
      return;
    }
    mutations.updateUserLocation.mutate(
      { userLocation: value },
      {
        onSuccess: () => {
          toast.success('Location saved. Changes take effect on your next morning brief.', {
            duration: 6000,
          });
          setEditing(false);
        },
        onError: err => toast.error(`Failed to save location: ${err.message}`),
      }
    );
  }

  function handleClear() {
    mutations.updateUserLocation.mutate(
      { userLocation: null },
      {
        onSuccess: () => {
          // Note: clearing the override only removes the Settings-side
          // value. The plugin still falls back to the onboarding
          // `KILOCLAW_USER_LOCATION` env var if one was set there, so
          // Local News may keep running off the old onboarding
          // location. To fully disable Local News, deselect it from
          // the Interests list above.
          toast.success(
            'Override cleared. Local News will fall back to your onboarding location until you set a new one. To fully disable, deselect "Local News" from Interests.',
            { duration: 8000 }
          );
          setDraft('');
          setEditing(false);
        },
        onError: err => toast.error(`Failed to clear location: ${err.message}`),
      }
    );
  }

  function handleCancel() {
    setDraft(userLocation ?? '');
    setEditing(false);
  }

  const containerClass = hasLocation
    ? 'rounded-lg border p-4'
    : 'rounded-lg border border-amber-500/50 bg-amber-500/5 p-4';
  const dimmedClass = !isRunning ? ' opacity-60' : '';

  return (
    <div className={containerClass + dimmedClass}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">Location for Local News</h3>
        {hasLocation && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={!isRunning}>
            Edit
          </Button>
        )}
      </div>
      {!isRunning && (
        <p className="text-muted-foreground mb-2 text-xs">
          Start your instance to update Location.
        </p>
      )}

      {hasLocation && !editing && (
        <>
          <p className="text-foreground text-sm">{userLocation}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Used by the Local News source in your morning briefing.
            {userTimezone ? ` Timezone: ${userTimezone}.` : ''}
          </p>
        </>
      )}

      {!hasLocation && !editing && (
        <>
          <p className="text-foreground text-sm">
            No location set. Local News is disabled until you provide one.
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {userTimezone
              ? `We know your timezone is ${userTimezone}, but that's too coarse for local news — a city or address works much better.`
              : 'Add a city or address (e.g. "San Francisco, CA") and we\'ll surface local headlines.'}
          </p>
          <div className="mt-3">
            <Button size="sm" onClick={() => setEditing(true)} disabled={!isRunning}>
              Set location
            </Button>
          </div>
        </>
      )}

      {editing && (
        <div className="flex flex-col gap-2">
          <Input
            placeholder="e.g. San Francisco, CA"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            disabled={controlsDisabled}
            maxLength={200}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={controlsDisabled}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={isSaving}>
              Cancel
            </Button>
            {hasLocation && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClear}
                disabled={controlsDisabled}
                className="text-destructive hover:text-destructive"
              >
                Clear
              </Button>
            )}
            <p className="text-muted-foreground text-xs">
              Changes take effect on your next morning brief.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function MorningBriefingInterestsEditor({
  mutations,
  briefingStatus,
  actionsReady,
  supportsInterests,
  onRequestUpgrade,
}: {
  mutations: ClawMutations;
  briefingStatus: MorningBriefingStatusLite | undefined;
  actionsReady: boolean;
  /** Whether the running controller has the interests plugin route. */
  supportsInterests: boolean;
  /** Opens the focused upgrade confirmation flow. */
  onRequestUpgrade?: () => void;
}) {
  // All hooks must run unconditionally before any early return so a
  // `supportsInterests` transition (e.g. controller version query
  // resolves to old) doesn't change the hook count between renders.
  const storedTopics = briefingStatus?.interestTopics ?? null;
  const [draft, setDraft] = useState<string[] | null>(null);
  const [customInput, setCustomInput] = useState('');

  // Sync draft from server when the stored value first arrives or changes
  // out from under us (e.g. another tab saved). Drop changes the user has
  // in flight if the saved set differs from what we last seeded.
  const lastSeenStored = useRef<string | null>(null);
  useEffect(() => {
    if (storedTopics === null) return;
    // JSON.stringify avoids the separator-collision case where a user-
    // typed topic like "Tech||AI" would produce the same signature as
    // two separate topics joined with "||". Matches the isDirty
    // comparison just below.
    const serialized = JSON.stringify(storedTopics);
    if (lastSeenStored.current === serialized) return;
    lastSeenStored.current = serialized;
    setDraft(storedTopics);
  }, [storedTopics]);

  const effective = draft ?? storedTopics ?? [];
  const isDirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(storedTopics ?? []);
  const atCap = effective.length >= MORNING_BRIEFING_INTERESTS_MAX_TOPICS;

  function togglePreset(topic: string) {
    setDraft(current => {
      const base = current ?? storedTopics ?? [];
      const isSelected = base.some(value => value.toLowerCase() === topic.toLowerCase());
      if (isSelected) {
        return base.filter(value => value.toLowerCase() !== topic.toLowerCase());
      }
      if (base.length >= MORNING_BRIEFING_INTERESTS_MAX_TOPICS) return base;
      return [...base, topic];
    });
  }

  function addCustom() {
    const value = customInput.trim().slice(0, MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH);
    if (!value) return;
    setDraft(current => {
      const base = current ?? storedTopics ?? [];
      if (base.some(existing => existing.toLowerCase() === value.toLowerCase())) return base;
      if (base.length >= MORNING_BRIEFING_INTERESTS_MAX_TOPICS) return base;
      return [...base, value];
    });
    setCustomInput('');
  }

  function removeTopic(topic: string) {
    setDraft(current => {
      const base = current ?? storedTopics ?? [];
      return base.filter(value => value !== topic);
    });
  }

  function reset() {
    setDraft(storedTopics ?? []);
    setCustomInput('');
  }

  function save() {
    const topics = effective;
    // For the org variant, `bind` (useOrgKiloClaw.ts) injects
    // `organizationId` automatically; the personal variant takes just
    // `{ topics }`. Same call site works for both.
    mutations.updateBriefingInterests.mutate(
      { topics },
      {
        onSuccess: () => {
          toast.success('Interests saved');
        },
        onError: err => toast.error(`Failed to save interests: ${err.message}`),
      }
    );
  }

  const saving = mutations.updateBriefingInterests.isPending;
  const disabled = !actionsReady;

  // Early return AFTER all hooks have run. When the controller is too
  // old the worker would return `controller_route_unavailable` on save,
  // so render the same amber upgrade-required block + Upgrade button
  // used by the parent MorningBriefingCard's controller-out-of-date
  // branch. We deliberately don't surface a version number to end users
  // (controller calver is an internal detail; just direct them to
  // upgrade).
  if (!supportsInterests) {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-200">Upgrade required</p>
          <p className="text-muted-foreground text-xs">
            Interest topics require a newer KiloClaw version. Upgrade to choose the topics your
            morning briefing covers.
          </p>
        </div>
        {onRequestUpgrade && (
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
            onClick={onRequestUpgrade}
          >
            Upgrade
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="border-border mt-3 flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          Interests
        </span>
        <p className="text-muted-foreground text-xs">
          Topics that scope tomorrow’s briefing web search.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {INTEREST_TOPIC_PRESETS.map(preset => {
          const active = effective.some(value => value.toLowerCase() === preset.toLowerCase());
          return (
            <button
              key={preset}
              type="button"
              onClick={() => togglePreset(preset)}
              disabled={disabled || saving || (!active && atCap)}
              className={`focus-visible:ring-ring rounded-full border px-3 py-1 text-xs transition focus-visible:ring-2 focus-visible:outline-none ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
              }`}
              aria-pressed={active}
            >
              {preset}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Input
          value={customInput}
          onChange={event => setCustomInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addCustom();
            }
          }}
          maxLength={MORNING_BRIEFING_INTERESTS_MAX_TOPIC_LENGTH}
          placeholder="Add your own (e.g. Biotech)"
          disabled={disabled || saving || atCap}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addCustom}
          disabled={disabled || saving || !customInput.trim() || atCap}
        >
          Add
        </Button>
      </div>
      {effective.some(
        topic =>
          !INTEREST_TOPIC_PRESETS.some(preset => preset.toLowerCase() === topic.toLowerCase())
      ) && (
        <div className="flex flex-wrap gap-2">
          {effective
            .filter(
              topic =>
                !INTEREST_TOPIC_PRESETS.some(preset => preset.toLowerCase() === topic.toLowerCase())
            )
            .map(topic => (
              <span
                key={topic}
                className="border-border bg-muted text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              >
                {topic}
                <button
                  type="button"
                  onClick={() => removeTopic(topic)}
                  aria-label={`Remove ${topic}`}
                  className="hover:text-destructive"
                  disabled={disabled || saving}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {effective.length === 0
            ? 'No topics selected. Briefing falls back to its default search.'
            : `${effective.length} topic${effective.length === 1 ? '' : 's'} selected.`}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={reset}
            disabled={!isDirty || saving}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={save}
            disabled={!isDirty || saving || disabled}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MorningBriefingCard({
  mutations,
  briefingStatus,
  fallbackReadiness,
  isRunning,
  actionsReady,
  onRequestUpgrade,
  supportsInterests,
  userLocation,
  userTimezone,
}: {
  mutations: ClawMutations;
  briefingStatus: MorningBriefingStatusLite | undefined;
  fallbackReadiness: {
    githubConfigured: boolean;
    linearConfigured: boolean;
    webConfigured: boolean;
  };
  isRunning: boolean;
  actionsReady: boolean;
  /** Callback that opens the focused upgrade confirmation flow. */
  onRequestUpgrade?: () => void;
  /**
   * Whether the running controller image includes the
   * `/_kilo/morning-briefing/interests` plugin route. When false the
   * interests editor renders an "Upgrade Required" placeholder instead
   * of the controls so users on stale images don't hit a 404 on save.
   */
  supportsInterests: boolean;
  /**
   * Current user-provided location (e.g. "San Francisco, CA"). Drives
   * the Local News source — when null the brief surfaces a "set a
   * location" nudge. Editable via the Location section below.
   */
  userLocation: string | null;
  /** IANA timezone, shown as context next to the location editor. */
  userTimezone: string | null;
}) {
  const [requestedDay, setRequestedDay] = useState<'today' | 'yesterday' | null>(null);
  // Card starts collapsed — matches the OpenClaw Manage Version section. The
  // collapsed trigger surfaces enabled-state and the schedule at a glance;
  // expand to reach the enable/disable/run controls and the interests editor.
  const [open, setOpen] = useState(false);
  const { data: readData, isFetching: isReading } = useClawReadMorningBriefing(requestedDay, true);

  const sourceReadiness =
    briefingStatus?.sourceReadiness ??
    ({
      github: {
        configured: fallbackReadiness.githubConfigured,
        summary: fallbackReadiness.githubConfigured
          ? 'Configured in Developer Tools'
          : 'Not configured',
      },
      linear: {
        configured: fallbackReadiness.linearConfigured,
        summary: fallbackReadiness.linearConfigured
          ? 'Configured in Developer Tools'
          : 'Not configured',
      },
      web: {
        configured: fallbackReadiness.webConfigured,
        summary: fallbackReadiness.webConfigured
          ? 'Configured in Search settings'
          : 'Not configured',
      },
    } as const);

  const hasSchedule = Boolean(briefingStatus?.cron && briefingStatus?.timezone);
  const {
    desiredEnabled,
    observedEnabled,
    hasResolvedBriefingToggleState,
    isWarmupState,
    isControllerOutOfDate,
  } = deriveMorningBriefingCardState({
    isRunning,
    actionsReady,
    briefingStatus,
  });
  const reconcileState = briefingStatus?.reconcileState ?? 'idle';
  const lastReconcileAction = briefingStatus?.lastReconcileAction ?? null;
  const isTransitioning =
    reconcileState === 'in_progress' ||
    mutations.enableMorningBriefing.isPending ||
    mutations.disableMorningBriefing.isPending;

  const statusLabel = (() => {
    if (isControllerOutOfDate) {
      return 'Upgrade Required';
    }

    if (isWarmupState) {
      return 'Instance Warming Up';
    }

    if (!isRunning) {
      return 'Instance Stopped';
    }

    if (mutations.enableMorningBriefing.isPending) {
      return 'Enabling';
    }
    if (mutations.disableMorningBriefing.isPending) {
      return 'Disabling';
    }

    if (reconcileState === 'in_progress') {
      if (lastReconcileAction === 'enable') {
        return observedEnabled === true ? 'Enabled' : 'Enabling';
      }
      if (lastReconcileAction === 'disable') {
        return observedEnabled === false ? 'Disabled' : 'Disabling';
      }
      if (desiredEnabled && observedEnabled !== true) {
        return 'Enabling';
      }
      if (!desiredEnabled && observedEnabled === true) {
        return 'Disabling';
      }
    }

    return observedEnabled ? 'Enabled' : 'Disabled';
  })();
  const statusVariant =
    isControllerOutOfDate || isWarmupState
      ? 'secondary'
      : statusLabel === 'Instance Stopped'
        ? 'secondary'
        : observedEnabled || (isTransitioning && desiredEnabled)
          ? 'default'
          : 'secondary';

  const readySources = [
    sourceReadiness.github.configured ? 'GitHub' : null,
    sourceReadiness.linear.configured ? 'Linear' : null,
    sourceReadiness.web.configured ? 'Web Search' : null,
  ].filter((value): value is string => value !== null);
  const missingSources = [
    sourceReadiness.github.configured ? null : 'GitHub',
    sourceReadiness.linear.configured ? null : 'Linear',
    sourceReadiness.web.configured ? null : 'Web Search',
  ].filter((value): value is string => value !== null);

  const sourceSummaryText =
    readySources.length === 3
      ? 'All sources are connected: GitHub, Linear, and Web Search.'
      : readySources.length === 0
        ? 'No sources are connected yet. Configure GitHub, Linear, or Web Search to generate richer briefings.'
        : `Connected sources: ${joinFriendlyList(readySources)}. Disconnected sources: ${joinFriendlyList(missingSources)}.`;
  const showScheduleDetails =
    !isWarmupState && !isControllerOutOfDate && hasSchedule && desiredEnabled;
  const controlsEnabled = actionsReady && !isWarmupState && !isControllerOutOfDate;
  const canUseBriefingControls = controlsEnabled && desiredEnabled;
  const lastDelivery = briefingStatus?.lastDelivery ?? [];
  const showLastDelivery =
    !isWarmupState &&
    !isControllerOutOfDate &&
    actionsReady &&
    hasResolvedBriefingToggleState &&
    lastDelivery.length > 0;
  const deliveryChannelLabel = {
    telegram: 'Telegram',
    discord: 'Discord',
    slack: 'Slack',
  } as const;
  const deliveryStatusLabel = {
    sent: 'Sent',
    skipped: 'Skipped',
    failed: 'Failed',
  } as const;
  const deliveryReasonLabel = {
    missing_target: 'Missing target',
    ambiguous_target: 'Ambiguous target',
    send_failed: 'Send failed',
    config_unavailable: 'Config unavailable',
  } as const;

  // One-line summary surfaced in the collapsed trigger. Conveys
  // "what's currently happening" without expanding the card. The amber
  // upgrade banner above the collapsible covers the controller-out-of-
  // date case, so we don't repeat it here.
  const triggerSummary = (() => {
    if (isControllerOutOfDate) return null;
    if (isWarmupState) return 'Instance warming up';
    if (showScheduleDetails && briefingStatus?.cron && briefingStatus?.timezone) {
      const schedule = formatMorningBriefingSchedule(briefingStatus.cron, briefingStatus.timezone);
      const last = briefingStatus.lastGeneratedDate;
      return last ? `${schedule} · last ${last}` : schedule;
    }
    if (!desiredEnabled) return 'Disabled — expand to enable';
    return null;
  })();

  return (
    <>
      {/* Amber upgrade banner stays outside the collapsible so the call-to-
          action is visible without expanding. */}
      {isControllerOutOfDate && (
        <div className="mb-3 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-200">Upgrade required</p>
            <p className="text-muted-foreground text-xs">
              Morning Briefing requires a newer KiloClaw version. Upgrade to enable scheduling and
              delivery.
            </p>
          </div>
          {onRequestUpgrade && (
            <Button
              size="sm"
              variant="outline"
              className="border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
              onClick={onRequestUpgrade}
            >
              Upgrade
            </Button>
          )}
        </div>
      )}
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-lg border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors"
            >
              <Newspaper className="text-muted-foreground h-5 w-5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col items-start">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Morning Briefing</span>
                  <Badge variant={statusVariant} className="px-1.5 py-0 text-[10px] leading-4">
                    {statusLabel}
                  </Badge>
                </div>
                {triggerSummary && (
                  <span className="text-muted-foreground text-xs">{triggerSummary}</span>
                )}
              </div>
              <ChevronDown
                className={`text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 ${
                  open ? 'rotate-180' : ''
                }`}
              />
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <Separator />
            <div className="space-y-3 px-4 py-3">
              {showScheduleDetails && briefingStatus?.cron && briefingStatus?.timezone && (
                <p className="text-muted-foreground text-xs">
                  {formatMorningBriefingSchedule(briefingStatus.cron, briefingStatus.timezone)}
                </p>
              )}
              {showScheduleDetails && (
                <p className="text-muted-foreground text-xs">
                  Last generated: {briefingStatus?.lastGeneratedDate ?? '(none)'}
                </p>
              )}
              {showLastDelivery && (
                <p className="text-muted-foreground text-xs">
                  Last delivery:{' '}
                  {lastDelivery
                    .map(entry => {
                      const channel = deliveryChannelLabel[entry.channel] ?? entry.channel;
                      const status = deliveryStatusLabel[entry.status] ?? entry.status;
                      const reason = entry.reason
                        ? (deliveryReasonLabel[entry.reason] ?? entry.reason)
                        : undefined;
                      return reason
                        ? `${channel} (${status}: ${reason})`
                        : `${channel} (${status})`;
                    })
                    .join(' • ')}
                </p>
              )}

              {isWarmupState && (
                <p className="text-muted-foreground text-xs">
                  Instance is still warming up. Morning Briefing controls will become available once
                  the gateway is fully ready.
                </p>
              )}

              <p className="text-muted-foreground text-xs">{sourceSummaryText}</p>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !controlsEnabled || desiredEnabled || mutations.enableMorningBriefing.isPending
                  }
                  onClick={() => {
                    mutations.enableMorningBriefing.mutate(
                      {},
                      {
                        onSuccess: () => toast.success('Morning Briefing enabled'),
                        onError: err =>
                          toast.error(`Failed to enable Morning Briefing: ${err.message}`),
                      }
                    );
                  }}
                >
                  {mutations.enableMorningBriefing.isPending ? 'Enabling...' : 'Enable'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !controlsEnabled ||
                    !desiredEnabled ||
                    mutations.disableMorningBriefing.isPending
                  }
                  onClick={() => {
                    mutations.disableMorningBriefing.mutate(undefined, {
                      onSuccess: () => toast.success('Morning Briefing disabled'),
                      onError: err =>
                        toast.error(`Failed to disable Morning Briefing: ${err.message}`),
                    });
                  }}
                >
                  {mutations.disableMorningBriefing.isPending ? 'Disabling...' : 'Disable'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canUseBriefingControls || mutations.runMorningBriefing.isPending}
                  onClick={() => {
                    mutations.runMorningBriefing.mutate(undefined, {
                      onSuccess: data => {
                        const date = data.date ? ` for ${data.date}` : '';
                        toast.success(`Morning Briefing generated${date}`);
                      },
                      onError: err => toast.error(`Failed to run Morning Briefing: ${err.message}`),
                    });
                  }}
                >
                  {mutations.runMorningBriefing.isPending ? 'Running...' : 'Run Now'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canUseBriefingControls}
                  onClick={() => setRequestedDay('today')}
                >
                  View Today
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canUseBriefingControls}
                  onClick={() => setRequestedDay('yesterday')}
                >
                  View Yesterday
                </Button>
              </div>

              {!desiredEnabled && controlsEnabled && (
                <p className="text-muted-foreground text-xs">
                  Enable Morning Briefing to get a personalized briefing everyday.
                </p>
              )}

              <MorningBriefingInterestsEditor
                mutations={mutations}
                briefingStatus={briefingStatus}
                actionsReady={actionsReady}
                supportsInterests={supportsInterests}
                onRequestUpgrade={onRequestUpgrade}
              />

              {/* Location card only matters when the user has opted
                  into Local News. For everyone else it's noise. Case-
                  insensitive trim matches what the plugin's
                  `wantsLocalNews` does so custom-cased entries like
                  "local news" still count. */}
              {(briefingStatus?.interestTopics ?? []).some(
                topic => topic.trim().toLowerCase() === 'local news'
              ) && (
                <MorningBriefingLocationEditor
                  mutations={mutations}
                  userLocation={userLocation}
                  userTimezone={userTimezone}
                  isRunning={isRunning}
                />
              )}

              {requestedDay && (
                <div>
                  {isReading ? (
                    <p className="text-muted-foreground text-xs">Loading saved briefing...</p>
                  ) : readData?.markdown ? (
                    <>
                      <pre className="bg-muted max-h-56 overflow-auto rounded p-3 text-xs whitespace-pre-wrap">
                        {readData.markdown}
                      </pre>
                      <p className="text-muted-foreground mt-2 text-xs italic">
                        Raw markdown output. Briefings delivered to chat are reformatted for
                        readability.
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      No saved briefing for {requestedDay === 'today' ? 'today' : 'yesterday'}.
                    </p>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
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

function getDestroyConfirmationContext({
  status,
  organizationName,
}: {
  status: KiloClawDashboardStatus;
  organizationName?: string;
}) {
  const instanceName = status.name?.trim() || null;
  const sandboxId = status.sandboxId;
  const organizationPrefix = organizationName?.trim() || null;
  const instanceKind = organizationPrefix ? 'Organization Instance' : 'Personal Instance';

  // Accept either the instance name or sandbox ID as confirmation input.
  // The prompt shows the name when available (more recognizable); the sandbox
  // ID is always accepted silently as a fallback. In org context each token
  // is prefixed with "orgname/".
  const confirmationTokens = [instanceName, sandboxId].filter(
    (token): token is string => token !== null && token.length > 0
  );
  const uniqueTokens = [...new Set(confirmationTokens)];
  const confirmationOptions = organizationPrefix
    ? uniqueTokens.map(token => `${organizationPrefix}/${token}`)
    : uniqueTokens;

  // Show the name-based token in the prompt when available, fall back to sandbox ID.
  const primaryConfirmation = confirmationOptions[0];

  return {
    displayName: instanceName || 'Unnamed instance',
    sandboxId,
    instanceKind,
    confirmationOptions,
    primaryConfirmation,
  };
}

function DestroyInstanceDialog({
  open,
  onOpenChange,
  status,
  organizationName,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: KiloClawDashboardStatus;
  organizationName?: string;
  isPending: boolean;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [copied, setCopied] = useState(false);
  const { displayName, sandboxId, instanceKind, confirmationOptions, primaryConfirmation } =
    useMemo(
      () => getDestroyConfirmationContext({ status, organizationName }),
      [status, organizationName]
    );
  const confirmationMatches =
    confirmationOptions.length > 0 && confirmationOptions.includes(confirmation.trim());

  function handleCopyConfirmation() {
    if (!primaryConfirmation) return;
    void navigator.clipboard.writeText(primaryConfirmation);
    setCopied(true);
  }

  useEffect(() => {
    if (!open) {
      setConfirmation('');
      setCopied(false);
      return;
    }
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [open, copied]);

  return (
    <Dialog open={open} onOpenChange={isPending ? () => {} : onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onInteractOutside={e => {
          if (isPending) e.preventDefault();
        }}
        onEscapeKeyDown={e => {
          if (isPending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Destroy {instanceKind}</DialogTitle>
          <DialogDescription>
            Confirm that you are destroying the correct {instanceKind.toLowerCase()} before
            continuing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-sm font-medium text-red-300">This action is irreversible.</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Destroying this {instanceKind.toLowerCase()} permanently deletes its associated data.
              Deleted instance data is unrecoverable.
            </p>
          </div>

          <div className="rounded-md border p-3 text-sm">
            <div className="flex flex-col gap-1">
              <span>
                {instanceKind}:{' '}
                <strong className="text-foreground font-medium">{displayName}</strong>
              </span>
              {sandboxId && (
                <span className="text-muted-foreground break-all">
                  Sandbox ID: <code>{sandboxId}</code>
                </span>
              )}
              {organizationName && (
                <span className="text-muted-foreground break-all">
                  Organization: <code>{organizationName}</code>
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
              <Label htmlFor="destroy-instance-confirmation">Type</Label>
              <span className="bg-muted inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border/50 py-0.5 pr-1 pl-2 select-text">
                <code className="break-all">{primaryConfirmation}</code>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center rounded p-0.5 transition-colors"
                  onClick={handleCopyConfirmation}
                  aria-label="Copy confirmation string"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </span>
              <Label htmlFor="destroy-instance-confirmation">to confirm</Label>
            </div>
            <Input
              id="destroy-instance-confirmation"
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
              disabled={isPending}
              autoComplete="off"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={!confirmationMatches || isPending}
          >
            {isPending ? (
              <>
                Destroying
                <AnimatedDots />
              </>
            ) : (
              'Destroy Instance'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InboundEmailCard({
  address,
  enabled,
  isCycling,
  onCycle,
}: {
  address: string | null;
  enabled: boolean;
  isCycling: boolean;
  onCycle: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmCycle, setConfirmCycle] = useState(false);

  function handleCopy() {
    if (!address) return;
    void navigator.clipboard
      .writeText(address)
      .then(() => toast.success('Inbound email address copied'))
      .catch(() => toast.error('Failed to copy inbound email address'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Hash className="text-muted-foreground h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Inbound Email</p>
            <p className="text-muted-foreground text-xs">
              {enabled
                ? 'Send email to this address to message your agent.'
                : 'Inbound email is disabled for this instance.'}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {address && enabled ? (
            <code className="bg-muted text-foreground min-w-0 truncate rounded px-2 py-1 text-xs">
              {address}
            </code>
          ) : (
            <span className="text-muted-foreground text-xs">Unavailable</span>
          )}
          <Button variant="outline" size="sm" onClick={handleCopy} disabled={!address || !enabled}>
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            Copy
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmCycle(true)}
            disabled={!enabled || isCycling}
          >
            <RotateCcw className="h-4 w-4" />
            Cycle
          </Button>
        </div>
      </div>
      <ConfirmActionDialog
        open={confirmCycle}
        onOpenChange={setConfirmCycle}
        title="Cycle inbound email address?"
        description="This cannot be undone. The current address will stop working immediately and cannot be reassigned later."
        confirmLabel="Cycle Address"
        confirmIcon={<RotateCcw className="h-4 w-4" />}
        isPending={isCycling}
        pendingLabel="Cycling"
        onConfirm={() => {
          onCycle();
          setConfirmCycle(false);
        }}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MemorySection
// ---------------------------------------------------------------------------

function MemorySection({
  config,
  mutations,
  supportsMemoryConfig,
  onRequestUpgrade,
}: {
  config:
    | {
        vectorMemoryEnabled: boolean;
        vectorMemoryModel: string | null;
        dreamingEnabled: boolean;
      }
    | undefined;
  mutations: ClawMutations;
  supportsMemoryConfig: boolean;
  onRequestUpgrade?: () => void;
}) {
  const configVectorEnabled = config?.vectorMemoryEnabled ?? false;
  const configVectorModel = config?.vectorMemoryModel ?? DEFAULT_EMBEDDING_MODEL;
  const configDreamingEnabled = config?.dreamingEnabled ?? false;

  const [vectorEnabled, setVectorEnabled] = useState(configVectorEnabled);
  const [vectorModel, setVectorModel] = useState(configVectorModel);
  const [dreamingEnabled, setDreamingEnabled] = useState(configDreamingEnabled);
  const [lastSaved, setLastSaved] = useState<{
    vectorEnabled: boolean;
    vectorModel: string;
    dreamingEnabled: boolean;
  } | null>(null);

  // Sync local state when config loads/changes from server
  useEffect(() => {
    if (config) {
      if (lastSaved === null) {
        setVectorEnabled(config.vectorMemoryEnabled);
        setVectorModel(config.vectorMemoryModel ?? DEFAULT_EMBEDDING_MODEL);
        setDreamingEnabled(config.dreamingEnabled);
      }
    }
  }, [config, lastSaved]);

  const savedVectorEnabled = lastSaved?.vectorEnabled ?? configVectorEnabled;
  const savedVectorModel = lastSaved?.vectorModel ?? configVectorModel;
  const savedDreamingEnabled = lastSaved?.dreamingEnabled ?? configDreamingEnabled;
  const dirty =
    vectorEnabled !== savedVectorEnabled ||
    (vectorEnabled && vectorModel !== savedVectorModel) ||
    dreamingEnabled !== savedDreamingEnabled;
  const saving = mutations.patchConfig.isPending;

  function handleVectorToggle(checked: boolean) {
    setVectorEnabled(checked);
    if (checked && !vectorModel) {
      setVectorModel(DEFAULT_EMBEDDING_MODEL);
    }
  }

  function handleSave() {
    mutations.patchConfig.mutate(
      {
        vectorMemoryEnabled: vectorEnabled,
        vectorMemoryModel: vectorEnabled ? vectorModel : null,
        dreamingEnabled,
      },
      {
        onSuccess: () => {
          setLastSaved({ vectorEnabled, vectorModel, dreamingEnabled });
          toast.success('Memory settings saved. Changes applied to running instance.');
        },
        onError: err => toast.error(`Failed to save: ${err.message}`),
      }
    );
  }

  return (
    <div>
      <h2 className="text-foreground mb-3 text-base font-semibold">Memory</h2>
      <div className="rounded-lg border p-4">
        {!supportsMemoryConfig && (
          <div className="mb-4 flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-200">Upgrade required</p>
              <p className="text-muted-foreground text-xs">
                Memory configuration requires OpenClaw {MEMORY_MIN_OPENCLAW_VERSION} or later.
                Upgrade to the latest version to enable these settings.
              </p>
            </div>
            {onRequestUpgrade && (
              <Button
                size="sm"
                variant="outline"
                className="border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
                onClick={onRequestUpgrade}
              >
                Upgrade
              </Button>
            )}
          </div>
        )}

        {/* Vector Memory toggle */}
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">Vector Search</p>
            <p className="text-muted-foreground text-xs">
              Use semantic search across memory files via embedding vectors.
            </p>
          </div>
          <Switch
            checked={vectorEnabled}
            onCheckedChange={handleVectorToggle}
            disabled={!supportsMemoryConfig}
          />
        </div>

        {vectorEnabled && (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Embedding Model</p>
              <p className="text-muted-foreground text-xs">
                Model used for generating vector embeddings.
              </p>
            </div>
            <Select
              value={vectorModel}
              onValueChange={setVectorModel}
              disabled={!supportsMemoryConfig}
            >
              <SelectTrigger className="w-full sm:w-[300px]">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {EMBEDDING_MODELS.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Separator className="my-4" />

        {/* Dreaming toggle */}
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">Dreaming</p>
            <p className="text-muted-foreground text-xs">
              Background memory consolidation — moves strong short-term signals into durable
              long-term memory automatically.
            </p>
          </div>
          <Switch
            checked={dreamingEnabled}
            onCheckedChange={setDreamingEnabled}
            disabled={!supportsMemoryConfig}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            disabled={!supportsMemoryConfig || !dirty || saving}
            variant={dirty ? 'default' : 'outline'}
            onClick={handleSave}
          >
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
  onRequestUpgrade,
  organizationName,
}: {
  status: KiloClawDashboardStatus;
  mutations: ClawMutations;
  onSecretsChanged?: (entryId: string) => void;
  dirtySecrets: Set<string>;
  onRedeploy?: () => void;
  /** Callback that opens the focused upgrade confirmation flow. */
  onRequestUpgrade?: () => void;
  /** Present in organization context; required in the destroy confirmation phrase. */
  organizationName?: string;
}) {
  const posthog = usePostHog();
  const { data: config } = useClawConfig();
  const { organizationId } = useClawContext();
  const { data: modelsData, isLoading: isLoadingModels } = useModelSelectorList(organizationId);
  const isRunning = status.status === 'running';
  const {
    updateAvailable,
    catalogNewerThanImage,
    needsImageUpgrade,
    isModified,
    hasVersionInfo,
    variantsMatch,
    trackedVersion,
    runningVersion,
    latestVersion,
    controllerVersion,
    isLoadingControllerVersion,
    isControllerVersionError,
  } = useClawUpdateAvailable(status);
  const { data: myPin } = useClawMyPin();
  const morningBriefingStatusQuery = useClawMorningBriefingStatus(isRunning);
  // Narrow off the instance-not-running sentinel that the worker returns
  // when DO state isn't `running`. The MB card only renders meaningfully
  // when the OK-shape payload is available.
  const morningBriefingStatus = morningBriefingStatusOk(morningBriefingStatusQuery.data);
  const gatewayReadyQuery = useClawGatewayReady(isRunning);
  const gatewayReady = gatewayReadyQuery.data;
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [bootStartedAtMs, setBootStartedAtMs] = useState<number | null>(null);
  const previousStatusRef = useRef(status.status);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    if (status.status === 'running' && previousStatus !== 'running') {
      setBootStartedAtMs(Date.now());
    }
    if (status.status !== 'running' && previousStatus === 'running') {
      setBootStartedAtMs(null);
    }
    previousStatusRef.current = status.status;
  }, [status.status]);

  const hasFreshGatewayReady =
    isRunning &&
    (bootStartedAtMs === null || gatewayReadyQuery.dataUpdatedAt >= bootStartedAtMs) &&
    gatewayReadyQuery.dataUpdatedAt > 0;
  const hasFreshMorningBriefingStatus =
    isRunning &&
    (bootStartedAtMs === null || morningBriefingStatusQuery.dataUpdatedAt >= bootStartedAtMs) &&
    morningBriefingStatusQuery.dataUpdatedAt > 0;
  const morningBriefingActionsReady =
    isRunning &&
    hasFreshGatewayReady &&
    hasFreshMorningBriefingStatus &&
    gatewayReady?.ready === true &&
    gatewayReady?.settled === true;
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
        models: (modelsData?.data || []).map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
        })),
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
  const isRecovering = status.status === 'recovering';
  const isDestroying = status.status === 'destroying';
  const supportsConfigRestore = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    '2026.2.26'
  );
  const supportsExaSearchUi = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    EXA_SEARCH_UI_MIN_CONTROLLER_VERSION
  );
  const supportsMemoryConfig = calverAtLeast(
    runningVersion ?? trackedVersion,
    MEMORY_MIN_OPENCLAW_VERSION
  );
  const supportsOpenclawImportUi = calverAtLeast(
    cleanVersion(controllerVersion?.version),
    OPENCLAW_IMPORT_UI_MIN_CONTROLLER_VERSION
  );
  const supportsOpenclawSaveValidation =
    controllerVersion?.capabilities?.includes('files.write-openclaw-config') === true;
  // Fail OPEN: hide the interests editor only when the controller
  // version is positively parsed as too old, OR the worker reports an
  // explicit `version: null` (its positive old-controller signal for a
  // missing `/_kilo/version` route). A still-loading / errored /
  // unparseable version keeps the editor visible — the worker's
  // `controller_route_unavailable` 404 on save is the backstop for those,
  // and a false "Upgrade required" on a current instance is a worse UX.
  // Hook count stays stable (the editor early-returns on false) since
  // genuinely-unknown states no longer flip the gate.
  const supportsBriefingInterests = controllerCalverSupports(
    controllerVersion?.version,
    MORNING_BRIEFING_INTERESTS_MIN_CONTROLLER_VERSION
  );

  const configuredSecrets = config?.configuredSecrets ?? {};
  const kiloExaSearchMode = config?.kiloExaSearchMode ?? null;
  const braveSearchConfigured = configuredSecrets['brave-search'] ?? false;
  // Reflects which provider is actually active. Mirrors controller arbitration
  // in services/kiloclaw/controller/src/config-writer.ts.
  const exaSearchConfigured =
    supportsExaSearchUi &&
    (kiloExaSearchMode === 'kilo-proxy' || (kiloExaSearchMode === null && !braveSearchConfigured));
  // Editor reflects stored intent, not the resolved active provider, so users
  // can persist an explicit choice when their mode is unset.
  const exaSearchDisplayMode =
    supportsExaSearchUi && kiloExaSearchMode === null ? 'kilo-proxy' : kiloExaSearchMode;
  const braveSearchEnabled = braveSearchConfigured && !exaSearchConfigured;
  const toolEntries = getEntriesByCategory('tool');
  const byokHref = organizationId ? `/organizations/${organizationId}/byok` : '/byok';

  function handleCycleInboundEmailAddress() {
    mutations.cycleInboundEmailAddress.mutate(undefined, {
      onSuccess: data => toast.success(`New inbound email address: ${data.inboundEmailAddress}`),
      onError: err => toast.error(`Failed to cycle inbound email address: ${err.message}`),
    });
  }

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

  const isPinned = !!myPin;

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

      {status.status !== null && (
        <InboundEmailCard
          address={status.inboundEmailAddress}
          enabled={status.inboundEmailEnabled}
          isCycling={mutations.cycleInboundEmailAddress.isPending}
          onCycle={handleCycleInboundEmailAddress}
        />
      )}

      {/* ── Pairing Requests ── */}
      {isRunning && <PairingSection mutations={mutations} />}

      {/* ── OpenClaw Instance card ── */}
      <div className="rounded-lg border px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                            ? 'A new version of KiloClaw is available. This update includes a new OpenClaw version. Click to upgrade.'
                            : 'A new version of KiloClaw is available — click to upgrade.'}
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
                  <span className="hidden sm:inline text-muted-foreground/40">|</span>
                  <span className="basis-full sm:basis-auto">
                    Variant:{' '}
                    <strong className="text-foreground">{status.imageVariant || 'default'}</strong>
                  </span>
                </div>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setManageVersionOpen(v => !v)}>
            Manage Version
          </Button>
        </div>

        {/* Expandable Manage Version section: pinning + Early Access opt in. */}
        {manageVersionOpen && (
          <div className="mt-4 space-y-6 border-t pt-4">
            <VersionPinCard
              trackedImageTag={status.trackedImageTag}
              latestImageTag={variantsMatch ? (latestVersion?.imageTag ?? null) : null}
              mutations={mutations}
            />
            <EarlyAccessCard />
          </div>
        )}
      </div>

      {supportsOpenclawImportUi && (
        <OpenclawImportCard
          mutations={mutations}
          isRunning={isRunning}
          instanceStatus={status.status}
        />
      )}

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
              <p className="text-muted-foreground mt-2 text-xs">
                Configure your own model provider keys in{' '}
                <Link href={byokHref} target="_blank" className="underline">
                  Kilo BYOK settings
                </Link>
                .
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

      {/* ── Memory ── */}
      <MemorySection
        config={config}
        mutations={mutations}
        supportsMemoryConfig={supportsMemoryConfig}
        onRequestUpgrade={onRequestUpgrade}
      />

      {/* ── Default Permissions ── */}
      <PermissionPresetSection
        isRunning={isRunning}
        status={status}
        mutations={mutations}
        onRedeploy={onRedeploy}
      />

      {/* ── Webhook Integration ── */}
      <WebhookIntegrationSection />

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
                  configured={braveSearchEnabled}
                  mutations={mutations}
                  onSecretsChanged={onSecretsChanged}
                  isDirty={dirtySecrets.has(entry.id)}
                  actionRowInlineExtra={
                    supportsExaSearchUi && braveSearchConfigured && exaSearchConfigured ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-8 px-1 text-xs"
                        disabled={mutations.patchWebSearchConfig.isPending}
                        onClick={() => {
                          mutations.patchWebSearchConfig.mutate(
                            { exaMode: 'disabled' },
                            {
                              onSuccess: () => {
                                toast.success('Brave Search re-enabled. Redeploy to apply.', {
                                  duration: 8000,
                                });
                                onSecretsChanged?.('brave-search');
                              },
                              onError: err => {
                                toast.error(`Failed to re-enable Brave Search: ${err.message}`);
                              },
                            }
                          );
                        }}
                      >
                        Re-enable Brave Search
                      </Button>
                    ) : undefined
                  }
                  saveConfirmation={
                    supportsExaSearchUi && exaSearchConfigured
                      ? {
                          title: 'Enable Brave Search?',
                          description:
                            'Exa Search is currently configured. Enabling Brave will disable Exa on the next redeploy.',
                          confirmLabel: 'Enable Brave and disable Exa',
                        }
                      : undefined
                  }
                />
              ))}
            {supportsExaSearchUi && (
              <ExaSearchEntrySection
                mode={exaSearchDisplayMode}
                configured={exaSearchConfigured}
                braveConfigured={braveSearchConfigured}
                mutations={mutations}
                onSecretsChanged={onSecretsChanged}
                isDirty={dirtySecrets.has('kilo-exa-search')}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Developer Tools ── */}
      {toolEntries.some(e => e.id === 'github' || e.id === 'linear' || e.id === 'composio') && (
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
            {toolEntries
              .filter(e => e.id === 'linear')
              .map(entry => (
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
            {toolEntries
              .filter(e => e.id === 'composio')
              .map(entry => (
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
                  onRedeploy={onRequestUpgrade ?? onRedeploy}
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
          <GoogleCalendarCard
            connected={status.googleOAuthConnected}
            oauthStatus={status.googleOAuthStatus}
            accountEmail={status.googleOAuthAccountEmail}
            organizationId={organizationId ?? null}
          />
          {/* Legacy Gog connection: only surfaced to users who already have it,
              so new users are never offered the retired setup flow. */}
          {status.googleConnected && (
            <GoogleAccountCard
              connected={status.googleConnected}
              gmailNotificationsEnabled={status.gmailNotificationsEnabled}
              inboundEmailAddress={status.inboundEmailAddress}
              inboundEmailEnabled={status.inboundEmailEnabled}
              mutations={mutations}
              onRedeploy={onRedeploy}
            />
          )}
          <MorningBriefingCard
            mutations={mutations}
            briefingStatus={morningBriefingStatus}
            isRunning={isRunning}
            actionsReady={morningBriefingActionsReady}
            onRequestUpgrade={onRequestUpgrade}
            supportsInterests={supportsBriefingInterests}
            userLocation={status.userLocation ?? null}
            userTimezone={status.userTimezone ?? null}
            fallbackReadiness={{
              githubConfigured: configuredSecrets.github ?? false,
              linearConfigured: configuredSecrets.linear ?? false,
              webConfigured: braveSearchConfigured || exaSearchConfigured,
            }}
          />
        </div>
      </div>

      {/* ── Additional Secrets ── */}
      <CustomSecretsSection
        customSecretKeys={config?.customSecretKeys ?? []}
        customSecretMeta={config?.customSecretMeta ?? {}}
        mutations={mutations}
        onRedeploy={onRedeploy}
      />

      {/* ── Danger Zone ── */}
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10">
            <AlertTriangle className="h-4 w-4 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Stop or destroy this instance. Destroying is irreversible and permanently deletes
              unrecoverable instance data.
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
                        isRestarting ||
                        isRecovering
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
                disabled={!isRunning || isDestroying || isRestarting || isRecovering}
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
                  isRestarting ||
                  isRecovering
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
            </div>

            {editConfigOpen && (
              <div className="mt-4">
                <WorkspaceFileEditor
                  enabled={isRunning}
                  mutations={mutations}
                  onOpenChange={setEditConfigOpen}
                  enableOpenclawValidation={supportsOpenclawSaveValidation}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <DestroyInstanceDialog
        open={confirmDestroy}
        onOpenChange={open => {
          if (!open) {
            posthog?.capture('claw_destroy_instance_cancelled');
          }
          setConfirmDestroy(open);
        }}
        status={status}
        organizationName={organizationName}
        isPending={isDestroying || mutations.destroy.isPending}
        onConfirm={() => {
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
      />

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
