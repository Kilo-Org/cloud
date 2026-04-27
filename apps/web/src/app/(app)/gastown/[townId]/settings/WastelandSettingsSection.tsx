'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC, useGastownTRPCClient } from '@/lib/gastown/trpc';
import { useWastelandTRPC, useWastelandTRPCClient } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Skull,
  Users,
  Rocket,
  ChevronLeft,
  ArrowRight,
} from 'lucide-react';
import Link from 'next/link';

const DEFAULT_UPSTREAM = 'hop/wl-commons';

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
        href={`/wasteland/${connection.wasteland_id}`}
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

type Mode = 'join' | 'create';
type Step =
  | 'intent'
  | 'select'
  | 'new-details'
  | 'credentials'
  | 'identity'
  | 'connecting'
  | 'success';

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
  const gastownClient = useGastownTRPCClient();
  const wastelandClient = useWastelandTRPCClient();
  const { data: currentUser } = useUser();

  const [step, setStep] = useState<Step>('intent');
  const [mode, setMode] = useState<Mode>('join');

  // Existing wastelands
  const wastelandsQuery = useQuery(wastelandTrpc.wasteland.listWastelands.queryOptions({}));
  const wastelands = wastelandsQuery.data ?? [];
  const [selectedWastelandId, setSelectedWastelandId] = useState<string | null>(null);

  // Create-mode details
  const [newWastelandName, setNewWastelandName] = useState('');
  const [upstreamInput, setUpstreamInput] = useState(DEFAULT_UPSTREAM);

  // Step: Credentials
  const [dolthubToken, setDolthubToken] = useState('');
  const [dolthubOrg, setDolthubOrg] = useState('');
  const [doltCredsJwk, setDoltCredsJwk] = useState('');
  // User explicitly attests they own the upstream. Create mode implies
  // this is true (they're creating the repo) but keep it toggleable so
  // they can opt back out.
  const [isUpstreamAdmin, setIsUpstreamAdmin] = useState(false);

  // Step: Identity
  const [rigHandle, setRigHandle] = useState('');
  const [doltUserName, setDoltUserName] = useState('');
  const [doltUserEmail, setDoltUserEmail] = useState('');

  const [connectedUpstream, setConnectedUpstream] = useState(DEFAULT_UPSTREAM);
  /** wastelandId that just got connected — used to offer a "Visit wasteland"
   *  link in the success step. */
  const [connectedWastelandId, setConnectedWastelandId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill identity fields from user profile
  const handleProceedToIdentity = () => {
    const displayName = currentUser?.google_user_name;
    const email = currentUser?.google_user_email;
    if (!rigHandle && displayName) {
      setRigHandle(`kilo-${displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    }
    if (!doltUserName && displayName) {
      setDoltUserName(displayName);
    }
    if (!doltUserEmail && email) {
      setDoltUserEmail(email);
    }
    setStep('identity');
  };

  // Reset state when dialog closes
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep('intent');
      setMode('join');
      setSelectedWastelandId(null);
      setConnectedUpstream(DEFAULT_UPSTREAM);
      setConnectedWastelandId(null);
      setUpstreamInput(DEFAULT_UPSTREAM);
      setNewWastelandName('');
      setDolthubToken('');
      setDolthubOrg('');
      setDoltCredsJwk('');
      setIsUpstreamAdmin(false);
      setRigHandle('');
      setDoltUserName('');
      setDoltUserEmail('');
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const handlePickMode = (next: Mode) => {
    setMode(next);
    setIsUpstreamAdmin(next === 'create');
    setStep(next === 'join' ? 'select' : 'new-details');
  };

  const handleSelectWasteland = async (wastelandId: string) => {
    setSelectedWastelandId(wastelandId);

    // If credentials are already stored for this wasteland, skip straight
    // to the connection — the user has already connected their DoltHub
    // account to this wasteland and doesn't need to re-enter them.
    try {
      const existing = await wastelandClient.wasteland.getCredentialStatus.query({
        wastelandId,
      });
      if (existing) {
        await connectTownToExistingWasteland(
          wastelandId,
          existing.rig_handle ?? '',
          existing.dolthub_org
        );
        return;
      }
    } catch (err) {
      // If the check fails, fall through to the credentials step
      console.error('Failed to check wasteland credentials', err);
    }

    setStep('credentials');
  };

  const connectTownToExistingWasteland = async (
    wastelandId: string,
    existingRigHandle: string,
    existingDolthubOrg: string
  ) => {
    setStep('connecting');
    setError(null);

    try {
      const selectedWasteland = wastelands.find(w => w.wasteland_id === wastelandId);
      const upstream = selectedWasteland?.dolthub_upstream ?? DEFAULT_UPSTREAM;
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
        rigHandle: existingRigHandle,
        dolthubOrg: existingDolthubOrg,
      });

      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setRigHandle(existingRigHandle);
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStep('select');
    }
  };

  const handleConnectJoin = async () => {
    setStep('connecting');
    setError(null);

    try {
      const wastelandId = selectedWastelandId;
      const selectedWasteland = wastelands.find(w => w.wasteland_id === wastelandId);
      const upstream = selectedWasteland?.dolthub_upstream ?? DEFAULT_UPSTREAM;
      setConnectedUpstream(upstream);

      // Brand-new wasteland record is only created when the user picked
      // a non-listed upstream — this only applies if they used the
      // intent flow to "join" a new, unknown upstream. For now we still
      // require a selection on the join branch.
      if (!wastelandId) {
        throw new Error('Select a wasteland to join, or switch to Create.');
      }
      setConnectedWastelandId(wastelandId);

      await wastelandClient.wasteland.storeCredential.mutate({
        wastelandId,
        dolthubToken,
        dolthubOrg,
        rigHandle,
        doltCredsJwk: doltCredsJwk.trim() || undefined,
        doltUserName: doltUserName.trim() || undefined,
        doltUserEmail: doltUserEmail.trim() || undefined,
        isUpstreamAdmin,
      });

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

      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStep('identity');
    }
  };

  const handleConnectCreate = async () => {
    setStep('connecting');
    setError(null);

    try {
      const upstream = upstreamInput.trim();
      setConnectedUpstream(upstream);

      const name =
        newWastelandName.trim() || `${dolthubOrg}-${upstream.split('/')[1] ?? 'wasteland'}`;

      // 1. Create the wasteland record (auto-adds caller as owner member)
      const created = await wastelandClient.wasteland.createWasteland.mutate({
        name,
        ownerType: 'user',
        dolthubUpstream: upstream,
      });
      const wastelandId = created.wasteland_id;
      setConnectedWastelandId(wastelandId);

      // 2. Store credentials with admin flag (required for createUpstream)
      await wastelandClient.wasteland.storeCredential.mutate({
        wastelandId,
        dolthubToken,
        dolthubOrg,
        rigHandle,
        doltCredsJwk: doltCredsJwk.trim() || undefined,
        doltUserName: doltUserName.trim() || undefined,
        doltUserEmail: doltUserEmail.trim() || undefined,
        isUpstreamAdmin: true,
      });

      // 3. Bootstrap the DoltHub repo + register the creator as the first rig.
      await wastelandClient.wasteland.createUpstream.mutate({
        wastelandId,
        upstream,
        rigHandle,
        rigDisplayName: doltUserName.trim() || undefined,
        rigEmail: doltUserEmail.trim() || undefined,
      });

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

      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
      setStep('identity');
    }
  };

  const handleConnect = () => {
    if (mode === 'create') return handleConnectCreate();
    return handleConnectJoin();
  };

  const upstreamValid = /^[^/\s]+\/[^/\s]+$/.test(upstreamInput.trim());
  const newDetailsValid = upstreamValid && newWastelandName.trim().length > 0;
  const credentialsValid = dolthubToken.trim().length > 0 && dolthubOrg.trim().length > 0;
  const identityValid = rigHandle.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        {step === 'intent' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Connect to Wasteland</DialogTitle>
              <DialogDescription className="text-white/50">
                Join an existing wasteland to contribute, or create your own.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <button
                type="button"
                onClick={() => handlePickMode('join')}
                className="flex w-full items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.04]"
              >
                <Users className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white/85">Join a wasteland</p>
                  <p className="mt-0.5 text-[11px] text-white/40">
                    Contribute to an existing wasteland (like the Kilo Commons). Your agents will be
                    able to browse and claim bounties, submit PRs back upstream.
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => handlePickMode('create')}
                className="flex w-full items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.04]"
              >
                <Rocket className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white/85">Create your own wasteland</p>
                  <p className="mt-0.5 text-[11px] text-white/40">
                    Bootstrap a new DoltHub commons repo and make yourself the owner. Requires a
                    DoltHub token with push access.
                  </p>
                </div>
              </button>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => handleOpenChange(false)}
                className="border-white/10 text-white/70 hover:bg-white/5"
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'select' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Pick a Wasteland to Join</DialogTitle>
              <DialogDescription className="text-white/50">
                Select one of your existing wastelands below.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              {wastelandsQuery.isLoading ? (
                <div className="flex items-center gap-2 py-4">
                  <Loader2 className="size-3.5 animate-spin text-white/30" />
                  <span className="text-xs text-white/40">Loading wastelands...</span>
                </div>
              ) : wastelands.filter(w => w.status === 'active').length > 0 ? (
                wastelands
                  .filter(w => w.status === 'active')
                  .map(w => (
                    <button
                      key={w.wasteland_id}
                      type="button"
                      onClick={() => void handleSelectWasteland(w.wasteland_id)}
                      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        selectedWastelandId === w.wasteland_id
                          ? 'border-emerald-500/30 bg-emerald-500/5'
                          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]'
                      }`}
                    >
                      <Skull className="size-4 shrink-0 text-white/30" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-white/70">{w.name}</p>
                        {w.dolthub_upstream && (
                          <p className="truncate font-mono text-[11px] text-white/30">
                            {w.dolthub_upstream}
                          </p>
                        )}
                      </div>
                    </button>
                  ))
              ) : (
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-center">
                  <Skull className="mx-auto mb-2 size-5 text-white/15" />
                  <p className="text-xs text-white/40">No wastelands to join yet.</p>
                  <p className="mt-1 text-[11px] text-white/25">
                    Go back and pick "Create your own" to bootstrap one.
                  </p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep('intent')}
                className="gap-1.5 border-white/10 text-white/70 hover:bg-white/5"
              >
                <ChevronLeft className="size-3" />
                Back
              </Button>
              <Button
                variant="secondary"
                onClick={() => handleOpenChange(false)}
                className="border-white/10 text-white/70 hover:bg-white/5"
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'new-details' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Create a Wasteland</DialogTitle>
              <DialogDescription className="text-white/50">
                Name your wasteland and pick the DoltHub repo to bootstrap. We'll create the repo
                for you and register your first rig.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <FieldGroup
                label="Wasteland Name"
                hint="Display name shown in the UI; doesn't have to match the DoltHub repo."
              >
                <Input
                  value={newWastelandName}
                  onChange={e => setNewWastelandName(e.target.value)}
                  placeholder="My Wasteland"
                  className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <FieldGroup
                label="DoltHub Upstream"
                hint="New repo to create. Format: org/db. The org must already exist on DoltHub."
              >
                <Input
                  value={upstreamInput}
                  onChange={e => setUpstreamInput(e.target.value)}
                  placeholder="my-org/my-wasteland"
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep('intent')}
                className="gap-1.5 border-white/10 text-white/70 hover:bg-white/5"
              >
                <ChevronLeft className="size-3" />
                Back
              </Button>
              <Button
                variant="secondary"
                disabled={!newDetailsValid}
                onClick={() => setStep('credentials')}
                className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                Next
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'credentials' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">DoltHub Credentials</DialogTitle>
              <DialogDescription className="text-white/50">
                {mode === 'create'
                  ? 'Enter DoltHub credentials with push access — these are used to create the repo and register the first rig.'
                  : 'Enter your DoltHub credentials. These are used to fork the commons and push contributions.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <FieldGroup
                label="DoltHub API Token"
                hint="Create one at dolthub.com/settings/tokens"
              >
                <Input
                  type="password"
                  value={dolthubToken}
                  onChange={e => setDolthubToken(e.target.value)}
                  placeholder="Enter your DoltHub API token"
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <FieldGroup label="DoltHub Organization" hint="Your DoltHub username or org">
                <Input
                  value={dolthubOrg}
                  onChange={e => setDolthubOrg(e.target.value)}
                  placeholder="my-org"
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <FieldGroup
                label="Dolt Credential (JWK)"
                hint="Optional. Contents of your ~/.dolt/creds/*.jwk file. Required for dolt push."
              >
                <Input
                  type="password"
                  value={doltCredsJwk}
                  onChange={e => setDoltCredsJwk(e.target.value)}
                  placeholder='{"kid":"...","kty":"OKP",...}'
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={isUpstreamAdmin}
                  onChange={e => setIsUpstreamAdmin(e.target.checked)}
                  className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-emerald-500"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white/70">I own this upstream</p>
                  <p className="mt-0.5 text-[11px] text-white/30">
                    Unlocks admin mode — direct writes, PR merge controls, and the ability to accept
                    contributions from others.{' '}
                    {mode === 'create'
                      ? "Enabled by default since you're creating this repo."
                      : 'Only check this if your DoltHub token has push access to the upstream repo.'}
                    You can toggle this later in settings.
                  </p>
                </div>
              </label>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep(mode === 'create' ? 'new-details' : 'select')}
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
              <DialogTitle className="text-white/90">Rig Identity</DialogTitle>
              <DialogDescription className="text-white/50">
                Choose a handle for this town&apos;s rig on the commons. This identifies your
                contributions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <FieldGroup
                label="Rig Handle"
                hint="A unique identifier for this town on the wasteland"
              >
                <Input
                  value={rigHandle}
                  onChange={e => setRigHandle(e.target.value)}
                  placeholder="kilo-my-town"
                  className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <FieldGroup label="Dolt User Name" hint="Used for dolt commits (like git user.name)">
                <Input
                  value={doltUserName}
                  onChange={e => setDoltUserName(e.target.value)}
                  placeholder="Your Name"
                  className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                />
              </FieldGroup>
              <FieldGroup
                label="Dolt User Email"
                hint="Used for dolt commits (like git user.email)"
              >
                <Input
                  value={doltUserEmail}
                  onChange={e => setDoltUserEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
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
                onClick={handleConnect}
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
              <DialogTitle className="text-white/90">
                {mode === 'create' ? 'Creating...' : 'Connecting...'}
              </DialogTitle>
              <DialogDescription className="text-white/50">
                {mode === 'create' ? (
                  <>
                    Bootstrapping{' '}
                    <span className="font-mono text-white/70">{upstreamInput.trim()}</span> on
                    DoltHub and registering{' '}
                    <span className="font-mono text-white/70">{rigHandle}</span> as the first rig.
                  </>
                ) : (
                  <>
                    Setting up credentials, forking the commons, and joining as{' '}
                    <span className="font-mono text-white/70">{rigHandle}</span>.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="size-8 animate-spin text-white/30" />
              <p className="text-xs text-white/40">This may take a minute...</p>
            </div>
          </>
        )}

        {step === 'success' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">
                {mode === 'create' ? 'Wasteland created' : 'Connected'}
              </DialogTitle>
              <DialogDescription className="text-white/50">
                {mode === 'create'
                  ? 'Your wasteland is live. Invite contributors from settings.'
                  : 'This town is now connected to the wasteland.'}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="size-10 text-emerald-400" />
              <div className="text-center">
                <p className="text-sm text-white/70">
                  {mode === 'create' ? 'Your wasteland is live at ' : 'Connected to '}
                  <span className="font-mono text-emerald-400">{connectedUpstream}</span>{' '}
                  {rigHandle && (
                    <>
                      as <span className="font-mono text-white/70">{rigHandle}</span>
                    </>
                  )}
                </p>
                <p className="mt-2 text-xs text-white/40">
                  {mode === 'create'
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
                  href={`/wasteland/${connectedWastelandId}`}
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
