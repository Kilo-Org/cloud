'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function TemporarilyBlockedModelAccessContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, error, isError, isLoading } = useQuery(
    trpc.admin.temporarilyBlockedModelAccess.get.queryOptions()
  );
  const [organizationIdsText, setOrganizationIdsText] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (!data) return;
    setOrganizationIdsText(data.organization_ids.join('\n'));
    setHasChanges(false);
  }, [data]);

  const organizationIds = [
    ...new Set(
      organizationIdsText
        .split(/[\n,]/)
        .map(id => id.trim())
        .filter(Boolean)
    ),
  ];

  const mutation = useMutation(
    trpc.admin.temporarilyBlockedModelAccess.set.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.temporarilyBlockedModelAccess.get.queryKey(),
        });
        toast.success('Temporary model access updated');
      },
      onError: mutationError => {
        toast.error(mutationError.message || 'Failed to update temporary model access');
      },
    })
  );

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  if (isError || !data) {
    return (
      <div className="text-destructive py-8 text-sm">
        {error?.message || 'Temporary model access could not be loaded.'}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Temporary Opus and Fable Access</CardTitle>
        <CardDescription>
          Allow selected organizations to request temporarily blocked Opus 5 and Fable models
          directly. Auto-routing is not affected by this setting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex max-w-2xl flex-col gap-4"
          onSubmit={event => {
            event.preventDefault();
            mutation.mutate({ organization_ids: organizationIds });
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="temporarily-blocked-model-organization-ids">Organization IDs</Label>
            <Textarea
              id="temporarily-blocked-model-organization-ids"
              aria-describedby="temporarily-blocked-model-organization-ids-description"
              value={organizationIdsText}
              onChange={event => {
                setOrganizationIdsText(event.target.value);
                setHasChanges(true);
              }}
              disabled={mutation.isPending}
              placeholder="One organization ID per line, or comma-separated"
              rows={10}
              className="font-mono text-sm"
            />
            <p
              id="temporarily-blocked-model-organization-ids-description"
              className="text-muted-foreground text-sm"
            >
              {organizationIds.length} organization{organizationIds.length === 1 ? '' : 's'} will
              bypass the direct-request block. The allowlist is stored in Redis.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={mutation.isPending || !hasChanges}>
              {mutation.isPending ? 'Saving...' : 'Save access exceptions'}
            </Button>
            {data.updated_by_email && (
              <span className="text-muted-foreground text-sm">
                Last updated by {data.updated_by_email}
                {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
