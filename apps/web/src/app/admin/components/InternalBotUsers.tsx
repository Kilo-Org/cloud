'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { INTERNAL_BOT_USER_ID_PREFIX } from '@/lib/bot-users/types';

export function InternalBotUsers() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listOptions = trpc.admin.internalBotUsers.list.queryOptions();
  const { data: bots, isLoading } = useQuery(listOptions);

  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationId, setOrganizationId] = useState('');

  const createMutation = useMutation(
    trpc.admin.internalBotUsers.create.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
        toast.success(result.created ? `Created ${result.id}` : `${result.id} already exists`);
        setSlug('');
        setDisplayName('');
      },
      onError: error => {
        toast.error(error.message || 'Failed to create internal bot user');
      },
    })
  );

  return (
    <div className="flex flex-col gap-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Create internal bot user</CardTitle>
          <CardDescription>
            Creates <code>{INTERNAL_BOT_USER_ID_PREFIX}&lt;slug&gt;</code> and adds it as a member
            of the organization. Re-running with the same values reuses the existing user and
            membership.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-4"
            onSubmit={event => {
              event.preventDefault();
              createMutation.mutate({
                slug: slug.trim(),
                displayName: displayName.trim(),
                organizationId: organizationId.trim(),
              });
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="internal-bot-slug">Slug</Label>
              <Input
                id="internal-bot-slug"
                value={slug}
                onChange={event => setSlug(event.target.value)}
                placeholder="bouncer-watch"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="internal-bot-name">Display name</Label>
              <Input
                id="internal-bot-name"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                placeholder="Bouncer Watch Bot"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="internal-bot-org">Organization id</Label>
              <Input
                id="internal-bot-org"
                value={organizationId}
                onChange={event => setOrganizationId(event.target.value)}
                required
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal bot users</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div>Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User id</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bots?.length ? (
                  bots.map(bot => (
                    <TableRow key={`${bot.id}:${bot.organizationId ?? ''}`}>
                      <TableCell className="font-mono">{bot.id}</TableCell>
                      <TableCell>{bot.name}</TableCell>
                      <TableCell className="font-mono">{bot.organizationId ?? '—'}</TableCell>
                      <TableCell>{bot.role ?? '—'}</TableCell>
                      <TableCell>
                        {bot.blockedAt || bot.blockedReason ? (
                          <Badge variant="destructive">Blocked</Badge>
                        ) : (
                          <Badge variant="secondary">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell>{new Date(bot.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>No internal bot users yet.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
