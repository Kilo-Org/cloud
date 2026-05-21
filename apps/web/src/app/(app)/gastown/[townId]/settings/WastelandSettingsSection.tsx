'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC, useGastownTRPCClient } from '@/lib/gastown/trpc';
import { useWastelandTRPC, useWastelandTRPCClient } from '@/lib/wasteland/trpc';
import { useTRPC } from '@/lib/trpc/utils';
import { useUser } from '@/hooks/useUser';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Globe,
  Loader2,
  CheckCircle2,
  Unlink,
  ChevronLeft,
  ChevronDown,
  ArrowRight,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import {
  KILO_COMMONS_UPSTREAM,
  UpstreamIntentPicker,
  isUpstreamIntentValid,
  resolveUpstreamFromIntent,
  useUpstreamVerification,
  type UpstreamIntent,
} from '@/components/wasteland/UpstreamIntent';
import { parseDolthubUpstream } from '@/lib/wasteland/upstream';

/**
 * Build the canonical wasteland dashboard URL for a given connection.
 *
 * Prefer the `/wasteland/{owner}/{repo}` route when the connection has a
 * parseable upstream — that's the M2.2 path the rest of the product
 * navigates to. Fall back to `/wasteland/by-id/{wastelandId}` only when
 * the upstream is missing or malformed; that page resolves the upstream
 * server-side and redirects to the owner/repo URL when it can.
 */
function wastelandHref(args: { wastelandId: string; upstream: string | null }): string {
  const parsed = parseDolthubUpstream(args.upstream);
  if (parsed) return `/wasteland/${parsed.owner}/${parsed.repo}`;
  return `/wasteland/by-id/${args.wastelandId}`;
}

/**
 * Derive the default wasteland name when the user hasn't typed one.
 * Mirrors the upstream's `{owner}/{repo}` so the connection list stays
 * recognizable. For the `reuse` intent we have no upstream string yet;
 * the parent already knows the existing wasteland's name and won't call
 * this — but we return `''` defensively.
 */
function defaultWastelandName(intent: UpstreamIntent): string {
  if (intent.kind === 'reuse') return '';
  const upstream = resolveUpstreamFromIntent(intent);
  return upstream;
}

type WastelandConnection = {
  connection_id: string;
  wasteland_id: string;
  upstream: string;
  rig_handle: string;
  dolthub_org: string;
  connected_at: string;
  status: 'active' | 'disconnecting';
};

export function WastelandSettingsSection({
  townId,
  readOnly,
}: {
  townId: string;
  readOnly: boolean;
}) {
  const gastownTrpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const connectionQuery = useQuery(
    gastownTrpc.gastown.getTownWastelandConnection.queryOptions({ townId })
  );

  const connection = connectionQuery.data;
  const isLoading = connectionQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-3">
        <Loader2 className="size-3.5 animate-spin text-white/30" />
        <span className="text-xs text-white/40">Checking connection...</span>
      </div>
    );
  }

  if (connection) {
    return (
      <ConnectedState
        townId={townId}
        connection={connection}
        readOnly={readOnly}
        queryClient={queryClient}
      />
    );
  }

  return <DisconnectedState townId={townId} readOnly={readOnly} queryClient={queryClient} />;
}

// ── Connected State ──────────────────────────────────────────────────────

