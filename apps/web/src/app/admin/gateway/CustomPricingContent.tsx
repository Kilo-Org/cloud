'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CustomPricingConfigSchema,
  type CustomPricingModelConfig,
} from '@kilocode/db/schema-types';
import { formatZodError } from '@/lib/zod/format-zod-error';
import {
  customPricingToForm,
  EMPTY_CUSTOM_PRICING_FORM,
  parseCustomPricingForm,
  sameCustomPricing,
  upsertCustomPricing,
  type CustomPricingForm,
} from '@/app/admin/gateway/custom-pricing-form';

const NO_MODELS: CustomPricingModelConfig[] = [];

function formatPrice(pricePerMillion: number | null): string {
  return pricePerMillion === null ? 'Prompt price' : `$${pricePerMillion}`;
}

function PricingRows({
  models,
  overriddenModels,
  onEdit,
  onRemove,
}: {
  models: readonly CustomPricingModelConfig[];
  overriddenModels?: ReadonlySet<string>;
  onEdit?: (model: CustomPricingModelConfig) => void;
  onRemove?: (model: string) => void;
}) {
  const hasActions = Boolean(onEdit || onRemove);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Prompt</TableHead>
          <TableHead className="text-right">Completion</TableHead>
          <TableHead className="text-right">Cache read</TableHead>
          <TableHead className="text-right">Cache write</TableHead>
          <TableHead>Billing</TableHead>
          {hasActions && <TableHead className="w-24 text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.length === 0 && (
          <TableRow>
            <TableCell
              colSpan={hasActions ? 7 : 6}
              className="text-muted-foreground text-center text-sm"
            >
              No custom pricing. Add a model below.
            </TableCell>
          </TableRow>
        )}
        {models.map(model => (
          <TableRow key={model.model}>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{model.model}</span>
                {overriddenModels?.has(model.model) && (
                  <Badge variant="secondary">Overridden</Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatPrice(model.pricing.prompt_per_million)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatPrice(model.pricing.completion_per_million)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatPrice(model.pricing.input_cache_read_per_million)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatPrice(model.pricing.input_cache_write_per_million)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {model.discountPercentage !== undefined && (
                  <Badge variant="outline">{model.discountPercentage}% off</Badge>
                )}
                {model.fallbackOnly && <Badge variant="outline">Fallback only</Badge>}
              </div>
            </TableCell>
            {hasActions && (
              <TableCell>
                <div className="flex justify-end gap-1">
                  {onEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${model.model}`}
                      onClick={() => onEdit(model)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  {onRemove && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${model.model}`}
                      onClick={() => onRemove(model.model)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const priceFields = [
  { key: 'prompt', label: 'Prompt', placeholder: 'Required' },
  { key: 'completion', label: 'Completion', placeholder: 'Required' },
  { key: 'cacheRead', label: 'Cache read', placeholder: 'Prompt price' },
  { key: 'cacheWrite', label: 'Cache write', placeholder: 'Prompt price' },
] as const;

export function CustomPricingContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.gatewayCustomPricing.get.queryOptions()
  );

  const savedModels = useMemo(() => data?.config?.models ?? NO_MODELS, [data]);
  const builtInModels = data?.builtIn ?? NO_MODELS;
  const [models, setModels] = useState<CustomPricingModelConfig[]>([]);
  const [form, setForm] = useState<CustomPricingForm>(EMPTY_CUSTOM_PRICING_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setModels(savedModels);
    setValidationError(null);
  }, [savedModels]);

  const configuredModelIds = useMemo(() => new Set(models.map(model => model.model)), [models]);

  const mutation = useMutation(
    trpc.admin.gatewayCustomPricing.set.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayCustomPricing.get.queryKey(),
        });
        toast.success(result.config ? 'Custom pricing saved' : 'Custom pricing cleared');
      },
      onError: error => {
        toast.error(formatZodError(error));
      },
    })
  );

  function updateForm(patch: Partial<CustomPricingForm>) {
    setForm(current => ({ ...current, ...patch }));
    setValidationError(null);
  }

  function handleAddOrUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = parseCustomPricingForm(form);
    if ('error' in result) {
      setValidationError(result.error);
      return;
    }
    setModels(current => upsertCustomPricing(current, result.config));
    setForm(EMPTY_CUSTOM_PRICING_FORM);
    setValidationError(null);
  }

  function handleSave() {
    const parsed = CustomPricingConfigSchema.safeParse({ models });
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    mutation.mutate({ config: parsed.data });
  }

  if (isLoading) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  // Without the stored pricing, saving would replace it with whatever the form shows.
  if (!data) {
    return (
      <div className="flex flex-col items-start gap-3 py-8 text-sm" role="alert">
        <p className="text-destructive">
          Could not load custom pricing{error ? `: ${error.message}` : '.'} Editing is disabled
          until it loads.
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const hasStoredConfig = Boolean(data.config);
  const hasChanges = !sameCustomPricing(models, savedModels);
  const isUpdate = configuredModelIds.has(form.model.trim());

  return (
    <div className="flex w-full flex-col gap-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom Pricing</CardTitle>
          <CardDescription>
            Prices Kilo bills per 1M tokens instead of the upstream cost, stored in the{' '}
            <code>custom_pricing</code> column of <code>ai_gateway_config</code>. The model catalog,
            endpoint pricing, billing, and the organization Providers &amp; Models page use them for
            the exact requested model ID. Configured pricing replaces built-in pricing for the same
            model.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {hasStoredConfig
              ? 'Showing the stored pricing. Changes take effect within one minute on warm instances.'
              : 'No pricing stored. Only built-in pricing applies.'}
          </p>

          <PricingRows
            models={models}
            onEdit={model => {
              setForm(customPricingToForm(model));
              setValidationError(null);
            }}
            onRemove={model => {
              setModels(current => current.filter(m => m.model !== model));
              setValidationError(null);
            }}
          />

          <form className="flex max-w-4xl flex-col gap-4" onSubmit={handleAddOrUpdate}>
            <div className="space-y-2">
              <Label htmlFor="custom-pricing-model">Model ID</Label>
              <Input
                id="custom-pricing-model"
                className="font-mono"
                placeholder="provider/model-id"
                value={form.model}
                onChange={event => updateForm({ model: event.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              {priceFields.map(field => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={`custom-pricing-${field.key}`}>{field.label} ($/1M)</Label>
                  <Input
                    id={`custom-pricing-${field.key}`}
                    className="font-mono"
                    inputMode="decimal"
                    placeholder={field.placeholder}
                    value={form[field.key]}
                    onChange={event => updateForm({ [field.key]: event.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-6">
              <div className="space-y-2">
                <Label htmlFor="custom-pricing-discount">Discount shown in name (%)</Label>
                <Input
                  id="custom-pricing-discount"
                  className="w-40 font-mono"
                  inputMode="numeric"
                  placeholder="None"
                  value={form.discountPercentage}
                  onChange={event => updateForm({ discountPercentage: event.target.value })}
                />
              </div>
              <div className="flex h-9 items-center gap-2">
                <Checkbox
                  id="custom-pricing-fallback-only"
                  checked={form.fallbackOnly}
                  onCheckedChange={fallbackOnly => updateForm({ fallbackOnly })}
                />
                <Label htmlFor="custom-pricing-fallback-only">
                  Fallback only (bill only when upstream reports no cost)
                </Label>
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={!form.model.trim()}>
                {isUpdate ? 'Update model' : 'Add model'}
              </Button>
            </div>
          </form>

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
            {hasChanges && (
              <Button
                onClick={() => {
                  setModels(savedModels);
                  setValidationError(null);
                }}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Discard changes
              </Button>
            )}
            {hasStoredConfig && (
              <Button
                onClick={() => mutation.mutate({ config: null })}
                disabled={mutation.isPending}
                variant="outline"
                size="sm"
              >
                Clear stored pricing
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Built-in Pricing</CardTitle>
          <CardDescription>
            Defined in <code>custom-pricing.constants.ts</code>. Change it in code, or add the same
            model above to override it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PricingRows models={builtInModels} overriddenModels={configuredModelIds} />
        </CardContent>
      </Card>
    </div>
  );
}
