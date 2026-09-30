'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';
import { deepStrict } from '@/lib/zod/deep-strict';
import { formatZodError } from '@/lib/zod/format-zod-error';

const StrictAutoFreeConfigSchema = deepStrict(AutoFreeConfigSchema);

function toJson(config: AutoFreeConfig): string {
  return JSON.stringify(config, null, 2);
}

function parseConfig(json: string): { config: AutoFreeConfig } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: 'Invalid JSON syntax' };
  }
  const strict = StrictAutoFreeConfigSchema.safeParse(raw);
  if (!strict.success) return { error: formatZodError(strict.error) };
  const result = AutoFreeConfigSchema.safeParse(raw);
  if (!result.success) return { error: formatZodError(result.error) };
  return { config: result.data };
}

export function AutoFreeContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(trpc.admin.autoFreeConfig.get.queryOptions());

  const [json, setJson] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (data) {
      setJson(toJson(data.config ?? data.defaults));
      setValidationError(null);
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.autoFreeConfig.set.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.autoFreeConfig.get.queryKey(),
        });
        toast.success(
          result.config ? 'Auto-free configuration saved' : 'Auto-free configuration cleared'
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

  function handleClear() {
    mutation.mutate({ config: null });
  }

  function handleLoadDefaults() {
    if (!data) return;
    setJson(toJson(data.defaults));
    setValidationError(null);
    setHasChanges(true);
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  const hasStoredConfig = Boolean(data?.config);

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Auto Free</CardTitle>
          <CardDescription>
            Candidate models for <code>kilo-auto/free</code>, stored in the <code>auto_free</code>{' '}
            column of <code>ai_gateway_config</code>. Each entry has a <code>model</code> ID, a
            positive integer <code>weight</code>, and a <code>reasoning</code> config. This
            configuration is not used for routing yet; requests still use the compiled defaults.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {hasStoredConfig
              ? 'Showing the stored configuration.'
              : 'No configuration stored. Showing the compiled defaults.'}
          </p>
          <div className="border-input overflow-hidden rounded-md border">
            <Editor
              height="420px"
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
                ariaLabel: 'Auto-free configuration JSON',
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
              onClick={handleLoadDefaults}
              disabled={mutation.isPending}
              variant="outline"
              size="sm"
            >
              Load defaults
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
