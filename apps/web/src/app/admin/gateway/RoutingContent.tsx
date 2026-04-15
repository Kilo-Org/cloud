'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_VERCEL_PERCENTAGE } from '@/lib/gateway-config';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [inputValue, setInputValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setInputValue(data.vercel_routing_percentage?.toString() ?? '');
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.gatewayConfig.set.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayConfig.get.queryKey(),
        });
        toast.success('Vercel routing percentage updated');
      },
      onError: error => {
        toast.error(error.message || 'Failed to update');
      },
    })
  );

  function handleSave() {
    const trimmed = inputValue.trim();
    if (trimmed === '') {
      mutation.mutate({ vercel_routing_percentage: null });
    } else {
      const num = Number(trimmed);
      if (!Number.isInteger(num) || num < 0 || num > 100) {
        toast.error('Please enter a whole number between 0 and 100, or leave empty for default');
        return;
      }
      mutation.mutate({ vercel_routing_percentage: num });
    }
  }

  function handleClear() {
    mutation.mutate({ vercel_routing_percentage: null });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const currentOverride = data?.vercel_routing_percentage;
  const isOverrideActive = currentOverride !== null && currentOverride !== undefined;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Vercel Routing Percentage</CardTitle>
          <CardDescription>
            Control the percentage of traffic routed to the Vercel AI Gateway (vs OpenRouter). Leave
            empty to use the default ({DEFAULT_VERCEL_PERCENTAGE}%). Stored in Redis for
            sub-millisecond reads on the hot path.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={0}
              max={100}
              placeholder={`Default: ${DEFAULT_VERCEL_PERCENTAGE}%`}
              value={inputValue}
              onChange={e => {
                setInputValue(e.target.value);
                setHasChanges(true);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSave();
              }}
              className="w-48"
            />
            <span className="text-muted-foreground text-sm">%</span>
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
            {isOverrideActive && (
              <Button
                onClick={handleClear}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Clear override
              </Button>
            )}
          </div>

          <div className="text-muted-foreground text-sm">
            {isOverrideActive ? (
              <p>
                Override active:{' '}
                <span className="text-foreground font-medium">{currentOverride}%</span> of traffic
                goes to Vercel.
                {data?.updated_by_email && (
                  <span className="ml-1">
                    Set by {data.updated_by_email}
                    {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
                  </span>
                )}
              </p>
            ) : (
              <p>
                No override set. Using default routing ({DEFAULT_VERCEL_PERCENTAGE}% to Vercel).
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
