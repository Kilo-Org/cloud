'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  PreferredProviderOrderConfigSchema,
  type PreferredProviderOrderConfig,
} from '@kilocode/db/schema-types';
import { resolvePreferredProviderOrder } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import { deepStrict } from '@/lib/zod/deep-strict';
import { formatZodError } from '@/lib/zod/format-zod-error';

const StrictPreferredProviderOrderConfigSchema = deepStrict(PreferredProviderOrderConfigSchema);

function toJson(config: PreferredProviderOrderConfig): string {
  return JSON.stringify(config, null, 2);
}

function parseConfig(json: string): { config: PreferredProviderOrderConfig } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: 'Invalid JSON syntax' };
  }
  const strict = StrictPreferredProviderOrderConfigSchema.safeParse(raw);
  if (!strict.success) return { error: formatZodError(strict.error) };
  const result = PreferredProviderOrderConfigSchema.safeParse(raw);
  if (!result.success) return { error: formatZodError(result.error) };
  return { config: result.data };
}

function ModelPreview({ json }: { json: string }) {
  const [model, setModel] = useState('');
  const trimmed = model.trim();
  const parsed = trimmed ? parseConfig(json) : null;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="provider-order-preview" className="text-sm font-medium">
        Preview a model ID
      </label>
      <Input
        id="provider-order-preview"
        value={model}
        onChange={event => setModel(event.target.value)}
        placeholder="anthropic/claude-sonnet-4.5"
        className="max-w-md font-mono"
      />
      {parsed && (
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {'error' in parsed ? (
            'Fix the JSON to preview.'
          ) : (
            <PreviewResult providers={resolvePreferredProviderOrder(parsed.config, trimmed)} />
          )}
        </p>
      )}
    </div>
  );
}

function PreviewResult({ providers }: { providers: string[] }) {
  if (providers.length === 0) {
    return <>No preferred provider order; the gateway leaves provider selection to upstream.</>;
  }
  return (
    <>
      Preferred order: <code>{providers.join(' → ')}</code>
    </>
  );
}

export function PreferredProviderOrderContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(trpc.admin.preferredProviderOrder.get.queryOptions());

  const [json, setJson] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setJson(toJson(data.config ?? data.fallback));
      setValidationError(null);
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.preferredProviderOrder.set.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.preferredProviderOrder.get.queryKey(),
        });
        toast.success(
          result.config
            ? 'Provider order configuration saved'
            : 'Provider order configuration cleared'
        );
      },
      onError: error => {
        toast.error(formatZodError(error));
      },
    })
  );

  function handleSave() {
    const parsed = parseConfig(json);
    if ('error' in parsed) {
      setValidationError(parsed.error);
      return;
    }
    mutation.mutate({ config: parsed.config });
  }

  function handleLoadFallback() {
    if (!data) return;
    setJson(toJson(data.fallback));
    setValidationError(null);
    setHasChanges(true);
  }

  function handleClear() {
    mutation.mutate({ config: null });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const hasStoredConfig = Boolean(data?.config);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Provider Order</CardTitle>
          <CardDescription>
            Preferred inference provider order for OpenRouter and Vercel requests, stored in the{' '}
            <code>preferred_provider_order</code> column of <code>ai_gateway_config</code>. Rules
            are checked top to bottom. A rule matches when the requested model ID contains at least
            one of its <code>includes</code> substrings and none of its optional{' '}
            <code>excludes</code> substrings. The first matching rule sets{' '}
            <code>provider.order</code> to its <code>providers</code>; when no rule matches, there
            is no preference. The order is only applied when the caller did not send one, and the
            first provider also picks the price shown in the model catalog. Provider slugs are
            OpenRouter slugs, optionally with an endpoint variant such as <code>minimax/fp8</code>.{' '}
            <strong>
              The gateway does not read this configuration yet; it still uses the built-in rules.
            </strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {hasStoredConfig
              ? 'Showing the stored configuration.'
              : 'No configuration stored. Showing the built-in rules.'}
          </p>
          <div className="border-input overflow-hidden rounded-md border">
            <Editor
              height="560px"
              defaultLanguage="json"
              value={json}
              onChange={(value: string | undefined) => {
                setJson(value ?? '');
                setValidationError(null);
                setHasChanges(true);
              }}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                formatOnPaste: true,
                ariaLabel: 'Preferred provider order configuration JSON',
              }}
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

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={mutation.isPending || (!hasChanges && hasStoredConfig)}
              size="sm"
            >
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
            <Button
              onClick={handleLoadFallback}
              disabled={mutation.isPending}
              variant="outline"
              size="sm"
            >
              Load built-in rules
            </Button>
            {hasStoredConfig && (
              <Button
                onClick={handleClear}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Clear configuration
              </Button>
            )}
          </div>

          <ModelPreview json={json} />
        </CardContent>
      </Card>
    </div>
  );
}
