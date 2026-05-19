'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useTRPC } from '@/lib/trpc/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useUser } from '@/hooks/useUser';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SettingsSection,
  FieldGroup,
  SettingsScrollspyNav,
  useScrollSpy,
  type SettingsNavItem,
} from '@/components/settings';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  Settings,
  Save,
  Database,
  Trash2,
  Link2,
  Unlink,
  CheckCircle2,
  XCircle,
  Building2,
  Plus,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  ChevronDown,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type Props = { wastelandId: string };

export function SettingsClient({ wastelandId }: Props) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const router = useRouter();

  const gastownTrpc = useGastownTRPC();

  const wastelandQuery = useQuery(trpc.wasteland.getWasteland.queryOptions({ wastelandId }));
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const membersQuery = useQuery(trpc.wasteland.listMembers.queryOptions({ wastelandId }));
  const connectedTownsQuery = useQuery(
    trpc.wasteland.listConnectedTowns.queryOptions({ wastelandId })
  );

  const wasteland = wastelandQuery.data;
  const credential = credentialQuery.data;
  const members = membersQuery.data ?? [];
  const currentUserMember = members.find(m => m.user_id === currentUser?.id);
  const isOwner = currentUserMember?.role === 'owner' || currentUser?.is_admin === true;
  const isUpstreamAdmin = credential?.is_upstream_admin === true;

  // ── Local form state ───────────────────────────────────────────────
  // Form values sync from the wasteland query once, on first arrival.
  // `initialized` is a ref rather than state because flipping it during
  // render (via setState) would cause an extra render and trip React's
  // concurrent / strict-mode render-loop warnings. An effect runs after
  // commit and is the canonical place to mirror server data into a
  // controlled form's local state.
  const [name, setName] = useState('');
  const [dolthubUpstream, setDolthubUpstream] = useState('');
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!wasteland || initializedRef.current) return;
    setName(wasteland.name);
    setDolthubUpstream(wasteland.dolthub_upstream ?? '');
    initializedRef.current = true;
  }, [wasteland]);

  // ── Mutations ──────────────────────────────────────────────────────
  const wastelandQueryKey = trpc.wasteland.getWasteland.queryKey({ wastelandId });

  const updateConfig = useMutation({
    ...trpc.wasteland.updateWastelandConfig.mutationOptions(),
    onSuccess: () => {
      toast.success('Settings saved');
      void queryClient.invalidateQueries({ queryKey: wastelandQueryKey });
    },
    onError: err => toast.error(`Failed to save settings: ${err.message}`),
  });

  const deleteWasteland = useMutation({
    ...trpc.wasteland.deleteWasteland.mutationOptions(),
    onSuccess: () => {
      toast.success('Wasteland deleted');
      router.push('/wasteland');
    },
    onError: err => toast.error(`Failed to delete wasteland: ${err.message}`),
  });

  const deleteCredential = useMutation({
    ...trpc.wasteland.deleteCredential.mutationOptions(),
    onSuccess: () => {
      toast.success('DoltHub disconnected');
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getCredentialStatus.queryKey({ wastelandId }),
      });
    },
    onError: err => toast.error(`Failed to disconnect: ${err.message}`),
  });

  const setUpstreamAdmin = useMutation({
    ...trpc.wasteland.setUpstreamAdmin.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getCredentialStatus.queryKey({ wastelandId }),
      });
    },
    onError: err => toast.error(`Failed to update admin mode: ${err.message}`),
  });

  function handleSave() {
    updateConfig.mutate({
      wastelandId,
      name: name.trim() || undefined,
      dolthubUpstream: dolthubUpstream.trim() || undefined,
    });
  }

  // Active sections — filtered to match what's actually rendered so the nav
  // stays in sync with the body. Admin sections only appear for admins; the
  // danger zone only for owners.
  // Rig management lives on its own page (/wasteland/:id/rigs); settings is
  // just configuration.
  const showAdminSections = isUpstreamAdmin;
  const showDangerZone = isOwner;
  const navSections: SettingsNavItem[] = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'dolthub', label: 'DoltHub Connection', icon: Database },
    { id: 'connected-towns', label: 'Connected Towns', icon: Building2 },
    ...(showAdminSections
      ? [{ id: 'admin-verify', label: 'Admin Access', icon: ShieldCheck }]
      : []),
    ...(showDangerZone ? [{ id: 'danger-zone', label: 'Danger Zone', icon: Trash2 }] : []),
  ];

  // The route-segment layout (settings/layout.tsx) provides an
  // overflow-y-auto wrapper that scrolls at the container level. The
  // wasteland navbar now lives above the scroll viewport (outside the
  // scroll root), so we don't pass stickyHeaderId — sections land at the
  // top of the scroll viewport.
  const { activeId: activeSection, scrollTo: scrollToSection } = useScrollSpy(
    navSections.map(s => s.id),
    { scrollRootId: 'wasteland-settings-scroll-root' }
  );

  if (wastelandQuery.isLoading) {
    return (
      <div className="flex-1 p-6">
        <div className="space-y-6">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  // Contribute the Settings title + Save CTA into the wasteland navbar.
  // The Save button used to also mirror inside the scrollspy sidebar's
  // footer; now that the navbar is always visible, the mirror is
  // redundant and has been removed.
  useSetWastelandPageHeader({
    title: 'Settings',
    icon: <Settings className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: null,
    actions: isOwner ? (
      <Button
        onClick={handleSave}
        disabled={updateConfig.isPending}
        size="sm"
        className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
      >
        <Save className="size-3.5" />
        {updateConfig.isPending ? 'Saving...' : 'Save'}
      </Button>
    ) : null,
  });

  return (
    <div className="scroll-smooth">
      <div className="mx-auto flex max-w-4xl px-6">
        <div className="min-w-0 flex-1">
          <div className="space-y-8 pt-6" style={{ paddingBottom: '75vh' }}>
            {/* ── General Settings ──────────────────────────────────── */}
            <SettingsSection
              id="general"
              title="General"
              description="Basic wasteland configuration."
              icon={Settings}
              index={0}
            >
              <div className="space-y-4">
                <FieldGroup label="Wasteland Name">
                  <Input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    disabled={!isOwner}
                    placeholder="My Wasteland"
                    className="border-white/[0.08] bg-white/[0.03] text-sm text-white/85 placeholder:text-white/20"
                  />
                </FieldGroup>

                <FieldGroup label="DoltHub Upstream">
                  <Input
                    placeholder="e.g. username/repo"
                    value={dolthubUpstream}
                    onChange={e => setDolthubUpstream(e.target.value)}
                  />
                  <p className="text-[11px] text-white/30">
                    The DoltHub repository for this wasteland's bounty board.
                  </p>
                </FieldGroup>

                {/* Admin-mode toggle — self-attestation that the stored token has
                  push access on the upstream. Unlocks direct writes, PR merge
                  controls, and accept/reject in the wanted board. Only shown
                  once a credential has been stored. */}
                {credential && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isUpstreamAdmin}
                      disabled={setUpstreamAdmin.isPending || credentialQuery.isLoading}
                      onChange={e =>
                        setUpstreamAdmin.mutate({
                          wastelandId,
                          isUpstreamAdmin: e.target.checked,
                        })
                      }
                      className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-emerald-500"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white/70">I own this upstream (admin mode)</p>
                      <p className="mt-0.5 text-[11px] text-white/30">
                        Enables direct writes, PR merge controls, and the ability to accept
                        contributions. Requires a DoltHub token with push access to{' '}
                        {wasteland?.dolthub_upstream ? (
                          <span className="font-mono text-white/50">
                            {wasteland.dolthub_upstream}
                          </span>
                        ) : (
                          'the upstream'
                        )}
                        .
                      </p>
                    </div>
                  </label>
                )}
              </div>
            </SettingsSection>

            {/* ── DoltHub Connection ─────────────────────────────────── */}
            <SettingsSection
              id="dolthub"
              title="DoltHub Connection"
              description="Manage the connection to DoltHub for syncing data."
              icon={Database}
              index={1}
            >
              <div className="space-y-4">
                {/* Status indicator */}
                <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  {credential ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : (
                    <XCircle className="size-4 text-red-400" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-white/70">
                        {credential ? 'Connected' : 'Not connected'}
                      </p>
                      {isUpstreamAdmin && (
                        <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          Admin
                        </span>
                      )}
                    </div>
                    {credential && (
                      <div className="mt-1 space-y-0.5 text-[11px] text-white/40">
                        <p>
                          Organization:{' '}
                          <span className="font-mono text-white/60">{credential.dolthub_org}</span>
                        </p>
                        {credential.rig_handle && (
                          <p>
                            Rig handle:{' '}
                            <span className="font-mono text-white/60">{credential.rig_handle}</span>
                          </p>
                        )}
                        <p>Connected {formatTimestamp(credential.connected_at)}</p>
                      </div>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      credential
                        ? 'border-emerald-500/20 text-emerald-400'
                        : 'border-red-500/20 text-red-400'
                    }
                  >
                    {credential ? 'active' : 'inactive'}
                  </Badge>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <ConnectDoltHubDialog
                    wastelandId={wastelandId}
                    trpc={trpc}
                    queryClient={queryClient}
                    credentialQueryKey={trpc.wasteland.getCredentialStatus.queryKey({
                      wastelandId,
                    })}
                  />
                  {credential && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-red-500/20 text-red-400 hover:bg-red-500/10"
                        >
                          <Unlink className="size-3" />
                          Disconnect
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white/90">
                            Disconnect DoltHub?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-white/50">
                            This will remove your DoltHub credentials. You can reconnect later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteCredential.mutate({ wastelandId })}
                            className="bg-red-500/80 text-white hover:bg-red-500"
                          >
                            {deleteCredential.isPending ? 'Disconnecting...' : 'Disconnect'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            </SettingsSection>

            {/* ── Connected Towns ────────────────────────────────── */}
            <ConnectedTownsSection
              id="connected-towns"
              index={navSections.findIndex(s => s.id === 'connected-towns')}
              wastelandId={wastelandId}
              connectedTowns={connectedTownsQuery.data ?? []}
              isLoading={connectedTownsQuery.isLoading}
              isOwner={isOwner}
              trpc={trpc}
              gastownTrpc={gastownTrpc}
              queryClient={queryClient}
            />

            {/* ── Admin: verify access ──────────────────────────── */}
            {showAdminSections && (
              <AdminVerifySection
                id="admin-verify"
                index={navSections.findIndex(s => s.id === 'admin-verify')}
                wastelandId={wastelandId}
                trpc={trpc}
              />
            )}

            {/* ── Danger Zone ──────────────────────────────────────── */}
            {isOwner && (
              <SettingsSection
                id="danger-zone"
                title="Danger Zone"
                description="Irreversible actions for this wasteland."
                icon={Trash2}
                index={navSections.findIndex(s => s.id === 'danger-zone')}
              >
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-red-400">Delete Wasteland</p>
                      <p className="text-[11px] text-red-400/70">
                        Permanently delete this wasteland and all associated data. This cannot be
                        undone.
                      </p>
                      {isUpstreamAdmin && wasteland?.dolthub_upstream && (
                        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400/80">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          <span>
                            This does <strong>not</strong> delete the upstream DoltHub repository.
                            To fully decommission, also archive or delete{' '}
                            <span className="font-mono text-amber-300">
                              {wasteland.dolthub_upstream}
                            </span>{' '}
                            on DoltHub.
                          </span>
                        </p>
                      )}
                    </div>
                    <DeleteWastelandDialog
                      wastelandName={wasteland?.name ?? ''}
                      isPending={deleteWasteland.isPending}
                      onDelete={() => deleteWasteland.mutate({ wastelandId })}
                    />
                  </div>
                </div>
              </SettingsSection>
            )}
          </div>
        </div>

        <SettingsScrollspyNav
          items={navSections}
          activeId={activeSection}
          onNavigate={scrollToSection}
          layoutId="wasteland-settings-nav-indicator"
        />
      </div>
    </div>
  );
}

// ── Connect DoltHub Dialog ───────────────────────────────────────────────

/**
 * Lets a user wire a DoltHub credential into a wasteland. Two paths:
 *
 *  1. **Connect with DoltHub** (preferred). When the user has the DoltHub
 *     OAuth app installed, we forward the OAuth-issued access token
 *     into wasteland.storeCredential and only ask the user to confirm
 *     their DoltHub username (cached after first connect).
 *
 *  2. **Enter manually** (fallback, hidden under "Advanced"). Pastes a raw
 *     DoltHub API token + username — the same flow that existed before
 *     the OAuth integration shipped, kept around for users who can't or
 *     don't want to install the OAuth app.
 */
function ConnectDoltHubDialog({
  wastelandId,
  trpc,
  queryClient,
  credentialQueryKey,
}: {
  wastelandId: string;
  trpc: ReturnType<typeof useWastelandTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  credentialQueryKey: readonly unknown[];
}) {
  const mainTrpc = useTRPC();

  const [open, setOpen] = useState(false);
  const [oauthDolthubOrg, setOauthDolthubOrg] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualToken, setManualToken] = useState('');
  const [manualOrg, setManualOrg] = useState('');
  const [rigHandle, setRigHandle] = useState('');
  // One-shot guard so a slow username fetch never overwrites whatever the
  // user has typed. Reset to false in the close handler so the next open
  // re-prefills if the cache changed in the meantime.
  const prefilledRef = useRef(false);

  // Look up the OAuth installation + a usable access token. Only fetched
  // while the dialog is open so we don't pre-load a bearer token on every
  // settings render.
  const installationQuery = useQuery({
    ...mainTrpc.dolthub.getInstallation.queryOptions(undefined),
    enabled: open,
  });
  const credentialsQuery = useQuery({
    ...mainTrpc.dolthub.getInstallationCredentials.queryOptions(undefined),
    enabled: open && installationQuery.data?.installed === true,
  });

  // Pre-fill the org input from the cached username on first arrival only.
  useEffect(() => {
    if (prefilledRef.current) return;
    const cached = credentialsQuery.data?.dolthubUsername;
    if (cached) {
      setOauthDolthubOrg(cached);
      prefilledRef.current = true;
    }
  }, [credentialsQuery.data?.dolthubUsername]);

  const storeCredential = useMutation({
    ...trpc.wasteland.storeCredential.mutationOptions(),
    onSuccess: () => {
      toast.success('DoltHub connected');
      void queryClient.invalidateQueries({ queryKey: credentialQueryKey });
      setOpen(false);
      setOauthDolthubOrg('');
      setManualToken('');
      setManualOrg('');
      setRigHandle('');
      setManualOpen(false);
      prefilledRef.current = false;
    },
    onError: err => toast.error(`Failed to connect: ${err.message}`),
  });

  const rememberUsername = useMutation(mainTrpc.dolthub.rememberUsername.mutationOptions());

  const isInstalled = installationQuery.data?.installed === true;
  const oauthToken = credentialsQuery.data?.token;
  const oauthReady = isInstalled && Boolean(oauthToken);
  const oauthDisabled =
    !oauthReady ||
    storeCredential.isPending ||
    credentialsQuery.isLoading ||
    !oauthDolthubOrg.trim();
  const manualDisabled = !manualToken.trim() || !manualOrg.trim() || storeCredential.isPending;

  function handleOAuthConnect() {
    if (!oauthToken || !oauthDolthubOrg.trim()) return;
    const username = oauthDolthubOrg.trim();
    storeCredential.mutate(
      {
        wastelandId,
        dolthubToken: oauthToken,
        dolthubOrg: username,
        rigHandle: rigHandle.trim() || undefined,
      },
      {
        onSuccess: () => {
          // Cache the confirmed username so the next wasteland connect
          // skips the prompt. Failure here is non-fatal — the credential
          // is already stored.
          rememberUsername.mutate({ username });
        },
      }
    );
  }

  function handleManualConnect() {
    storeCredential.mutate({
      wastelandId,
      dolthubToken: manualToken,
      dolthubOrg: manualOrg,
      rigHandle: rigHandle.trim() || undefined,
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) prefilledRef.current = false;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5 bg-white/[0.06] text-white/70 hover:bg-white/[0.1] hover:text-white/90"
        >
          <Link2 className="size-3" />
          Connect DoltHub
        </Button>
      </DialogTrigger>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white/90">Connect DoltHub</DialogTitle>
          <DialogDescription className="text-white/50">
            Wire this wasteland to your DoltHub account so agents can browse and contribute.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* OAuth path (preferred) */}
          {installationQuery.isLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <Loader2 className="size-3.5 animate-spin text-white/30" />
              <span className="text-xs text-white/40">Checking DoltHub integration...</span>
            </div>
          ) : isInstalled ? (
            <div className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[color:oklch(95%_0.15_108_/_0.9)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white/85">Use your connected DoltHub account</p>
                  <p className="mt-0.5 text-[11px] text-white/40">
                    We&apos;ll forward your OAuth-issued token to this wasteland — no need to copy a
                    personal API token.
                  </p>
                </div>
              </div>

              <FieldGroup
                label="Your DoltHub username"
                hint="Used to identify your contributions. Cached after first connect."
              >
                <Input
                  name="dolthub-handle"
                  value={oauthDolthubOrg}
                  onChange={e => setOauthDolthubOrg(e.target.value)}
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

              <FieldGroup label="Rig handle" hint="Optional identifier for this connection.">
                <Input
                  name="rig-handle"
                  value={rigHandle}
                  onChange={e => setRigHandle(e.target.value)}
                  placeholder="my-rig"
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
              <p className="text-sm text-white/70">Connect with DoltHub for the smoothest setup</p>
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

          {/* Manual entry — under Advanced disclosure. Wrapped in a
              non-submitting `form` with autoComplete="off" plus
              non-credential `name` attributes so Chrome / 1Password /
              LastPass don't fingerprint it as a sign-in form. The
              token field uses SecretTokenInput which renders
              type="text" with visual masking instead of
              type="password". */}
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
                  hint="Generate at dolthub.com/settings/tokens"
                >
                  <SecretTokenInput
                    name="dolthub-api-token"
                    value={manualToken}
                    onChange={e => setManualToken(e.target.value)}
                    placeholder="Paste a personal API token"
                    toggleLabel="Show DoltHub token"
                    className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
                  />
                </FieldGroup>
                <FieldGroup label="DoltHub username" hint="Your DoltHub username or org">
                  <Input
                    name="dolthub-handle"
                    value={manualOrg}
                    onChange={e => setManualOrg(e.target.value)}
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-white/10 text-white/70 hover:bg-white/5"
          >
            Cancel
          </Button>
          {manualOpen ? (
            <Button
              variant="primary"
              onClick={handleManualConnect}
              disabled={manualDisabled}
              className="gap-1.5"
            >
              {storeCredential.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Connecting...
                </>
              ) : (
                'Connect with token'
              )}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleOAuthConnect}
              disabled={oauthDisabled}
              className="gap-1.5"
            >
              {storeCredential.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" />
                  Connect with DoltHub
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Wasteland Dialog ──────────────────────────────────────────────

function DeleteWastelandDialog({
  wastelandName,
  isPending,
  onDelete,
}: {
  wastelandName: string;
  isPending: boolean;
  onDelete: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmText === wastelandName;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          disabled={isPending}
          className="ml-4 shrink-0 gap-1.5"
        >
          <Trash2 className="size-3" />
          Delete Wasteland
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-red-500/20 bg-[oklch(0.13_0_0)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">Delete this wasteland?</AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">
            This action cannot be undone. Type{' '}
            <span className="font-mono font-semibold text-white/80">{wastelandName}</span> to
            confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          placeholder={wastelandName}
          className="border-red-500/20 bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/15"
        />
        <AlertDialogFooter>
          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onDelete}
            disabled={!confirmed || isPending}
            className="bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-40"
          >
            {isPending ? 'Deleting...' : 'Yes, delete wasteland'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Connected Towns Section ──────────────────────────────────────────────

type ConnectedTown = {
  town_id: string;
  wasteland_id: string;
  connected_by: string;
  connected_at: string;
};

function ConnectedTownsSection({
  id,
  index,
  wastelandId,
  connectedTowns,
  isLoading,
  isOwner,
  trpc,
  gastownTrpc,
  queryClient,
}: {
  id?: string;
  index?: number;
  wastelandId: string;
  connectedTowns: ConnectedTown[];
  isLoading: boolean;
  isOwner: boolean;
  trpc: ReturnType<typeof useWastelandTRPC>;
  gastownTrpc: ReturnType<typeof useGastownTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const connectedTownsQueryKey = trpc.wasteland.listConnectedTowns.queryKey({ wastelandId });
  const townsQuery = useQuery(gastownTrpc.gastown.listTowns.queryOptions());
  const townById = new Map((townsQuery.data ?? []).map(town => [town.id, town]));

  const disconnectTown = useMutation({
    ...trpc.wasteland.disconnectKiloTown.mutationOptions(),
    onSuccess: () => {
      toast.success('Town disconnected');
      void queryClient.invalidateQueries({ queryKey: connectedTownsQueryKey });
    },
    onError: err => toast.error(`Failed to disconnect: ${err.message}`),
  });

  return (
    <SettingsSection
      id={id}
      index={index}
      title="Your Connected Towns"
      description="Kilo towns you connected to this wasteland for automated operations. Other users' towns are private."
      icon={Building2}
    >
      <div className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : connectedTowns.length === 0 ? (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-center">
            <Building2 className="mx-auto mb-2 size-6 text-white/20" />
            <p className="text-sm text-white/40">You have no towns connected yet.</p>
            <p className="mt-1 text-[11px] text-white/25">
              Connect a Kilo town to enable one-click wasteland operations from your town&apos;s
              mayor.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {connectedTowns.map(town => {
              const townDetails = townById.get(town.town_id);
              const townName = townDetails?.name ?? town.town_id;
              return (
                <div
                  key={town.town_id}
                  className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <Building2 className="size-4 text-white/40" />
                    <div>
                      <Link
                        href={`/gastown/${town.town_id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-white/80 hover:text-white"
                      >
                        {townName}
                        <ArrowUpRight className="size-3" />
                      </Link>
                      {townDetails && (
                        <p className="font-mono text-[11px] text-white/25">{town.town_id}</p>
                      )}
                      <p className="text-[11px] text-white/30">
                        Connected {formatTimestamp(town.connected_at)}
                      </p>
                    </div>
                  </div>
                  {isOwner && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-red-500/20 text-red-400 hover:bg-red-500/10"
                        >
                          <Unlink className="size-3" />
                          Disconnect
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white/90">
                            Disconnect town?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-white/50">
                            The mayor in this town will no longer be able to perform wasteland
                            operations automatically.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              disconnectTown.mutate({
                                wastelandId,
                                townId: town.town_id,
                              })
                            }
                            className="bg-red-500/80 text-white hover:bg-red-500"
                          >
                            {disconnectTown.isPending ? 'Disconnecting...' : 'Disconnect'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <ConnectTownDialog
          wastelandId={wastelandId}
          connectedTownIds={new Set(connectedTowns.map(t => t.town_id))}
          trpc={trpc}
          gastownTrpc={gastownTrpc}
          queryClient={queryClient}
          connectedTownsQueryKey={connectedTownsQueryKey}
        />
      </div>
    </SettingsSection>
  );
}

// ── Connect Town Dialog ─────────────────────────────────────────────────

function ConnectTownDialog({
  wastelandId,
  connectedTownIds,
  trpc,
  gastownTrpc,
  queryClient,
  connectedTownsQueryKey,
}: {
  wastelandId: string;
  connectedTownIds: Set<string>;
  trpc: ReturnType<typeof useWastelandTRPC>;
  gastownTrpc: ReturnType<typeof useGastownTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  connectedTownsQueryKey: readonly unknown[];
}) {
  const [open, setOpen] = useState(false);

  // Fetch user's personal towns from Gastown when dialog opens
  const townsQuery = useQuery({
    ...gastownTrpc.gastown.listTowns.queryOptions(),
    enabled: open,
  });

  const connectTown = useMutation({
    ...trpc.wasteland.connectKiloTown.mutationOptions(),
    onSuccess: () => {
      toast.success('Town connected');
      void queryClient.invalidateQueries({ queryKey: connectedTownsQueryKey });
      setOpen(false);
    },
    onError: err => toast.error(`Failed to connect: ${err.message}`),
  });

  const towns = townsQuery.data ?? [];
  const availableTowns = towns.filter(t => !connectedTownIds.has(t.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5 bg-white/[0.06] text-white/70 hover:bg-white/[0.1] hover:text-white/90"
        >
          <Plus className="size-3" />
          Connect Town
        </Button>
      </DialogTrigger>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white/90">Connect a Town</DialogTitle>
          <DialogDescription className="text-white/50">
            Select a Kilo town to connect to this wasteland. The town&apos;s mayor will be able to
            browse and manage wanted items.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-64 space-y-2 overflow-y-auto py-2">
          {townsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-white/30" />
            </div>
          ) : availableTowns.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-white/40">
                {towns.length === 0
                  ? 'No towns found. Create a town in Gastown first.'
                  : 'All your towns are already connected.'}
              </p>
            </div>
          ) : (
            availableTowns.map(town => (
              <button
                key={town.id}
                onClick={() =>
                  connectTown.mutate({
                    wastelandId,
                    townId: town.id,
                  })
                }
                disabled={connectTown.isPending}
                className="flex w-full items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition hover:border-white/[0.12] hover:bg-white/[0.05] disabled:opacity-50"
              >
                <Building2 className="size-4 shrink-0 text-white/40" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white/80">{town.name}</p>
                  <p className="font-mono text-[11px] text-white/30">{town.id}</p>
                </div>
                {connectTown.isPending ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-white/30" />
                ) : (
                  <Link2 className="size-4 shrink-0 text-white/20" />
                )}
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            className="border-white/10 text-white/70 hover:bg-white/5"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Admin: verify upstream write access ─────────────────────────────────

function AdminVerifySection({
  id,
  index,
  wastelandId,
  trpc,
}: {
  id?: string;
  index?: number;
  wastelandId: string;
  trpc: ReturnType<typeof useWastelandTRPC>;
}) {
  const [lastResult, setLastResult] = useState<{
    hasWriteAccess: boolean;
    error: string | null;
  } | null>(null);
  const verifyMutation = useMutation({
    ...trpc.wasteland.verifyUpstreamAdmin.mutationOptions(),
    onSuccess: data => {
      setLastResult(data);
      if (data.hasWriteAccess) {
        toast.success('Admin access verified');
      } else {
        toast.error(data.error ?? 'Admin access check failed');
      }
    },
    onError: err => {
      setLastResult({ hasWriteAccess: false, error: err.message });
      toast.error(`Verification failed: ${err.message}`);
    },
  });

  return (
    <SettingsSection
      id={id}
      index={index}
      title="Admin Access"
      description="Confirm your DoltHub credential has push access to the upstream."
      icon={ShieldCheck}
    >
      <div className="space-y-3">
        {lastResult && (
          <div
            className={`rounded-lg border px-4 py-3 ${
              lastResult.hasWriteAccess
                ? 'border-emerald-500/20 bg-emerald-500/5'
                : 'border-red-500/20 bg-red-500/5'
            }`}
          >
            <div className="flex items-start gap-2">
              {lastResult.hasWriteAccess ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-red-400" />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${
                    lastResult.hasWriteAccess ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {lastResult.hasWriteAccess
                    ? 'Admin access verified'
                    : 'Admin access check failed'}
                </p>
                {lastResult.error && (
                  <p className="mt-1 font-mono text-[11px] break-all text-white/50">
                    {lastResult.error}
                  </p>
                )}
                {!lastResult.hasWriteAccess && (
                  <p className="mt-1 text-[11px] text-white/40">
                    Re-enter your DoltHub credential or uncheck "I own this upstream" to stop
                    attempting admin operations.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={verifyMutation.isPending}
          onClick={() => verifyMutation.mutate({ wastelandId })}
        >
          {verifyMutation.isPending ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <ShieldCheck className="size-3" />
              Test admin access
            </>
          )}
        </Button>
      </div>
    </SettingsSection>
  );
}

function formatTimestamp(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
