'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Users, Plus, Trash2, Pencil, Star } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';

type WastelandMember = WastelandOutputs['wasteland']['listMembers'][number];

const ROLE_STYLES: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  maintainer: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  contributor: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
};

function TrustStars({ level }: { level: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <Star
          key={i}
          className={`size-3 ${i < level ? 'fill-amber-400 text-amber-400' : 'text-white/15'}`}
        />
      ))}
    </span>
  );
}

export function MembersClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();

  const membersQuery = useQuery(trpc.wasteland.listMembers.queryOptions({ wastelandId }));
  const members = membersQuery.data ?? [];

  const currentUserMember = members.find(m => m.user_id === currentUser?.id);
  const isOwnerOrAdmin = currentUserMember?.role === 'owner' || currentUser?.is_admin === true;

  const memberQueryKey = trpc.wasteland.listMembers.queryKey({ wastelandId });

  useSetWastelandPageHeader({
    title: 'Members',
    icon: <Users className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: members.length,
    actions: isOwnerOrAdmin ? (
      <AddMemberDialog
        wastelandId={wastelandId}
        trpc={trpc}
        queryClient={queryClient}
        memberQueryKey={memberQueryKey}
      />
    ) : null,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {membersQuery.isLoading && <MembersTableSkeleton />}

        {!membersQuery.isLoading && members.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">No members yet.</p>
          </div>
        )}

        {!membersQuery.isLoading && members.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="border-white/[0.06] hover:bg-transparent">
                <TableHead className="text-white/40">User</TableHead>
                <TableHead className="text-white/40">Role</TableHead>
                <TableHead className="text-white/40">Trust</TableHead>
                <TableHead className="text-white/40">Joined</TableHead>
                {isOwnerOrAdmin && (
                  <TableHead className="w-24 text-right text-white/40">Actions</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map(member => (
                <MemberRow
                  key={member.member_id}
                  member={member}
                  wastelandId={wastelandId}
                  isOwnerOrAdmin={isOwnerOrAdmin}
                  isSelf={member.user_id === currentUser?.id}
                  trpc={trpc}
                  queryClient={queryClient}
                  memberQueryKey={memberQueryKey}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// ── Member Row ───────────────────────────────────────────────────────────

function MemberRow({
  member,
  wastelandId,
  isOwnerOrAdmin,
  isSelf,
  trpc,
  queryClient,
  memberQueryKey,
}: {
  member: WastelandMember;
  wastelandId: string;
  isOwnerOrAdmin: boolean;
  isSelf: boolean;
  trpc: ReturnType<typeof useWastelandTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  memberQueryKey: readonly unknown[];
}) {
  return (
    <TableRow className="border-white/[0.04] hover:bg-white/[0.02]">
      <TableCell>
        <span className="font-mono text-xs text-white/70">{member.user_id}</span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={ROLE_STYLES[member.role] ?? 'text-white/50'}>
          {member.role}
        </Badge>
      </TableCell>
      <TableCell>
        <TrustStars level={member.trust_level} />
      </TableCell>
      <TableCell>
        <span className="text-xs text-white/40">{formatTimestamp(member.joined_at)}</span>
      </TableCell>
      {isOwnerOrAdmin && (
        <TableCell className="text-right">
          <div className="inline-flex items-center gap-1">
            <EditMemberDialog
              member={member}
              wastelandId={wastelandId}
              trpc={trpc}
              queryClient={queryClient}
              memberQueryKey={memberQueryKey}
            />
            {!isSelf && (
              <RemoveMemberDialog
                member={member}
                wastelandId={wastelandId}
                trpc={trpc}
                queryClient={queryClient}
                memberQueryKey={memberQueryKey}
              />
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

// ── Add Member Dialog ────────────────────────────────────────────────────

function AddMemberDialog({
  wastelandId,
  trpc,
  queryClient,
  memberQueryKey,
}: {
  wastelandId: string;
  trpc: ReturnType<typeof useWastelandTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  memberQueryKey: readonly unknown[];
}) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'contributor' | 'maintainer' | 'owner'>('contributor');
  const [trustLevel, setTrustLevel] = useState('1');

  const addMember = useMutation({
    ...trpc.wasteland.addMember.mutationOptions(),
    onSuccess: () => {
      toast.success('Member added');
      void queryClient.invalidateQueries({ queryKey: memberQueryKey });
      setOpen(false);
      setUserId('');
      setRole('contributor');
      setTrustLevel('1');
    },
    onError: err => toast.error(`Failed to add member: ${err.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="gap-1.5 bg-white/[0.06] text-white/70 hover:bg-white/[0.1] hover:text-white/90"
        >
          <Plus className="size-3" />
          Add Member
        </Button>
      </DialogTrigger>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white/90">Add Member</DialogTitle>
          <DialogDescription className="text-white/50">
            Add a user by their ID. They will gain access to this wasteland.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-white/55">User ID</Label>
            <Input
              value={userId}
              onChange={e => setUserId(e.target.value)}
              placeholder="Enter user ID"
              className="border-white/[0.08] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-white/55">Role</Label>
            <Select
              value={role}
              onValueChange={v => setRole(v as 'contributor' | 'maintainer' | 'owner')}
            >
              <SelectTrigger className="border-white/[0.08] bg-white/[0.03] text-white/85">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/[0.08] bg-[oklch(0.15_0_0)]">
                <SelectItem value="contributor">Contributor</SelectItem>
                <SelectItem value="maintainer">Maintainer</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-white/55">Trust Level</Label>
            <Select value={trustLevel} onValueChange={setTrustLevel}>
              <SelectTrigger className="border-white/[0.08] bg-white/[0.03] text-white/85">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/[0.08] bg-[oklch(0.15_0_0)]">
                <SelectItem value="1">
                  <span className="flex items-center gap-2">
                    <TrustStars level={1} /> Level 1
                  </span>
                </SelectItem>
                <SelectItem value="2">
                  <span className="flex items-center gap-2">
                    <TrustStars level={2} /> Level 2
                  </span>
                </SelectItem>
                <SelectItem value="3">
                  <span className="flex items-center gap-2">
                    <TrustStars level={3} /> Level 3
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
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
              addMember.mutate({
                wastelandId,
                userId,
                role,
                trustLevel: Number(trustLevel),
              })
            }
            disabled={!userId.trim() || addMember.isPending}
            className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
          >
            {addMember.isPending ? 'Adding...' : 'Add Member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Member Dialog ───────────────────────────────────────────────────

function EditMemberDialog({
  member,
  wastelandId,
  trpc,
  queryClient,
  memberQueryKey,
}: {
  member: WastelandMember;
  wastelandId: string;
  trpc: ReturnType<typeof useWastelandTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  memberQueryKey: readonly unknown[];
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(member.role);
  const [trustLevel, setTrustLevel] = useState(String(member.trust_level));

  const updateMember = useMutation({
    ...trpc.wasteland.updateMember.mutationOptions(),
    onSuccess: () => {
      toast.success('Member updated');
      void queryClient.invalidateQueries({ queryKey: memberQueryKey });
      setOpen(false);
    },
    onError: err => toast.error(`Failed to update member: ${err.message}`),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={isOpen => {
        setOpen(isOpen);
        if (isOpen) {
          setRole(member.role);
          setTrustLevel(String(member.trust_level));
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-white/30 hover:bg-white/[0.06] hover:text-white/60"
        >
          <Pencil className="size-3" />
        </Button>
      </DialogTrigger>
      <DialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white/90">Edit Member</DialogTitle>
          <DialogDescription className="text-white/50">
            Update role and trust level for{' '}
            <span className="font-mono text-white/70">{member.user_id}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-white/55">Role</Label>
            <Select
              value={role}
              onValueChange={v => setRole(v as 'contributor' | 'maintainer' | 'owner')}
            >
              <SelectTrigger className="border-white/[0.08] bg-white/[0.03] text-white/85">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/[0.08] bg-[oklch(0.15_0_0)]">
                <SelectItem value="contributor">Contributor</SelectItem>
                <SelectItem value="maintainer">Maintainer</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-white/55">Trust Level</Label>
            <Select value={trustLevel} onValueChange={setTrustLevel}>
              <SelectTrigger className="border-white/[0.08] bg-white/[0.03] text-white/85">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/[0.08] bg-[oklch(0.15_0_0)]">
                <SelectItem value="1">
                  <span className="flex items-center gap-2">
                    <TrustStars level={1} /> Level 1
                  </span>
                </SelectItem>
                <SelectItem value="2">
                  <span className="flex items-center gap-2">
                    <TrustStars level={2} /> Level 2
                  </span>
                </SelectItem>
                <SelectItem value="3">
                  <span className="flex items-center gap-2">
                    <TrustStars level={3} /> Level 3
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
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
              updateMember.mutate({
                wastelandId,
                memberId: member.member_id,
                role,
                trustLevel: Number(trustLevel),
              })
            }
            disabled={updateMember.isPending}
            className="bg-white/[0.1] text-white/90 hover:bg-white/[0.15]"
          >
            {updateMember.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Remove Member Dialog ─────────────────────────────────────────────────

function RemoveMemberDialog({
  member,
  wastelandId,
  trpc,
  queryClient,
  memberQueryKey,
}: {
  member: WastelandMember;
  wastelandId: string;
  trpc: ReturnType<typeof useWastelandTRPC>;
  queryClient: ReturnType<typeof useQueryClient>;
  memberQueryKey: readonly unknown[];
}) {
  const removeMember = useMutation({
    ...trpc.wasteland.removeMember.mutationOptions(),
    onSuccess: () => {
      toast.success('Member removed');
      void queryClient.invalidateQueries({ queryKey: memberQueryKey });
    },
    onError: err => toast.error(`Failed to remove member: ${err.message}`),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-white/30 hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 className="size-3" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-white/[0.08] bg-[oklch(0.13_0_0)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-white/90">Remove member?</AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">
            This will remove <span className="font-mono text-white/70">{member.user_id}</span> from
            this wasteland. They will lose all access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              removeMember.mutate({
                wastelandId,
                memberId: member.member_id,
              })
            }
            className="bg-red-500/80 text-white hover:bg-red-500"
          >
            {removeMember.isPending ? 'Removing...' : 'Remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function MembersTableSkeleton() {
  return (
    <div className="space-y-0 px-6">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-6 border-b border-white/[0.04] py-3"
        >
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
