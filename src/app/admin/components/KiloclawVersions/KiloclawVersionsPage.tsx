'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Loader2, AlertTriangle, ChevronsUpDown, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'available':
      return <Badge className="bg-green-600">Available</Badge>;
    case 'disabled':
      return <Badge variant="destructive">Disabled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function VersionsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'available' | 'disabled'>('all');
  const limit = 25;

  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({
      offset: page * limit,
      limit,
      status: statusFilter === 'all' ? undefined : statusFilter,
    })
  );

  const { mutateAsync: updateStatus } = useMutation(
    trpc.admin.kiloclawVersions.updateVersionStatus.mutationOptions({
      onSuccess: () => {
        toast.success('Version status updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawVersions.listVersions.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to update status: ${err.message}`);
      },
    })
  );

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v: string) => {
            if (v === 'all' || v === 'available' || v === 'disabled') {
              setStatusFilter(v);
              setPage(0);
            }
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>OpenClaw Version</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Image Tag</TableHead>
              <TableHead>Digest</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground text-center">
                  No versions found
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map(version => (
                <TableRow key={version.id}>
                  <TableCell className="font-medium">{version.openclaw_version}</TableCell>
                  <TableCell>{version.variant}</TableCell>
                  <TableCell>
                    <code className="text-xs">
                      {version.image_tag.length > 20
                        ? `${version.image_tag.slice(0, 20)}…`
                        : version.image_tag}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs" title={version.image_digest ?? undefined}>
                      {version.image_digest ? `${version.image_digest.slice(0, 19)}` : '—'}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={version.status} />
                  </TableCell>
                  <TableCell>
                    <span title={new Date(version.published_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(version.published_at), { addSuffix: true })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={version.status}
                      onValueChange={newStatus => {
                        if (newStatus === 'available' || newStatus === 'disabled') {
                          void updateStatus({ imageTag: version.image_tag, status: newStatus });
                        }
                      }}
                    >
                      <SelectTrigger className="w-[130px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page + 1} of {data.pagination.totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page + 1 >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PinsTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const limit = 25;

  // Add pin form state
  const [userSearch, setUserSearch] = useState('');
  const [userComboboxOpen, setUserComboboxOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserEmail, setSelectedUserEmail] = useState<string | null>(null);
  const [pinImageTag, setPinImageTag] = useState('');
  const [pinReason, setPinReason] = useState('');

  const { data: userResults } = useQuery({
    ...trpc.admin.kiloclawVersions.searchUsers.queryOptions({ query: userSearch }),
    enabled: userSearch.length >= 2 && !selectedUserId,
  });

  const { data: availableVersions } = useQuery(
    trpc.admin.kiloclawVersions.listVersions.queryOptions({ status: 'available', limit: 100 })
  );

  const { data, isLoading } = useQuery(
    trpc.admin.kiloclawVersions.listPins.queryOptions({
      offset: page * limit,
      limit,
    })
  );

  const invalidatePinQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.listPins.queryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: trpc.admin.kiloclawVersions.getUserPin.queryKey(),
    });
  };

  const { mutateAsync: setPin, isPending: isPinning } = useMutation(
    trpc.admin.kiloclawVersions.setPin.mutationOptions({
      onSuccess: () => {
        toast.success('Pin created');
        invalidatePinQueries();
        setSelectedUserId(null);
        setSelectedUserEmail(null);
        setUserSearch('');
        setPinImageTag('');
        setPinReason('');
      },
      onError: err => {
        toast.error(`Failed to create pin: ${err.message}`);
      },
    })
  );

  const { mutateAsync: removePin, isPending: isRemoving } = useMutation(
    trpc.admin.kiloclawVersions.removePin.mutationOptions({
      onSuccess: () => {
        toast.success('Pin removed');
        invalidatePinQueries();
        setRemovingUserId(null);
      },
      onError: err => {
        toast.error(`Failed to remove pin: ${err.message}`);
      },
    })
  );

  return (
    <div className="flex flex-col gap-y-4">
      {/* Add Pin form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Pin</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="text-muted-foreground mb-1 block text-xs">User</label>
              {selectedUserId ? (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-sm">
                    {selectedUserEmail ?? selectedUserId}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => {
                      setSelectedUserId(null);
                      setSelectedUserEmail(null);
                      setUserSearch('');
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <Popover open={userComboboxOpen} onOpenChange={setUserComboboxOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={userComboboxOpen}
                      className="w-full justify-between font-normal"
                    >
                      <span className="text-muted-foreground">Search by email or user ID...</span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search by email or user ID..."
                        value={userSearch}
                        onValueChange={setUserSearch}
                      />
                      <CommandList>
                        {userSearch.length < 2 && (
                          <CommandEmpty>Type at least 2 characters to search...</CommandEmpty>
                        )}
                        {userSearch.length >= 2 && !userResults?.length && (
                          <CommandEmpty>No users found</CommandEmpty>
                        )}
                        {userResults && userResults.length > 0 && (
                          <CommandGroup>
                            {userResults.map(user => (
                              <CommandItem
                                key={user.id}
                                value={user.id}
                                onSelect={() => {
                                  setSelectedUserId(user.id);
                                  setSelectedUserEmail(user.email);
                                  setUserSearch('');
                                  setUserComboboxOpen(false);
                                }}
                              >
                                <span className="font-medium">{user.email}</span>
                                {user.name && (
                                  <span className="text-muted-foreground ml-2">{user.name}</span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="w-[250px]">
              <label className="text-muted-foreground mb-1 block text-xs">OpenClaw Version</label>
              <Select value={pinImageTag} onValueChange={setPinImageTag}>
                <SelectTrigger>
                  <SelectValue placeholder="Select OpenClaw version..." />
                </SelectTrigger>
                <SelectContent>
                  {availableVersions?.items.map(v => (
                    <SelectItem key={v.image_tag} value={v.image_tag}>
                      {v.openclaw_version} ({v.variant})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[200px]">
              <label className="text-muted-foreground mb-1 block text-xs">Reason</label>
              <Input
                placeholder="Why pin this user?"
                value={pinReason}
                onChange={e => setPinReason(e.target.value)}
              />
            </div>
            <Button
              onClick={() =>
                selectedUserId &&
                pinImageTag &&
                void setPin({
                  userId: selectedUserId,
                  imageTag: pinImageTag,
                  reason: pinReason || undefined,
                })
              }
              disabled={!selectedUserId || !pinImageTag || isPinning}
            >
              {isPinning ? 'Pinning...' : 'Pin User'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Image Tag</TableHead>
              <TableHead>OpenClaw Version</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Pinned By</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground text-center">
                  No active pins
                </TableCell>
              </TableRow>
            ) : (
              data?.items.map(pin => (
                <TableRow key={pin.id}>
                  <TableCell className="font-medium">{pin.user_email ?? pin.user_id}</TableCell>
                  <TableCell>
                    <code className="text-xs">{pin.image_tag}</code>
                  </TableCell>
                  <TableCell>{pin.openclaw_version ?? '—'}</TableCell>
                  <TableCell>{pin.variant ?? '—'}</TableCell>
                  <TableCell>{pin.pinned_by_email ?? pin.pinned_by}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm">
                    {pin.reason ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span title={new Date(pin.created_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(pin.created_at), { addSuffix: true })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setRemovingUserId(pin.user_id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page + 1} of {data.pagination.totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => p + 1)}
              disabled={page + 1 >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Remove Pin Confirmation Dialog */}
      <Dialog
        open={removingUserId !== null}
        onOpenChange={open => !open && setRemovingUserId(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Remove Version Pin
            </DialogTitle>
            <DialogDescription className="pt-3">
              Are you sure you want to remove this version pin? The user will follow the latest
              available version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="secondary" disabled={isRemoving}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => removingUserId && void removePin({ userId: removingUserId })}
              disabled={isRemoving}
            >
              {isRemoving ? 'Removing...' : 'Remove Pin'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
