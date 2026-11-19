'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  GatewayConfigInputSchema,
  NOTE_MAX_LENGTH,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatZodError } from '@/lib/zod/format-zod-error';

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [optOutModelsValue, setOptOutModelsValue] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

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

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Vercel Routing</CardTitle>
          <CardDescription>
            Non-BYOK chat traffic for models in the Vercel AI Gateway catalog goes to Vercel;
            otherwise it goes to OpenRouter. Requests with a spend ceiling and provider preferences
            Vercel cannot satisfy always use OpenRouter. Opt-out models use OpenRouter unless the
            provider preferences allow only providers that serve the model on Vercel alone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="routing-opt-out-models">Opt-out models</Label>
            <Textarea
              id="routing-opt-out-models"
              aria-describedby={
                validationError
                  ? 'routing-opt-out-models-description routing-opt-out-models-error'
                  : 'routing-opt-out-models-description'
              }
              aria-invalid={validationError ? true : undefined}
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
              One model ID per line, matched exactly and case-insensitively. Changes apply within
              about a minute.
            </p>
            {validationError && (
              <pre
                id="routing-opt-out-models-error"
                className="bg-destructive/10 text-destructive rounded-md p-3 text-sm whitespace-pre-wrap"
                role="alert"
              >
                {validationError}
              </pre>
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

          <div>
            <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>

          <div className="text-muted-foreground text-sm">
            {data?.updated_by_email && (
              <p>
                Set by {data.updated_by_email}
                {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
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