function ConnectedState({
  townId,
  connection,
  readOnly,
  queryClient,
}: {
  townId: string;
  connection: WastelandConnection;
  readOnly: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const gastownTrpc = useGastownTRPC();

  const disconnect = useMutation(
    gastownTrpc.gastown.disconnectTownFromWasteland.mutationOptions({
      onSuccess: () => {
        toast.success('Disconnected from wasteland');
        void queryClient.invalidateQueries({
          queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
        });
      },
      onError: err => toast.error(`Failed to disconnect: ${err.message}`),
    })
  );

  // Admin-mode toggle lives on the wasteland settings page (which owns the
  // credential + upstream config), not here. This section only shows
  // whether the town is wired to a wasteland.
  return (
    <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 pr-4">
      <Link
        href={wastelandHref({
          wastelandId: connection.wasteland_id,
          upstream: connection.upstream,
        })}
        className="group flex flex-1 items-center gap-3 rounded-l-lg px-4 py-3 transition-colors hover:bg-emerald-500/10"
      >
        <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white/70">
            Connected to <span className="font-mono text-emerald-400">{connection.upstream}</span>
          </p>
          <p className="text-[11px] text-white/30">
            Rig: <span className="font-mono text-white/50">{connection.rig_handle}</span>
            {' · '}
            Org: <span className="font-mono text-white/50">{connection.dolthub_org}</span>
          </p>
        </div>
        <ArrowRight className="size-3.5 shrink-0 text-emerald-400/40 transition-colors group-hover:text-emerald-400" />
      </Link>
      <Button
        variant="secondary"
        size="sm"
        className="ml-4 shrink-0 gap-1.5"
        disabled={readOnly || disconnect.isPending}
        onClick={() => disconnect.mutate({ townId, wastelandId: connection.wasteland_id })}
      >
        {disconnect.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Unlink className="size-3" />
        )}
        {disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
      </Button>
    </div>
  );
}

// ── Disconnected State ───────────────────────────────────────────────────

function DisconnectedState({
  townId,
  readOnly,
  queryClient,
}: {
  townId: string;
  readOnly: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div>
          <p className="text-sm text-white/70">Not connected</p>
          <p className="text-[11px] text-white/30">
            Link this town to a Wasteland to enable community bounties and shared contributions.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="ml-4 shrink-0 gap-1.5"
          disabled={readOnly}
          onClick={() => setOpen(true)}
        >
          <Globe className="size-3" />
          Connect
        </Button>
      </div>
      <ConnectWastelandDialog
        townId={townId}
        open={open}
        onOpenChange={setOpen}
        queryClient={queryClient}
      />
    </>
  );
}

// ── Connect Dialog ───────────────────────────────────────────────────────

/**
 * The dialog used to be a four-step wizard (`intent` → `select`/`new-details`
 * → `credentials` → `identity`) where the first step asked the user to pick
 * between joining and creating. The "create" path covers nearly every case
 * (joining the commons, connecting to an existing repo, bootstrapping a new
 * one) so the intent step has been collapsed away — the dialog now opens
 * directly on `new-details` with the picker showing every option side by
 * side. The `reuse` intent additionally short-circuits past
 * `credentials` / `identity` since the existing wasteland's stored
 * credential is already enough to wire up the town.
 */
type Step = 'new-details' | 'credentials' | 'identity' | 'connecting' | 'success';

function ConnectWastelandDialog({
  townId,
  open,
  onOpenChange,
  queryClient,
}: {
  townId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const gastownTrpc = useGastownTRPC();
  const wastelandTrpc = useWastelandTRPC();
  const mainTrpc = useTRPC();
  const gastownClient = useGastownTRPCClient();
  const wastelandClient = useWastelandTRPCClient();
  const { data: currentUser } = useUser();

  const [step, setStep] = useState<Step>('new-details');

  // Existing wastelands. Used both to power the picker's "Reuse"
  // card (filtered to ones the user actually has a credential on) and
  // to look up the upstream string when the reuse path is taken.
  const wastelandsQuery = useQuery(wastelandTrpc.wasteland.listWastelands.queryOptions({}));
  const wastelands = wastelandsQuery.data ?? [];

  // Default to "Join The Commons" so the common case is a single
  // click: open the dialog, hit Connect, done. The picker also shows
  // the reuse and connect/create cards inline so the user can deviate
  // without going back a step.
  const [newWastelandName, setNewWastelandName] = useState('');
  const [intent, setIntent] = useState<UpstreamIntent>({
    kind: 'commons',
    isUpstreamAdmin: false,
  });

  // Step: Credentials
  // OAuth path — hydrated from the dolthub integration when it's installed.
  // Manual path — same fields the dialog used before the OAuth integration
  // shipped, kept available behind an "Advanced" toggle for users who can't
  // or don't want to use OAuth.
  const [manualOpen, setManualOpen] = useState(false);
  const [dolthubToken, setDolthubToken] = useState('');
  const [dolthubOrg, setDolthubOrg] = useState('');

  // Step: Identity
  const [rigHandle, setRigHandle] = useState('');

  const [connectedUpstream, setConnectedUpstream] = useState(KILO_COMMONS_UPSTREAM);
  /** wastelandId that just got connected — used to offer a "Visit wasteland"
   *  link in the success step. */
  const [connectedWastelandId, setConnectedWastelandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OAuth integration lookup. Only fetched while the dialog is open so we
  // don't ship a bearer token to the browser on every Gastown render. The
  // bearer-token query also gates on the credentials step so the token isn't
  // pulled into browser memory while the user is still on intent / select /
  // new-details — the wizard only needs it once we're at the credentials
  // step (or about to be, via the prefill effect below).
  const installationQuery = useQuery({
    ...mainTrpc.dolthub.getInstallation.queryOptions(undefined),
    enabled: open,
    refetchInterval: query => {
      const installed = query.state.data?.installed === true;
      return open && step === 'credentials' && !installed ? 3_000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const dolthubCredentialsQuery = useQuery({
    ...mainTrpc.dolthub.getInstallationCredentials.queryOptions(undefined),
    enabled: open && step === 'credentials' && installationQuery.data?.installed === true,
  });
  // Auto-resolve the DoltHub username while the user is on the
  // create-mode `new-details` step so the picker can prefill Card 3's
  // input as `<username>/...`. We use the dedicated `resolveUsername`
  // procedure (which calls `/api/v1alpha1/user` and caches) rather than
  // the credentials query above, because that one only returns the
  // *cached* username — first-time users wouldn't get a prefill.
  const resolveUsernameQuery = useQuery({
    ...mainTrpc.dolthub.resolveUsername.queryOptions(undefined),
    enabled: open && step === 'new-details' && installationQuery.data?.installed === true,
    staleTime: Infinity,
  });
  const isDolthubInstalled = installationQuery.data?.installed === true;
  const oauthDolthubToken = dolthubCredentialsQuery.data?.token ?? null;

  // When the user lands on the credentials step with an OAuth token in hand,
  // pre-fill the username from the integration cache (or from their Google
  // profile as a soft fallback). They can still override before connecting.
  useEffect(() => {
    if (step !== 'credentials') return;
    if (dolthubOrg) return;
    const cached = dolthubCredentialsQuery.data?.dolthubUsername;
    if (cached) setDolthubOrg(cached);
  }, [step, dolthubOrg, dolthubCredentialsQuery.data?.dolthubUsername]);

  // When OAuth is available, we don't need to ask for a separate API token —
  // hide the manual "Advanced" disclosure by default.
  const rememberUsername = useMutation(mainTrpc.dolthub.rememberUsername.mutationOptions());

  const handleProceedToIdentity = () => {
    const displayName = currentUser?.google_user_name;
    if (!rigHandle && displayName) {
      setRigHandle(`kilo-${displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    }
    setStep('identity');
  };

  // Reset state when dialog closes
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep('new-details');
      setConnectedUpstream(KILO_COMMONS_UPSTREAM);
      setConnectedWastelandId(null);
      setIntent({ kind: 'commons', isUpstreamAdmin: false });
      setNewWastelandName('');
      setManualOpen(false);
      setDolthubToken('');
      setDolthubOrg('');
      setRigHandle('');
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  /**
   * Reuse path: the user picked an existing wasteland in the picker.
   * No DoltHub credential entry — we read the stored credential off
   * the wasteland record and run the same connect mutations the
   * `select`-step flow used to run.
   */
  const handleConnectReuse = async (wastelandId: string) => {
    setStep('connecting');
    setError(null);

    try {
      const existing = await wastelandClient.wasteland.getCredentialStatus.query({
        wastelandId,
      });
      if (!existing) {
        throw new Error(
          'This wasteland has no DoltHub credential stored. Open it in settings and connect DoltHub before reusing it here.'
        );
      }

      const selectedWasteland = wastelands.find(w => w.wasteland_id === wastelandId);
      const upstream = selectedWasteland?.dolthub_upstream ?? KILO_COMMONS_UPSTREAM;
      setConnectedUpstream(upstream);
      setConnectedWastelandId(wastelandId);

      await wastelandClient.wasteland.connectKiloTown.mutate({
        wastelandId,
        townId,
      });

      await gastownClient.gastown.connectTownToWasteland.mutate({
        townId,
        wastelandId,
        upstream,
        rigHandle: existing.rig_handle ?? '',
        dolthubOrg: existing.dolthub_org,
      });

      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setRigHandle(existing.rig_handle ?? '');
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStep('new-details');
    }
  };

  /**
   * The DoltHub token to use for storeCredential. When the user opted in
   * to OAuth (manualOpen === false) and the integration is installed we
   * forward the OAuth-issued access token; otherwise — only when the user
   * has explicitly opened the manual disclosure — we use whatever they
   * pasted into the manual-entry field. Mirrors the validity check
   * (`oauthCredentialsValid` / `manualCredentialsValid`) so a stale value
   * left over in collapsed manual fields can't leak into the call.
   */
  const resolveDolthubToken = (): string | null => {
    if (!manualOpen && oauthDolthubToken) return oauthDolthubToken;
    if (manualOpen && dolthubToken.trim()) return dolthubToken;
    return null;
  };

  /**
   * Provision path: the user picked commons / connect / create. We
   * always create a wasteland record; for `create` we additionally
   * bootstrap the DoltHub repo. For commons/connect we just register
   * a credential against the existing upstream and forward to the
   * town-connect mutations.
   */
  const handleConnectProvision = async () => {
    if (intent.kind === 'reuse') {
      // The Connect button shouldn't be reachable for reuse (we drive
      // straight to handleConnectReuse from the picker), but guard
      // defensively in case someone hit Enter from the credentials
      // form.
      return handleConnectReuse(intent.wastelandId);
    }

    setStep('connecting');
    setError(null);

    try {
      const upstream = resolveUpstreamFromIntent(intent);
      setConnectedUpstream(upstream);

      const name = newWastelandName.trim() || defaultWastelandName(intent);

      const tokenToStore = resolveDolthubToken();
      if (!tokenToStore) {
        throw new Error('Connect your DoltHub account or paste an API token to continue.');
      }

      // 1. Create the wasteland record (auto-adds caller as owner member)
      const created = await wastelandClient.wasteland.createWasteland.mutate({
        name,
        ownerType: 'user',
        dolthubUpstream: upstream,
      });
      const wastelandId = created.wasteland_id;
      setConnectedWastelandId(wastelandId);

      // 2. Store credentials. For `create` the user is the admin by
      // definition; for `commons` / `connect` we honour the toggle on
      // the corresponding picker card.
      const isUpstreamAdmin = intent.kind === 'create' ? true : intent.isUpstreamAdmin;
      await wastelandClient.wasteland.storeCredential.mutate({
        wastelandId,
        dolthubToken: tokenToStore,
        dolthubOrg,
        rigHandle,
        isUpstreamAdmin,
      });

      // 3. Bootstrap the DoltHub repo + register the creator as the first
      // rig — only when the user actually wants a brand-new upstream. For
      // the commons/connect intents the upstream already exists.
      if (intent.kind === 'create') {
        await wastelandClient.wasteland.createUpstream.mutate({
          wastelandId,
          upstream,
          rigHandle,
        });
      } else if (intent.kind === 'commons' || intent.kind === 'connect') {
        // 3b. Run the explicit fork-and-register ceremony (M2.7).
        // The previous flow stored credentials and called `connectKiloTown`
        // without ever forking the upstream or opening the registration
        // PR — those happened lazily on the first wanted-board op. The
        // dedicated `joinWasteland` procedure makes the ceremony explicit
        // and surfaces the registration PR up front.
        // TODO(M2.7-ui): refactor this dialog to a 5-step wizard (intent
        // → credentials → rig handle → preview → success) matching the
        // standalone `/wasteland/new` flow. For now we keep the existing
        // 3-step wizard and bolt on the join call here so the gastown
        // path produces the same server-side result as the standalone
        // wizard.
        await wastelandClient.wasteland.joinWasteland.mutate({
          wastelandId,
          rigHandle,
        });
      }

      // 4. Persist the town↔wasteland association on the Town DO.
      //    createWasteland already added the user as a wasteland member,
      //    so connectKiloTown isn't strictly required — but we still need
      //    the Gastown-side connection for the mayor tools.
      await wastelandClient.wasteland.connectKiloTown.mutate({
        wastelandId,
        townId,
      });
      await gastownClient.gastown.connectTownToWasteland.mutate({
        townId,
        wastelandId,
        upstream,
        rigHandle,
        dolthubOrg,
      });

      if (!manualOpen && oauthDolthubToken && dolthubOrg.trim()) {
        rememberUsername.mutate({ username: dolthubOrg.trim() });
      }

      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed');
      setStep('identity');
    }
  };

  // Verify Card 2's typed upstream against DoltHub. Reused so the "Next"
  // button refuses to advance while the probe is pending or "missing".
  const connectVerification = useUpstreamVerification({
    upstream: intent.kind === 'connect' ? intent.upstream : '',
    enabled: intent.kind === 'connect',
  });
  const createVerification = useUpstreamVerification({
    upstream: intent.kind === 'create' ? intent.upstream : '',
    enabled: intent.kind === 'create',
  });
  // For create mode we want exists=false (the repo shouldn't already
  // exist) — block the Next button while the probe says exists=true.
  const upstreamProbeBlocked =
    (intent.kind === 'connect' &&
      (connectVerification.status === 'pending' || connectVerification.status === 'missing')) ||
    (intent.kind === 'create' &&
      (createVerification.status === 'pending' || createVerification.status === 'exists'));
  // The wasteland name auto-defaults to the upstream when the user
  // hasn't typed anything, so we don't gate on it being non-empty.
  // The reuse intent skips this step's "Next" button entirely (the
  // picker drives `handleConnectReuse` directly), but keep the validity
  // check honest by not requiring upstream verification for reuse.
  const newDetailsValid = isUpstreamIntentValid(intent) && !upstreamProbeBlocked;
  // The credentials step accepts either:
  //   - the OAuth-issued token (when the dolthub integration is installed
  //     and the user hasn't toggled the manual fallback open), plus a
  //     username so we can label commits and contribution branches; or
  //   - a manually pasted API token + username when the user opted in to
  //     the "Advanced" disclosure.
  const oauthCredentialsValid =
    !manualOpen && Boolean(oauthDolthubToken) && dolthubOrg.trim().length > 0;
  const manualCredentialsValid =
    manualOpen && dolthubToken.trim().length > 0 && dolthubOrg.trim().length > 0;
  const credentialsValid = oauthCredentialsValid || manualCredentialsValid;
  const identityValid = rigHandle.trim().length > 0;

  // Wastelands the caller has a stored credential on — fed to the
  // picker's "Reuse existing connection" card. We hide deleted /
  // disconnecting entries and exclude wastelands without an upstream
  // (those aren't useful as a reuse target — there's nowhere to send
  // contributions yet).
  const reusableWastelands = wastelands
    .filter(w => w.status === 'active' && w.dolthub_upstream)
    .map(w => ({
      wasteland_id: w.wasteland_id,
      name: w.name,
      dolthub_upstream: w.dolthub_upstream,
    }));
  const hasCommonsConnection = wastelands.some(w => w.dolthub_upstream === KILO_COMMONS_UPSTREAM);

  // Whether the primary action proceeds via the reuse short-circuit
  // (no credentials / identity steps) or the full provision flow.
  const isReuseIntent = intent.kind === 'reuse';

  // Connecting label varies by intent. For `create` we're bootstrapping
  // a DoltHub repo; for `commons` / `connect` / `reuse` we're just
  // wiring up the town to an existing upstream.
  const connectingHeadline = intent.kind === 'create' ? 'Creating…' : 'Connecting…';
  const successHeadline = intent.kind === 'create' ? 'Wasteland created' : 'Connected';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        {step === 'new-details' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Connect to a wasteland</DialogTitle>
              <DialogDescription className="text-white/50">
                Pick what this town&apos;s upstream should be. We default to The Commons —
                contributions go upstream as pull requests.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <UpstreamIntentPicker
                value={intent}
                onChange={setIntent}
                dolthubUsername={
                  resolveUsernameQuery.data?.username ??
                  dolthubCredentialsQuery.data?.dolthubUsername ??
                  null
                }
                reusableWastelands={reusableWastelands}
                commonsDisabled={hasCommonsConnection}
              />
              {!isReuseIntent && (
                <FieldGroup
                  label="Wasteland name"
                  hint={
                    newWastelandName.trim().length === 0
                      ? `Defaults to ${defaultWastelandName(intent) || 'the upstream name'}.`
                      : "Display name shown in the UI; doesn't have to match the DoltHub repo."
                  }
                >
                  <Input
                    value={newWastelandName}
                    onChange={e => setNewWastelandName(e.target.value)}
                    placeholder={defaultWastelandName(intent) || 'owner/repo'}
                    className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                  />
                </FieldGroup>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => handleOpenChange(false)}
                className="border-white/10 text-white/70 hover:bg-white/5"
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                disabled={!newDetailsValid}
                onClick={() => {
                  if (isReuseIntent) {
                    void handleConnectReuse(intent.wastelandId);
                  } else {
                    setStep('credentials');
                  }
                }}
                className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                {isReuseIntent ? 'Connect' : 'Next'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'credentials' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">DoltHub credentials</DialogTitle>
              <DialogDescription className="text-white/50">
                {intent.kind === 'create'
                  ? 'Connect your DoltHub account to create the repo and register the first rig.'
                  : 'Connect your DoltHub account to fork the upstream and push contributions.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {installationQuery.isLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <Loader2 className="size-3.5 animate-spin text-white/30" />
                  <span className="text-xs text-white/40">Checking DoltHub integration...</span>
                </div>
              ) : isDolthubInstalled ? (
                <div className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
                  <div className="flex items-start gap-2">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[color:oklch(95%_0.15_108_/_0.9)]" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-white/85">Use your connected DoltHub account</p>
                      <p className="mt-0.5 text-[11px] text-white/40">
                        We&apos;ll forward your OAuth-issued token. Just confirm your DoltHub
                        username so we can label commits and contribution branches.
                      </p>
                    </div>
                  </div>
                  <FieldGroup
                    label="Your DoltHub username"
                    hint={
                      dolthubCredentialsQuery.data?.dolthubUsername
                        ? 'Cached from your last connect. Edit if needed.'
                        : 'Saved on the DoltHub integration after connect.'
                    }
                  >
                    <Input
                      name="dolthub-handle"
                      value={dolthubOrg}
                      onChange={e => setDolthubOrg(e.target.value)}
                      placeholder="my-username"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                      data-form-type="other"
                      className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                    />
                  </FieldGroup>
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <p className="text-sm text-white/70">
                    Connect with DoltHub for the smoothest setup
                  </p>
                  <p className="text-[11px] text-white/40">
                    Install the DoltHub integration once and skip pasting tokens.
                  </p>
                  <a
                    href="/integrations/dolthub"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-[color:oklch(95%_0.15_108_/_0.9)] underline-offset-4 hover:underline"
                  >
                    Install DoltHub integration
                    <ArrowUpRight className="size-3" />
                  </a>
                </div>
              )}

              {/* The manual-token form is wrapped in a sentinel `form` with
                  autoComplete="off" plus a non-credential name on the
                  username-shaped field so Chrome / 1Password / LastPass
                  don't fingerprint it as a sign-in form. The token field
                  uses SecretTokenInput which renders type="text" with
                  visual masking instead of type="password". */}
              <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[11px] text-white/40 hover:text-white/60">
                  <span className="uppercase tracking-wider">Advanced — paste an API token</span>
                  <ChevronDown
                    className={`size-3 transition-transform ${manualOpen ? 'rotate-180' : ''}`}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-3">
                  <form autoComplete="off" className="space-y-3" onSubmit={e => e.preventDefault()}>
                    <FieldGroup
                      label="DoltHub API token"
                      hint="Create one at dolthub.com/settings/tokens"
                    >
                      <SecretTokenInput
                        name="dolthub-api-token"
                        value={dolthubToken}
                        onChange={e => setDolthubToken(e.target.value)}
                        placeholder="Paste a personal API token"
                        toggleLabel="Show DoltHub token"
                        className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                      />
                    </FieldGroup>
                    <FieldGroup label="DoltHub username" hint="Your DoltHub username or org">
                      <Input
                        name="dolthub-handle"
                        value={dolthubOrg}
                        onChange={e => setDolthubOrg(e.target.value)}
                        placeholder="my-username"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-1p-ignore="true"
                        data-lpignore="true"
                        data-form-type="other"
                        className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                      />
                    </FieldGroup>
                  </form>
                </CollapsibleContent>
              </Collapsible>

              {/* The "I own this upstream" toggle now lives on the
                  picker, per intent card, so the credentials step no
                  longer renders a duplicate. */}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep('new-details')}
                className="gap-1.5 border-white/10 text-white/70 hover:bg-white/5"
              >
                <ChevronLeft className="size-3" />
                Back
              </Button>
              <Button
                variant="secondary"
                disabled={!credentialsValid}
                onClick={handleProceedToIdentity}
                className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                Next
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'identity' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Rig identity</DialogTitle>
              <DialogDescription className="text-white/50">
                Choose a handle for this town&apos;s rig on the commons. This identifies your
                contributions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <FieldGroup
                label="Rig handle"
                hint="A unique identifier for this town on the wasteland"
              >
                <Input
                  value={rigHandle}
                  onChange={e => setRigHandle(e.target.value)}
                  placeholder="kilo-my-town"
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep('credentials')}
                className="border-white/10 text-white/70 hover:bg-white/5"
              >
                Back
              </Button>
              <Button
                variant="secondary"
                disabled={!identityValid}
                onClick={handleConnectProvision}
                className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                Connect
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'connecting' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">{connectingHeadline}</DialogTitle>
              <DialogDescription className="text-white/50">
                {intent.kind === 'create' ? (
                  <>
                    Bootstrapping{' '}
                    <span className="font-mono text-white/70">
                      {resolveUpstreamFromIntent(intent)}
                    </span>{' '}
                    on DoltHub and registering{' '}
                    <span className="font-mono text-white/70">{rigHandle}</span> as the first rig.
                  </>
                ) : intent.kind === 'reuse' ? (
                  <>
                    Wiring this town to{' '}
                    <span className="font-mono text-white/70">{connectedUpstream}</span>.
                  </>
                ) : (
                  <>
                    Connecting this town to{' '}
                    <span className="font-mono text-white/70">
                      {resolveUpstreamFromIntent(intent)}
                    </span>
                    {rigHandle && (
                      <>
                        {' '}
                        as <span className="font-mono text-white/70">{rigHandle}</span>
                      </>
                    )}
                    .
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="size-8 animate-spin text-white/30" />
              <p className="text-xs text-white/40">This may take a minute…</p>
            </div>
          </>
        )}

        {step === 'success' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">{successHeadline}</DialogTitle>
              <DialogDescription className="text-white/50">
                {intent.kind === 'create'
                  ? 'Your wasteland is live. Invite contributors from settings.'
                  : 'This town is now connected to the wasteland.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="size-10 text-emerald-400" />
              <div className="text-center">
                <p className="text-sm text-white/70">
                  {intent.kind === 'create' ? 'Your wasteland is live at ' : 'Connected to '}
                  <span className="font-mono text-emerald-400">{connectedUpstream}</span>{' '}
                  {rigHandle && (
                    <>
                      as <span className="font-mono text-white/70">{rigHandle}</span>
                    </>
                  )}
                </p>
                <p className="mt-2 text-xs text-white/40">
                  {intent.kind === 'create'
                    ? "You're the owner and admin. You can invite contributors from wasteland settings."
                    : 'Agents now have access to wasteland tools. Try asking the mayor to browse the wasteland.'}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => handleOpenChange(false)}
                className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                Done
              </Button>
              {connectedWastelandId && (
                <Link
                  href={wastelandHref({
                    wastelandId: connectedWastelandId,
                    upstream: connectedUpstream,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                >
                  Visit wasteland
                  <ArrowRight className="size-3.5" />
                </Link>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-white/55">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-white/25">{hint}</p>}
    </div>
  );
}
