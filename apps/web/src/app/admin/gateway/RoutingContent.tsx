'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_VERCEL_ROUTING_ENABLED,
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatZodError } from '@/lib/zod/format-zod-error';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [vercelEnabled, setVercelEnabled] = useState(DEFAULT_VERCEL_ROUTING_ENABLED);
  const [optOutModelsValue, setOptOutModelsValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setVercelEnabled(data.vercel_routing_enabled);
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
        toast.error(formatZodError(error));
      },
    })
  );

  function noteInput(): string | null {
    const trimmed = noteValue.trim();
    return trimmed === '' ? null : trimmed;
  }

  function handleSave() {
    const parsed = GatewayConfigInputSchema.safeParse({
      vercel_routing_enabled: vercelEnabled,
      vercel_routing_opt_out_models: optOutModelsValue
        .split('\n')
        .filter(model => model.trim() !== ''),
      note: noteInput(),
    });
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data);
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const savedEnabled = data?.vercel_routing_enabled ?? DEFAULT_VERCEL_ROUTING_ENABLED;

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Gateway Routing</CardTitle>
          <CardDescription>
            When on, all free and paid traffic for models available on the Vercel AI Gateway is
            routed to Vercel. When off, that traffic goes to OpenRouter. Models not available on
            Vercel, opt-out models, and requests whose provider preferences Vercel cannot satisfy
            always go to OpenRouter. On by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="routing-vercel-enabled"
              checked={vercelEnabled}
              onCheckedChange={checked => {
                setVercelEnabled(checked);
                setHasChanges(true);
              }}
            />
            <Label htmlFor="routing-vercel-enabled" className="cursor-pointer">
              Route eligible traffic to Vercel
            </Label>
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
                setValidationError(null);
                setHasChanges(true);
              }}
              rows={6}
              className="font-mono text-sm"
            />
            <p id="routing-opt-out-models-description" className="text-muted-foreground text-xs">
              One model ID per line. Matching is exact after entries are lowercased; matching models
              are never routed to Vercel. Changes take effect within one minute on warm instances.
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

          {validationError && (
            <pre
              className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap"
              role="alert"
            >
              {validationError}
            </pre>
          )}

          <div>
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>

          <div className="text-muted-foreground text-sm">
            <p>
              Vercel routing is{' '}
              <span className="text-foreground font-medium">{savedEnabled ? 'on' : 'off'}</span>.
              {data?.updated_by_email && (
                <span className="ml-1">
                  Set by {data.updated_by_email}
                  {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
                </span>
              )}
            </p>
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
