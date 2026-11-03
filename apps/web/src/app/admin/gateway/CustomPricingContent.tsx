'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CustomPricingConfigSchema, type CustomPricingConfig } from '@kilocode/db/schema-types';
import { EMPTY_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { deepStrict } from '@/lib/zod/deep-strict';
import { formatZodError } from '@/lib/zod/format-zod-error';

const StrictCustomPricingConfigSchema = deepStrict(CustomPricingConfigSchema);

function toJson(config: CustomPricingConfig): string {
  return JSON.stringify(config, null, 2);
}

function parseConfig(json: string): { config: CustomPricingConfig } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: 'Invalid JSON syntax' };
  }
  const strict = StrictCustomPricingConfigSchema.safeParse(raw);
  if (!strict.success) return { error: formatZodError(strict.error) };
  const result = CustomPricingConfigSchema.safeParse(raw);
  if (!result.success) return { error: formatZodError(result.error) };
  return { config: result.data };
}

export function CustomPricingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(trpc.admin.customPricing.get.queryOptions());

  const [json, setJson] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setJson(toJson(data.config ?? EMPTY_CUSTOM_PRICING_CONFIG));
      setValidationError(null);
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.customPricing.set.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.customPricing.get.queryKey(),
        });
        toast.success(result.config ? 'Custom pricing saved' : 'Custom pricing cleared');
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

  function handleClear() {
    mutation.mutate({ config: null });
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(json);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const hasStoredConfig = Boolean(data?.config);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom Pricing</CardTitle>
          <CardDescription>
            Prices Kilo bills and shows for specific gateway model IDs, stored in the{' '}
            <code>custom_pricing</code> column of <code>ai_gateway_config</code>. Each entry has a{' '}
            <code>model</code> ID and <code>pricing</code> tiers in USD per million tokens; the
            first tier starts at context length 0 and later tiers start at ascending input lengths.
            Set <code>input_cache_read_per_million</code> or{' '}
            <code>input_cache_write_per_million</code> to <code>null</code> to bill cache tokens at
            the prompt price. The optional <code>discountPercentage</code> is only shown in the
            model name. With <code>fallbackOnly</code>, the prices apply only when the upstream
            reports no cost. When no configuration is stored, no custom pricing applies. Changes
            take effect within one minute on warm instances.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {hasStoredConfig
              ? 'Showing the stored configuration.'
              : 'No configuration stored. The gateway applies no custom pricing.'}
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
                ariaLabel: 'Custom pricing configuration JSON',
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
            <Button onClick={() => void handleCopy()} variant="outline" size="sm">
              Copy JSON
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
        </CardContent>
      </Card>
    </div>
  );
}
