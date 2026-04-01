'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useUser } from '@/hooks/useUser';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
  Globe,
  Lock,
  CheckCircle2,
  XCircle,
  Building2,
  Plus,
  Loader2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type Props = { wastelandId: string };

export function SettingsClient({ wastelandId }: Props) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const router = useRouter();

  const gastownTrpc = useGastownTRPC();

  const wastelandQuery = useQuery(
    trpc.wasteland.getWasteland.queryOptions({ wastelandId })
  );
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const membersQuery = useQuery(
    trpc.wasteland.listMembers.queryOptions({ wastelandId })
  );
  const connectedTownsQuery = useQuery(
    trpc.wasteland.listConnectedTowns.queryOptions({ wastelandId })
  );

  const wasteland = wastelandQuery.data;
  const credential = credentialQuery.data;
  const members = membersQuery.data ?? [];
  const currentUserMember = members.find(m => m.user_id === currentUser?.id);
  const isOwner =
    currentUserMember?.role === 'owner' || currentUser?.is_admin === true;

  // ── Local form state ───────────────────────────────────────────────
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [initialized, setInitialized] = useState(false);

  if (wasteland && !initialized) {
    setName(wasteland.name);
    setVisibility(wasteland.visibility);
    setInitialized(true);
  }

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

  function handleSave() {
    updateConfig.mutate({
      wastelandId,
      name: name.trim() || undefined,
      visibility,
    });
  }

  if (wastelandQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-white/[0.06] px-6 py-3">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 p-6">
          <div className="space-y-6">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2.5">
          <Settings className="size-4 text-white/40" />
          <h2 className="text-lg font-semibold tracking-tight text-white/90">
            Settings
          </h2>
        </div>
        {isOwner && (
          <Button
            onClick={handleSave}
            disabled={updateConfig.isPending}
            size="sm"
            className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
          >
            <Save className="size-3.5" />
            {updateConfig.isPending ? 'Saving...' : 'Save'}
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          {/* ── General Settings ──────────────────────────────────── */}
          <SettingsSection
            title="General"
            description="Basic wasteland configuration."
            icon={Settings}
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

              <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <Switch
                  checked={visibility === 'public'}
                  onCheckedChange={checked =>
                    setVisibility(checked ? 'public' : 'private')
                  }
                  disabled={!isOwner}
                />
                <div>
                  <Label className="flex items-center gap-1.5 text-sm text-white/70">
                    {visibility === 'public' ? (
                      <Globe className="size-3.5" />
                    ) : (
                      <Lock className="size-3.5" />
                    )}
                    {visibility === 'public' ? 'Public' : 'Private'}
                  </Label>
                  <p className="text-[11px] text-white/30">
                    {visibility === 'public'
                      ? 'Anyone can view this wasteland.'
                      : 'Only members can access this wasteland.'}
                  </p>
                </div>
              </div>

              {wasteland?.dolthub_upstream && (
                <FieldGroup label="DoltHub Upstream">
                  <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <Database className="size-3.5 text-white/30" />
                    <span className="font-mono text-xs text-white/60">
                      {wasteland.dolthub_upstream}
                    </span>
                    <Badge
                      variant="outline"
                      className="ml-auto text-[9px] text-white/30"
                    >
                      read-only
                    </Badge>
                  </div>
                </FieldGroup>
              )}
            </div>
          </SettingsSection>

          {/* ── DoltHub Connection ─────────────────────────────────── */}
          <SettingsSection
            title="DoltHub Connection"
            description="Manage the connection to DoltHub for syncing data."
            icon={Database}
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
                  <p className="text-sm text-white/70">
                    {credential ? 'Connected' : 'Not connected'}
                  </p>
                  {credential && (
                    <div className="mt-1 space-y-0.5 text-[11px] text-white/40">
                      <p>
                        Organization:{' '}
                        <span className="font-mono text-white/60">
                          {credential.dolthub_org}
                        </span>
                      </p>
                      {credential.rig_handle && (
                        <p>
                          Rig handle:{' '}
                          <span className="font-mono text-white/60">
                            {credential.rig_handle}
                          </span>
                        </p>
                      )}
                      <p>
                        Connected{' '}
                        {formatTimestamp(credential.connected_at)}
                      </p>
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
                  credentialQueryKey={trpc.wasteland.getCredentialStatus.queryKey(
                    { wastelandId }
                  )}
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
                          This will remove your DoltHub credentials. You can
                          reconnect later.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            deleteCredential.mutate({ wastelandId })
                          }
                          className="bg-red-500/80 text-white hover:bg-red-500"
                        >
                          {deleteCredential.isPending
                            ? 'Disconnecting...'
                            : 'Disconnect'}
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
            wastelandId={wastelandId}
            connectedTowns={connectedTownsQuery.data ?? []}
            isLoading={connectedTownsQuery.isLoading}
            isOwner={isOwner}
            trpc={trpc}
            gastownTrpc={gastownTrpc}
            queryClient={queryClient}
          />

          {/* ── Danger Zone ──────────────────────────────────────── */}
          {isOwner && (
            <SettingsSection
              title="Danger Zone"
              description="Irreversible actions for this wasteland."
              icon={Trash2}
            >
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-red-400">Delete Wasteland</p>
                    <p className="text-[11px] text-red-400/70">
                      Permanently delete this wasteland and all associated data.
                      This cannot be undone.
                    </p>
                  </div>
                  <DeleteWastelandDialog
                    wastelandName={wasteland?.name ?? ''}
                    isPending={deleteWasteland.isPending}
                    onDelete={() =>
                      deleteWasteland.mutate({ wastelandId })
                    }
                  />
                </div>
              </div>
            </SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Connect DoltHub Dialog ───────────────────────────────────────────────

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
  const [open, setOpen] = useState(false);
  const [dolthubToken, setDolthubToken] = useState('');
  const [dolthubOrg, setDolthubOrg] = useState('');
  const [rigHandle, setRigHandle] = useState('');

  const storeCredential = useMutation({
    ...trpc.wasteland.storeCredential.mutationOptions(),
    onSuccess: () => {
      toast.success('DoltHub connected');
      void queryClient.invalidateQueries({ queryKey: credentialQueryKey });
      setOpen(false);
      setDolthubToken('');
      setDolthubOrg('');
      setRigHandle('');
    },
    onError: err => toast.error(`Failed to connect: ${err.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            Enter your DoltHub credentials to enable data syncing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <FieldGroup label="DoltHub API Token">
            <Input
              type="password"
              value={dolthubToken}
              onChange={e => setDolthubToken(e.target.value)}
              placeholder="Enter your DoltHub API token"
              className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
            />
          </FieldGroup>

          <FieldGroup label="DoltHub Organization">
            <Input
              value={dolthubOrg}
              onChange={e => setDolthubOrg(e.target.value)}
              placeholder="my-org"
              className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
            />
          </FieldGroup>

          <FieldGroup label="Rig Handle" hint="Optional identifier for this connection.">
            <Input
              value={rigHandle}
              onChange={e => setRigHandle(e.target.value)}
              placeholder="my-rig"
              className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
            />
          </FieldGroup>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            className="border-white/10 text-white/70 hover:bg-white/5"
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              storeCredential.mutate({
                wastelandId,
                dolthubToken,
                dolthubOrg,
                rigHandle: rigHandle || undefined,
              })
            }
            disabled={
              !dolthubToken.trim() ||
              !dolthubOrg.trim() ||
              storeCredential.isPending
            }
            className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
          >
            {storeCredential.isPending ? 'Connecting...' : 'Connect'}
          </Button>
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
          <AlertDialogTitle className="text-red-400">
            Delete this wasteland?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">
            This action cannot be undone. Type{' '}
            <span className="font-mono font-semibold text-white/80">
              {wastelandName}
            </span>{' '}
            to confirm.
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
  wastelandId,
  connectedTowns,
  isLoading,
  isOwner,
  trpc,
  gastownTrpc,
  queryClient,
}: {
  wastelandId: string;
  connectedTowns: ConnectedTown[];
  isLoading: boolean;
  isOwner: boolean;
  trpc: ReturnType<typeof useWastelandTRPC>;
  gastownTrpc: ReturnType<typeof useGastownTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const connectedTownsQueryKey = trpc.wasteland.listConnectedTowns.queryKey({ wastelandId });

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
      title="Connected Towns"
      description="Kilo towns connected to this wasteland for automated operations."
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
            <p className="text-sm text-white/40">No towns connected yet.</p>
            <p className="mt-1 text-[11px] text-white/25">
              Connect a Kilo town to enable one-click wasteland operations from
              your town&apos;s mayor.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {connectedTowns.map(town => (
              <div
                key={town.town_id}
                className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <Building2 className="size-4 text-white/40" />
                  <div>
                    <p className="font-mono text-sm text-white/70">
                      {town.town_id}
                    </p>
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
                          The mayor in this town will no longer be able to
                          perform wasteland operations automatically.
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
                          {disconnectTown.isPending
                            ? 'Disconnecting...'
                            : 'Disconnect'}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
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
            Select a Kilo town to connect to this wasteland. The town&apos;s
            mayor will be able to browse and manage wanted items.
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
                  <p className="truncate text-sm text-white/80">
                    {town.name}
                  </p>
                  <p className="font-mono text-[11px] text-white/30">
                    {town.id}
                  </p>
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

// ── Shared Components ────────────────────────────────────────────────────

function SettingsSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Settings;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 flex size-8 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-white/[0.06]">
          <Icon className="size-4 text-white/40" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/85">{title}</h3>
          <p className="mt-0.5 text-xs text-white/35">{description}</p>
        </div>
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        {children}
      </div>
    </section>
  );
}

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

function formatTimestamp(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
