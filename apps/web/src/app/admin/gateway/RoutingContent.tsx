'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_VERCEL_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE_FREE,
  NOTE_MAX_LENGTH,
  VercelRoutingPercentageSchema,
} from '@/lib/ai-gateway/gateway-config';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [inputValue, setInputValue] = useState('');
  const [freeInputValue, setFreeInputValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setInputValue(data.vercel_routing_percentage?.toString() ?? '');
      setFreeInputValue(data.vercel_routing_percentage_free?.toString() ?? '');
      setNoteValue('');
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

  function noteInput(): string | null {
    const trimmed = noteValue.trim();
    return trimmed === '' ? null : trimmed;
  }

  function parsePercentage(raw: string): number | null | undefined {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    if (!VercelRoutingPercentageSchema.safeParse(num).success) return undefined;
    return num;
  }

  function handleSave() {
    const note = noteInput();
    const paid = parsePercentage(inputValue);
    const free = parsePercentage(freeInputValue);
    if (paid === undefined || free === undefined) {
      toast.error(
        'Enter a percentage between 0 and 100 with up to 3 decimal places, or leave it empty for the default.'
      );
      return;
    }
    mutation.mutate({
      vercel_routing_percentage: paid,
      vercel_routing_percentage_free: free,
      note,
    });
  }

  function handleClear() {
    mutation.mutate({
      vercel_routing_percentage: null,
      vercel_routing_percentage_free: null,
      note: noteInput(),
    });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const currentOverride = data?.vercel_routing_percentage;
  const currentFreeOverride = data?.vercel_routing_percentage_free;
  const isOverrideActive =
    (currentOverride !== null && currentOverride !== undefined) ||
    (currentFreeOverride !== null && currentFreeOverride !== undefined);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Vercel Routing Percentage</CardTitle>
          <CardDescription>
            For models available on the Vercel AI Gateway, controls the percentage of traffic routed
            to Vercel (vs OpenRouter). Models not available on Vercel always go to OpenRouter, so
            overall traffic may still be skewed towards OpenRouter. Paid and free models are
            configured separately. Leave empty to use the default ({DEFAULT_VERCEL_PERCENTAGE}% for
            paid, {DEFAULT_VERCEL_PERCENTAGE_FREE}% for free).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Label htmlFor="routing-paid" className="w-24 shrink-0">
              Paid models
            </Label>
            <Input
              id="routing-paid"
              type="number"
              min={0}
              max={100}
              step={0.001}
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
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="routing-free" className="w-24 shrink-0">
              Free models
            </Label>
            <Input
              id="routing-free"
              type="number"
              min={0}
              max={100}
              step={0.001}
              placeholder={`Default: ${DEFAULT_VERCEL_PERCENTAGE_FREE}%`}
              value={freeInputValue}
              onChange={e => {
                setFreeInputValue(e.target.value);
                setHasChanges(true);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSave();
              }}
              className="w-48"
            />
            <span className="text-muted-foreground text-sm">%</span>
          </div>
          <div className="flex items-center gap-3">
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

          <div className="flex flex-col gap-2">
            <Label htmlFor="routing-note">Note (optional)</Label>
            <Textarea
              id="routing-note"
              placeholder="Why is this change being made?"
              maxLength={NOTE_MAX_LENGTH}
              value={noteValue}
              onChange={e => {
                setNoteValue(e.target.value);
                setHasChanges(true);
              }}
              className="min-h-20"
            />
          </div>

          <div className="text-muted-foreground text-sm">
            {isOverrideActive ? (
              <p>
                Override active:{' '}
                <span className="text-foreground font-medium">
                  {currentOverride ?? DEFAULT_VERCEL_PERCENTAGE}%
                </span>{' '}
                of paid traffic and{' '}
                <span className="text-foreground font-medium">
                  {currentFreeOverride ?? DEFAULT_VERCEL_PERCENTAGE_FREE}%
                </span>{' '}
                of free traffic goes to Vercel.
                {data?.updated_by_email && (
                  <span className="ml-1">
                    Set by {data.updated_by_email}
                    {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
                  </span>
                )}
              </p>
            ) : (
              <p>
                No override set. Using default routing ({DEFAULT_VERCEL_PERCENTAGE}% of paid and{' '}
                {DEFAULT_VERCEL_PERCENTAGE_FREE}% of free traffic to Vercel).
              </p>
            )}
            {data?.note && (
              <p className="mt-2">
                <span className="font-medium">Previous note:</span> {data.note}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
