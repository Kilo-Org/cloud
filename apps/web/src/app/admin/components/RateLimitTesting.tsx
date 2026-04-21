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

  const ipUsageQuery = useQuery(trpc.admin.freeModelUsage.getMyIpUsage.queryOptions());

  const rateLimitMutation = useMutation(
    trpc.admin.freeModelUsage.rateLimitMyIp.mutationOptions({
      onSuccess: data => {
        if (data.alreadyRateLimited) {
          toast.message('Already rate limited', {
            description: `IP ${data.ipAddress} already has ${data.newTotal} requests in the current window.`,
          });
        } else {
          toast.success(
            `Inserted ${data.rowsInserted} rows for IP ${data.ipAddress}. New total: ${data.newTotal}.`
          );
        }
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.freeModelUsage.getMyIpUsage.queryKey(),
        });
      },
      onError: error => {
        toast.error(error.message || 'Failed to rate limit IP');
      },
    })
  );

  const data = ipUsageQuery.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate Limit Testing</CardTitle>
        <CardDescription>
          Insert enough requests to trigger the free model rate limit for your current IP address.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {ipUsageQuery.isLoading && (
          <p className="text-muted-foreground text-sm">Loading IP usage...</p>
        )}

        {ipUsageQuery.error && (
          <p className="text-sm text-red-500">
            {ipUsageQuery.error.message || 'Failed to load IP usage'}
          </p>
        )}

        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground text-sm">Your IP</p>
                <p className="font-mono text-sm font-medium">{data.ipAddress}</p>
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
                  : `Rate Limit My IP (insert ${data.limit - data.currentUsage} rows)`}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
