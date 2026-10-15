'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NOTE_MAX_LENGTH } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [optOutModelsValue, setOptOutModelsValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
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
        toast.success('Vercel routing configuration updated');
      },
      onError: error => {
        toast.error(error.message || 'Failed to update');
      },
    })
  );

  function handleSave() {
    const note = noteValue.trim();
    mutation.mutate({
      vercel_routing_opt_out_models: [
        ...new Set(
          optOutModelsValue
            .split('\n')
            .map(model => model.trim())
            .filter(Boolean)
        ),
      ],
      note: note === '' ? null : note,
    });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vercel Routing</CardTitle>
        <CardDescription>
          Every eligible request routes to the Vercel AI Gateway. A request is eligible when its
          model is available on Vercel, is not opted out below, and its provider preferences can be
          met there. Everything else goes to OpenRouter.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
            always go to OpenRouter. Changes take effect within one minute on warm instances.
          </p>
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

        <div>
          <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
            {mutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>

        {(data?.updated_by_email || data?.note) && (
          <div className="text-muted-foreground text-sm">
            {data.updated_by_email && (
              <p>
                Last updated by {data.updated_by_email}
                {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
              </p>
            )}
            {data.note && (
              <p className="mt-2 whitespace-pre-wrap">
                <span className="font-medium">Previous note:</span> {data.note}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
