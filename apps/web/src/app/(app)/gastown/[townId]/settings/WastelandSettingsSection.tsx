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
import { Globe, Loader2, CheckCircle2, Unlink, Skull, Plus } from 'lucide-react';

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
  const wastelandTrpc = useWastelandTRPC();

  const credentialQuery = useQuery(
    wastelandTrpc.wasteland.getCredentialStatus.queryOptions({
      wastelandId: connection.wasteland_id,
    })
  );
  const isUpstreamAdmin = credentialQuery.data?.is_upstream_admin ?? false;

  const setUpstreamAdmin = useMutation(
    wastelandTrpc.wasteland.setUpstreamAdmin.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: wastelandTrpc.wasteland.getCredentialStatus.queryKey({
            wastelandId: connection.wasteland_id,
          }),
        });
      },
      onError: err => toast.error(`Failed to update admin mode: ${err.message}`),
    })
  );

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-white/70">
                Connected to{' '}
                <span className="font-mono text-emerald-400">{connection.upstream}</span>
              </p>
              {isUpstreamAdmin && (
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  Admin
                </span>
              )}
            </div>
            <p className="text-[11px] text-white/30">
              Rig: <span className="font-mono text-white/50">{connection.rig_handle}</span>
              {' · '}
              Org: <span className="font-mono text-white/50">{connection.dolthub_org}</span>
            </p>
          </div>
        </div>
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

      <label
        className={`flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 ${
          readOnly ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
        }`}
      >
        <input
          type="checkbox"
          checked={isUpstreamAdmin}
          disabled={readOnly || setUpstreamAdmin.isPending || credentialQuery.isLoading}
          onChange={e =>
            setUpstreamAdmin.mutate({
              wastelandId: connection.wasteland_id,
              isUpstreamAdmin: e.target.checked,
            })
          }
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-emerald-500"
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-white/70">I own this upstream (admin mode)</p>
          <p className="mt-0.5 text-[11px] text-white/30">
            Enables direct writes, PR merge controls, and the ability to accept contributions.
            Requires a DoltHub token with push access to{' '}
            <span className="font-mono text-white/50">{connection.upstream}</span>.
          </p>
        </div>
      </label>
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

