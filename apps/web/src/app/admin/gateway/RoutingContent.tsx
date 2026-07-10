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
  NOTE_MAX_LENGTH,
  type VercelRoutingApiType,
} from '@/lib/ai-gateway/gateway-config';

const ROUTING_API_LABELS: Record<VercelRoutingApiType, string> = {
  chat: 'Chat',
  embeddings: 'Embeddings',
  transcription: 'Transcription',
};

const EMPTY_PERCENTAGES: Record<VercelRoutingApiType, string> = {
  chat: '',
  embeddings: '',
  transcription: '',
};

export function RoutingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.admin.gatewayConfig.get.queryOptions());

  const [percentages, setPercentages] = useState(EMPTY_PERCENTAGES);
  const [noteValue, setNoteValue] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setPercentages({
        chat: data.vercel_chat_routing_percentage?.toString() ?? '',
        embeddings: data.vercel_embeddings_routing_percentage?.toString() ?? '',
        transcription: data.vercel_transcription_routing_percentage?.toString() ?? '',
      });
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
        toast.success('Vercel routing percentages updated');
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

  function handleSave() {
    function parsePercentage(input: string): number | null | undefined {
      const trimmed = input.trim();
      if (trimmed === '') return null;
      const value = Number(trimmed);
      return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
    }

    const chat = parsePercentage(percentages.chat);
    const embeddings = parsePercentage(percentages.embeddings);
    const transcription = parsePercentage(percentages.transcription);
    if (chat === undefined || embeddings === undefined || transcription === undefined) {
      toast.error('Please enter a whole number between 0 and 100, or leave empty for default');
      return;
    }
    mutation.mutate({
      vercel_chat_routing_percentage: chat,
      vercel_embeddings_routing_percentage: embeddings,
      vercel_transcription_routing_percentage: transcription,
      note: noteInput(),
    });
  }

  function handleClear() {
    mutation.mutate({
      vercel_chat_routing_percentage: null,
      vercel_embeddings_routing_percentage: null,
      vercel_transcription_routing_percentage: null,
      note: noteInput(),
    });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const currentPercentages = {
    chat: data?.vercel_chat_routing_percentage,
    embeddings: data?.vercel_embeddings_routing_percentage,
    transcription: data?.vercel_transcription_routing_percentage,
  };
  const isOverrideActive = Object.values(currentPercentages).some(value => value != null);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Vercel Routing Percentages</CardTitle>
          <CardDescription>
            Controls the Vercel traffic split independently for each API. Unsupported models always
            use OpenRouter. Leave a field empty to use the {DEFAULT_VERCEL_PERCENTAGE}% default.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            {Object.entries(ROUTING_API_LABELS).map(([apiType, label]) => (
              <div className="flex flex-col gap-2" key={apiType}>
                <Label htmlFor={`routing-${apiType}`}>{label}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`routing-${apiType}`}
                    type="number"
                    min={0}
                    max={100}
                    placeholder={`Default: ${DEFAULT_VERCEL_PERCENTAGE}%`}
                    value={percentages[apiType as VercelRoutingApiType]}
                    onChange={e => {
                      setPercentages(current => ({ ...current, [apiType]: e.target.value }));
                      setHasChanges(true);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSave();
                    }}
                  />
                  <span className="text-muted-foreground text-sm">%</span>
                </div>
              </div>
            ))}
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
                Clear overrides
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
              <div className="flex flex-col gap-1">
                <p>
                  Active routing: chat {currentPercentages.chat ?? DEFAULT_VERCEL_PERCENTAGE}%,
                  embeddings {currentPercentages.embeddings ?? DEFAULT_VERCEL_PERCENTAGE}%,
                  transcription {currentPercentages.transcription ?? DEFAULT_VERCEL_PERCENTAGE}%.
                </p>
                {data?.updated_by_email && (
                  <p>
                    Set by {data.updated_by_email}
                    {data.updated_at && <> at {new Date(data.updated_at).toLocaleString()}</>}.
                  </p>
                )}
              </div>
            ) : (
              <p>
                No override set. Using default routing ({DEFAULT_VERCEL_PERCENTAGE}% to Vercel).
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
