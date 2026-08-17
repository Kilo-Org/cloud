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
  DEFAULT_FRIENDLI_PERCENTAGE,
  DEFAULT_PERPLEXITY_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE,
  DEFAULT_VERCEL_PERCENTAGE_FREE,
  NOTE_MAX_LENGTH,
  RoutingPercentageSchema,
} from '@/lib/ai-gateway/gateway-config';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [inputValue, setInputValue] = useState('');
  const [freeInputValue, setFreeInputValue] = useState('');
  const [friendliInputValue, setFriendliInputValue] = useState('');
  const [perplexityInputValue, setPerplexityInputValue] = useState('');
  const [optOutModelsValue, setOptOutModelsValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setInputValue(data.vercel_routing_percentage?.toString() ?? '');
      setFreeInputValue(data.vercel_routing_percentage_free?.toString() ?? '');
      setFriendliInputValue(data.friendli_routing_percentage?.toString() ?? '');
      setPerplexityInputValue(data.perplexity_routing_percentage?.toString() ?? '');
      setOptOutModelsValue(data.vercel_routing_opt_out_models.join('\n'));
      setNoteValue(data.note ?? '');
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.gatewayConfig.set.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayConfig.get.queryKey(),
        });
        toast.success('Gateway routing configuration updated');
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
    if (!RoutingPercentageSchema.safeParse(num).success) return undefined;
    return num;
  }

  function optOutModels() {
    return [
      ...new Set(
        optOutModelsValue
          .split('\n')
          .map(model => model.trim())
          .filter(Boolean)
      ),
    ];
  }

  function handleSave() {
    const note = noteInput();
    const paid = parsePercentage(inputValue);
    const free = parsePercentage(freeInputValue);
    const friendli = parsePercentage(friendliInputValue);
    const perplexity = parsePercentage(perplexityInputValue);
    if (
      paid === undefined ||
      free === undefined ||
      friendli === undefined ||
      perplexity === undefined
    ) {
      toast.error(
        'Enter a percentage between 0 and 100 with up to 3 decimal places, or leave it empty for the default.'
      );
      return;
    }
    mutation.mutate({
      vercel_routing_percentage: paid,
      vercel_routing_percentage_free: free,
      vercel_routing_opt_out_models: optOutModels(),
      friendli_routing_percentage: friendli,
      perplexity_routing_percentage: perplexity,
      note,
    });
  }

  function handleClear() {
    mutation.mutate({
      vercel_routing_percentage: null,
      vercel_routing_percentage_free: null,
      vercel_routing_opt_out_models: optOutModels(),
      friendli_routing_percentage: null,
      perplexity_routing_percentage: null,
      note: noteInput(),
    });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const currentOverride = data?.vercel_routing_percentage;
  const currentFreeOverride = data?.vercel_routing_percentage_free;
  const currentFriendliOverride = data?.friendli_routing_percentage;
  const currentPerplexityOverride = data?.perplexity_routing_percentage;
  const isOverrideActive =
    (currentOverride !== null && currentOverride !== undefined) ||
    (currentFreeOverride !== null && currentFreeOverride !== undefined) ||
    (currentFriendliOverride !== null && currentFriendliOverride !== undefined) ||
    (currentPerplexityOverride !== null && currentPerplexityOverride !== undefined);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Gateway Routing</CardTitle>
          <CardDescription>
            For models available on the Vercel AI Gateway, controls the percentage of traffic routed
            to Vercel (vs OpenRouter). Models not available on Vercel always go to OpenRouter, so
            overall traffic may still be skewed towards OpenRouter. Paid and free models are
            configured separately. Leave empty to use the default ({DEFAULT_VERCEL_PERCENTAGE}% for
            paid, {DEFAULT_VERCEL_PERCENTAGE_FREE}% for free). Friendli and Perplexity route only
            their configured models and default to 0%.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm font-medium">Vercel</p>
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
          <p className="pt-2 text-sm font-medium">Direct partners</p>
          <div className="flex items-center gap-3">
            <Label htmlFor="routing-friendli" className="w-24 shrink-0">
              Friendli
            </Label>
            <Input
              id="routing-friendli"
              type="number"
              min={0}
              max={100}
              step={0.001}
              placeholder={`Default: ${DEFAULT_FRIENDLI_PERCENTAGE}%`}
              value={friendliInputValue}
              onChange={e => {
                setFriendliInputValue(e.target.value);
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
            <Label htmlFor="routing-perplexity" className="w-24 shrink-0">
              Perplexity
            </Label>
            <Input
              id="routing-perplexity"
              type="number"
              min={0}
              max={100}
              step={0.001}
              placeholder={`Default: ${DEFAULT_PERPLEXITY_PERCENTAGE}%`}
              value={perplexityInputValue}
              onChange={e => {
                setPerplexityInputValue(e.target.value);
                setHasChanges(true);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSave();
              }}
              className="w-48"
            />
            <span className="text-muted-foreground text-sm">%</span>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="routing-opt-out-models">Opt-out models</Label>
            <Textarea
              id="routing-opt-out-models"
              aria-describedby="routing-opt-out-models-description"
              placeholder={'moonshotai/kimi-k3\nprovider/another-model'}
              value={optOutModelsValue}
              onChange={e => {
                setOptOutModelsValue(e.target.value);
                setHasChanges(true);
              }}
              rows={6}
              className="font-mono text-sm"
            />
            <p id="routing-opt-out-models-description" className="text-muted-foreground text-xs">
              One model ID per line. Matching is exact after entries are lowercased; matching models
              are excluded from percentage-based Vercel routing. Changes take effect within one
              minute on warm instances.
            </p>
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
                of free traffic goes to Vercel. Friendli receives{' '}
                <span className="text-foreground font-medium">
                  {currentFriendliOverride ?? DEFAULT_FRIENDLI_PERCENTAGE}%
                </span>{' '}
                of eligible GLM 5.2 traffic, and Perplexity receives{' '}
                <span className="text-foreground font-medium">
                  {currentPerplexityOverride ?? DEFAULT_PERPLEXITY_PERCENTAGE}%
                </span>{' '}
                of eligible Kimi K3 traffic.
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
                {DEFAULT_VERCEL_PERCENTAGE_FREE}% of free traffic to Vercel,{' '}
                {DEFAULT_FRIENDLI_PERCENTAGE}% to Friendli, and {DEFAULT_PERPLEXITY_PERCENTAGE}% to
                Perplexity).
              </p>
            )}
            {data?.note && (
              <p className="mt-2 whitespace-pre-wrap">
                <span className="font-medium">Previous note:</span> {data.note}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
