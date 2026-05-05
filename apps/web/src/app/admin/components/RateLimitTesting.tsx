'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

export function RateLimitTesting() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const usageQuery = useQuery(trpc.admin.freeModelUsage.getMyUsage.queryOptions());

  const rateLimitMutation = useMutation(
    trpc.admin.freeModelUsage.rateLimitMe.mutationOptions({
      onSuccess: data => {
        if (data.alreadyRateLimited) {
          toast.message('Already rate limited', {
            description: `User ${data.kiloUserId} already has ${data.newTotal} requests in the current window.`,
          });
        } else {
          toast.success(
            `Inserted ${data.rowsInserted} rows for user ${data.kiloUserId}. New total: ${data.newTotal}.`
          );
        }
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.freeModelUsage.getMyUsage.queryKey(),
        });
      },
      onError: error => {
        toast.error(error.message || 'Failed to rate limit user');
      },
    })
  );

  const data = usageQuery.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate Limit Testing</CardTitle>
        <CardDescription>
          Insert enough requests to trigger the free model rate limit for your own user id.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {usageQuery.isLoading && <p className="text-muted-foreground text-sm">Loading usage...</p>}

        {usageQuery.error && (
          <p className="text-sm text-red-500">
            {usageQuery.error.message || 'Failed to load usage'}
          </p>
        )}

        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground text-sm">Your user id</p>
                <p className="font-mono text-sm font-medium">{data.kiloUserId}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-sm">Usage ({data.windowHours}h window)</p>
                <p className="text-sm font-medium">
                  {data.currentUsage} / {data.limit}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-sm">Status</p>
                {data.isRateLimited ? (
                  <Badge variant="destructive">Rate Limited</Badge>
                ) : (
                  <Badge variant="secondary">Not Limited</Badge>
                )}
              </div>
            </div>

            <Button
              onClick={() => rateLimitMutation.mutate()}
              disabled={rateLimitMutation.isPending || data.isRateLimited}
              variant={data.isRateLimited ? 'outline' : 'default'}
            >
              {rateLimitMutation.isPending
                ? 'Inserting rows...'
                : data.isRateLimited
                  ? 'Already Rate Limited'
                  : `Rate Limit Me (insert ${data.limit - data.currentUsage} rows)`}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
