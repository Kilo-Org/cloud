'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  createCloudBillingSkuInputSchema,
  multiplyCloudBillingRate,
  type CreateCloudBillingSkuInput,
} from '@/lib/cloud-billing-sku';

type Props = {
  pending: boolean;
  serverErrors?: Partial<Record<keyof CreateCloudBillingSkuInput, string>>;
  onSubmit: (values: CreateCloudBillingSkuInput) => void;
};

type RawForm = {
  id: string;
  name: string;
  description: string;
  rate: string;
  exampleMinutes: string;
};

const RATE_WHITESPACE_ERROR = 'Remove leading or trailing spaces.';

function preview(rate: string, seconds: number): string {
  const parsed = createCloudBillingSkuInputSchema.shape.rate_cents_per_unit.safeParse(rate);
  return parsed.success ? `${multiplyCloudBillingRate(parsed.data, seconds)} cents` : '—';
}

export default function CloudBillingSkuForm({ pending, serverErrors, onSubmit }: Props) {
  const [raw, setRaw] = useState<RawForm>({
    id: '',
    name: '',
    description: '',
    rate: '',
    exampleMinutes: '15',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof CreateCloudBillingSkuInput, string>>>(
    {}
  );
  const idRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  const exampleMinutes = /^\d+$/.test(raw.exampleMinutes) ? Number(raw.exampleMinutes) : 0;
  const rateError =
    raw.rate !== raw.rate.trim() ? RATE_WHITESPACE_ERROR : errors.rate_cents_per_unit;

  useEffect(() => {
    if (!serverErrors || Object.keys(serverErrors).length === 0) return;
    setErrors(current => ({ ...current, ...serverErrors }));
    if (serverErrors.id) idRef.current?.focus();
  }, [serverErrors]);

  const clearError = (key: keyof CreateCloudBillingSkuInput) => {
    setErrors(current => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = createCloudBillingSkuInputSchema.safeParse({
      id: raw.id.trim(),
      name: raw.name.trim(),
      description: raw.description.trim() || null,
      unit: 'second',
      rate_cents_per_unit: raw.rate,
    });
    if (!parsed.success) {
      const next: Partial<Record<keyof CreateCloudBillingSkuInput, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof CreateCloudBillingSkuInput | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      const firstKey = parsed.error.issues[0]?.path[0];
      if (firstKey === 'id') idRef.current?.focus();
      if (firstKey === 'name') nameRef.current?.focus();
      if (firstKey === 'description') descriptionRef.current?.focus();
      if (firstKey === 'rate_cents_per_unit') rateRef.current?.focus();
      return;
    }
    setErrors({});
    onSubmit(parsed.data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6" aria-busy={pending}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sku-id">SKU ID</Label>
          <Input
            id="sku-id"
            ref={idRef}
            autoFocus
            value={raw.id}
            maxLength={80}
            disabled={pending}
            placeholder="cloud-agent-standard-2026-07"
            aria-describedby={errors.id ? 'sku-id-help sku-id-error' : 'sku-id-help'}
            aria-invalid={Boolean(errors.id)}
            onChange={event => {
              clearError('id');
              setRaw(current => ({ ...current, id: event.target.value }));
            }}
          />
          <p id="sku-id-help" className="text-muted-foreground type-label">
            Producer-facing constant. Use lowercase letters, numbers, and hyphens.
          </p>
          {errors.id && (
            <p id="sku-id-error" className="text-destructive type-label" role="alert">
              {errors.id}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sku-name">Display name</Label>
          <Input
            id="sku-name"
            ref={nameRef}
            value={raw.name}
            maxLength={120}
            disabled={pending}
            placeholder="Cloud Agent Standard"
            aria-describedby={errors.name ? 'sku-name-error' : undefined}
            aria-invalid={Boolean(errors.name)}
            onChange={event => {
              clearError('name');
              setRaw(current => ({ ...current, name: event.target.value }));
            }}
          />
          {errors.name && (
            <p id="sku-name-error" className="text-destructive type-label" role="alert">
              {errors.name}
            </p>
          )}
        </div>

        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="sku-description">Description</Label>
          <Textarea
            id="sku-description"
            ref={descriptionRef}
            value={raw.description}
            maxLength={1000}
            disabled={pending}
            placeholder="What reports this SKU and when it should be selected."
            aria-describedby={errors.description ? 'sku-description-error' : undefined}
            aria-invalid={Boolean(errors.description)}
            onChange={event => {
              clearError('description');
              setRaw(current => ({ ...current, description: event.target.value }));
            }}
          />
          {errors.description && (
            <p id="sku-description-error" className="text-destructive type-label" role="alert">
              {errors.description}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sku-rate">Rate (cents per second)</Label>
          <Input
            id="sku-rate"
            ref={rateRef}
            type="text"
            inputMode="decimal"
            value={raw.rate}
            disabled={pending}
            placeholder="0.000007"
            aria-describedby={rateError ? 'sku-rate-help sku-rate-error' : 'sku-rate-help'}
            aria-invalid={Boolean(rateError)}
            onChange={event => {
              clearError('rate_cents_per_unit');
              setRaw(current => ({ ...current, rate: event.target.value }));
            }}
          />
          <p id="sku-rate-help" className="text-muted-foreground type-label">
            Up to 12 decimal places. This exact rate is immutable after creation.
          </p>
          {rateError && (
            <p id="sku-rate-error" className="text-destructive type-label" role="alert">
              {rateError}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="example-minutes">Example duration (minutes)</Label>
          <Input
            id="example-minutes"
            type="number"
            min="1"
            step="1"
            max="525600"
            value={raw.exampleMinutes}
            disabled={pending}
            onChange={event =>
              setRaw(current => ({ ...current, exampleMinutes: event.target.value }))
            }
          />
        </div>
      </div>

      <div className="bg-surface-inset grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-3">
        <div>
          <p className="text-muted-foreground type-label">Per minute</p>
          <p className="mt-1 tabular-nums type-code">{preview(raw.rate, 60)}</p>
        </div>
        <div>
          <p className="text-muted-foreground type-label">Per hour</p>
          <p className="mt-1 tabular-nums type-code">{preview(raw.rate, 3_600)}</p>
        </div>
        <div>
          <p className="text-muted-foreground type-label">
            {exampleMinutes > 0 ? `${exampleMinutes} minute example` : 'Example'}
          </p>
          <p className="mt-1 tabular-nums type-code">
            {exampleMinutes > 0 && exampleMinutes <= 525_600
              ? preview(raw.rate, exampleMinutes * 60)
              : '—'}
          </p>
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating...' : 'Create SKU'}
      </Button>
    </form>
  );
}