type Step = 'select' | 'credentials' | 'identity' | 'connecting' | 'success';

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

  const [step, setStep] = useState<Step>('select');

  // Existing wastelands
  const wastelandsQuery = useQuery(wastelandTrpc.wasteland.listWastelands.queryOptions({}));
  const wastelands = wastelandsQuery.data ?? [];
  const [selectedWastelandId, setSelectedWastelandId] = useState<string | null>(null);

  // Step: Credentials
  const [dolthubToken, setDolthubToken] = useState('');
  const [dolthubOrg, setDolthubOrg] = useState('');
  const [doltCredsJwk, setDoltCredsJwk] = useState('');
  // User explicitly attests they own the upstream. Unlocks admin mode
  // (direct writes, PR merge controls) in the wasteland UI.
  const [isUpstreamAdmin, setIsUpstreamAdmin] = useState(false);
  // Only editable in the "Create new" flow — when selecting an existing
  // wasteland, its upstream is used.
  const [upstreamInput, setUpstreamInput] = useState(DEFAULT_UPSTREAM);

  // Step 2: Identity
  const [rigHandle, setRigHandle] = useState('');
  const [doltUserName, setDoltUserName] = useState('');
  const [doltUserEmail, setDoltUserEmail] = useState('');

  const [connectedUpstream, setConnectedUpstream] = useState(DEFAULT_UPSTREAM);
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
      setStep('select');
      setSelectedWastelandId(null);
      setConnectedUpstream(DEFAULT_UPSTREAM);
      setUpstreamInput(DEFAULT_UPSTREAM);
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

      // Connect the town in the wasteland service
      await wastelandClient.wasteland.connectKiloTown.mutate({
        wastelandId,
        townId,
      });

      // Persist the connection in the Town DO
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

      // Show the existing rig handle on the success screen
      setRigHandle(existingRigHandle);
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStep('select');
    }
  };

  const handleConnect = async () => {
    setStep('connecting');
    setError(null);

    try {
      let wastelandId = selectedWastelandId;
      const selectedWasteland = wastelands.find(w => w.wasteland_id === wastelandId);
      const upstream = selectedWasteland?.dolthub_upstream ?? upstreamInput.trim();
      setConnectedUpstream(upstream);

      if (!wastelandId) {
        // Create a new wasteland pointing at the chosen upstream
        const created = await wastelandClient.wasteland.createWasteland.mutate({
          name: `${dolthubOrg}-${upstream.split('/')[1] ?? 'wasteland'}`,
          ownerType: 'user',
          dolthubUpstream: upstream,
        });
        wastelandId = created.wasteland_id;
      }

      // Store credentials in the wasteland (encrypts token, pushes to container)
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

      // Connect the town in the wasteland service
      await wastelandClient.wasteland.connectKiloTown.mutate({
        wastelandId,
        townId,
      });

      // Persist the connection in the Town DO
      await gastownClient.gastown.connectTownToWasteland.mutate({
        townId,
        wastelandId,
        upstream,
        rigHandle,
        dolthubOrg,
      });

      // Invalidate the connection query so the UI updates
      void queryClient.invalidateQueries({
        queryKey: gastownTrpc.gastown.getTownWastelandConnection.queryKey({ townId }),
      });

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStep('identity');
    }
  };

  const upstreamValid =
    selectedWastelandId !== null || /^[^/\s]+\/[^/\s]+$/.test(upstreamInput.trim());
  const credentialsValid =
    dolthubToken.trim().length > 0 && dolthubOrg.trim().length > 0 && upstreamValid;
  const identityValid = rigHandle.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        {step === 'select' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">Connect to Wasteland</DialogTitle>
              <DialogDescription className="text-white/50">
                Select an existing wasteland or create a new connection.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              {wastelandsQuery.isLoading ? (
                <div className="flex items-center gap-2 py-4">
                  <Loader2 className="size-3.5 animate-spin text-white/30" />
                  <span className="text-xs text-white/40">Loading wastelands...</span>
                </div>
              ) : wastelands.length > 0 ? (
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
                  <p className="text-xs text-white/40">No wastelands found.</p>
                  <p className="mt-1 text-[11px] text-white/25">
                    A new one will be created when you connect.
                  </p>
                </div>
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
                onClick={() => {
                  setSelectedWastelandId(null);
                  setStep('credentials');
                }}
                className="gap-1.5 bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
              >
                <Plus className="size-3" />
                Create new
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'credentials' && (
          <>
            <DialogHeader>
              <DialogTitle className="text-white/90">DoltHub Credentials</DialogTitle>
              <DialogDescription className="text-white/50">
                Enter your DoltHub credentials. These are used to fork the commons and push
                contributions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {selectedWastelandId === null && (
                <FieldGroup
                  label="DoltHub Upstream"
                  hint="The repo to fork and submit PRs against. Format: org/db"
                >
                  <Input
                    value={upstreamInput}
                    onChange={e => setUpstreamInput(e.target.value)}
                    placeholder="hop/wl-commons"
                    className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                  />
                </FieldGroup>
              )}
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
                    contributions from others. Only check this if your DoltHub token has push access
                    to the upstream repo. You can toggle this later in settings.
                  </p>
                </div>
              </label>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setStep('select')}
                className="border-white/10 text-white/70 hover:bg-white/5"
              >
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
              <DialogTitle className="text-white/90">Connecting...</DialogTitle>
              <DialogDescription className="text-white/50">
                Setting up credentials, forking the commons, and joining as{' '}
                <span className="font-mono text-white/70">{rigHandle}</span>.
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
              <DialogTitle className="text-white/90">Connected</DialogTitle>
              <DialogDescription className="text-white/50">
                This town is now connected to the Wasteland Commons.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="size-10 text-emerald-400" />
              <div className="text-center">
                <p className="text-sm text-white/70">
                  Connected to{' '}
                  <span className="font-mono text-emerald-400">{connectedUpstream}</span> as{' '}
                  <span className="font-mono text-white/70">{rigHandle}</span>
                </p>
                <p className="mt-2 text-xs text-white/40">
                  Agents now have access to wasteland tools. Try asking the mayor to browse the
                  wasteland.
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
