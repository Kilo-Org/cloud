'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ENKRYPT_LIMIT_BOUNDS,
  EnkryptLimitsInputSchema,
  type EnkryptLimits,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatZodError } from '@/lib/zod/format-zod-error';

type FieldKey = 'callsPerMinute' | 'timeoutSeconds' | 'maxScanCharacters';
type FormValues = Record<FieldKey, string>;
type FieldErrors = Partial<Record<FieldKey, string>>;

const FIELDS: readonly {
  key: FieldKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  description: string;
}[] = [
  {
    key: 'callsPerMinute',
    label: 'Calls per minute',
    unit: 'calls',
    min: ENKRYPT_LIMIT_BOUNDS.calls_per_minute.min,
    max: ENKRYPT_LIMIT_BOUNDS.calls_per_minute.max,
    description:
      'A coarse limit shared by all gateway instances per minute. Calls over it are not made and fail open, like an Enkrypt failure.',
  },
  {
    key: 'timeoutSeconds',
    label: 'Timeout (seconds)',
    unit: 'seconds',
    min: ENKRYPT_LIMIT_BOUNDS.timeout_ms.min / 1000,
    max: ENKRYPT_LIMIT_BOUNDS.timeout_ms.max / 1000,
    description:
      "The deadline shared by one guardrail's Enkrypt calls in a request. It caps how long a blocking scan can delay the request.",
  },
  {
    key: 'maxScanCharacters',
    label: 'Max characters per scan',
    unit: 'characters',
    min: ENKRYPT_LIMIT_BOUNDS.max_scan_characters.min,
    max: ENKRYPT_LIMIT_BOUNDS.max_scan_characters.max,
    description:
      'The most text one Enkrypt call scans. Longer request text is split across calls; longer responses are withheld.',
  },
];

function toFormValues(limits: EnkryptLimits): FormValues {
  return {
    callsPerMinute: String(limits.calls_per_minute),
    timeoutSeconds: String(limits.timeout_ms / 1000),
    maxScanCharacters: String(limits.max_scan_characters),
  };
}

function parseNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function toInput(values: FormValues) {
  return {
    calls_per_minute: parseNumber(values.callsPerMinute),
    timeout_ms: Math.round(parseNumber(values.timeoutSeconds) * 1000),
    max_scan_characters: parseNumber(values.maxScanCharacters),
  };
}

function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of FIELDS) {
    const value = parseNumber(values[field.key]);
    const isSeconds = field.key === 'timeoutSeconds';
    if (!Number.isFinite(value) || (!isSeconds && !Number.isInteger(value))) {
      errors[field.key] = isSeconds ? 'Enter a number of seconds.' : 'Enter a whole number.';
    } else if (value < field.min || value > field.max) {
      errors[field.key] =
        `Enter ${field.min.toLocaleString()} to ${field.max.toLocaleString()} ${field.unit}.`;
    }
  }
  return errors;
}

export function EnkryptLimitsContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.gatewayConfig.getEnkryptLimits.queryOptions()
  );

  const [values, setValues] = useState<FormValues | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (data) {
      setValues(toFormValues(data));
      setHasChanges(false);
      setFieldErrors({});
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.gatewayConfig.setEnkryptLimits.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayConfig.getEnkryptLimits.queryKey(),
        });
        toast.success('Enkrypt limits updated');
      },
      onError: error => {
        toast.error(formatZodError(error));
      },
    })
  );

  if (isLoading || (data && !values)) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  if (!values) {
    return (
      <div className="flex flex-col items-start gap-2 py-8 text-sm" role="alert">
        <p className="text-destructive">
          Could not load Enkrypt limits{error ? `: ${error.message}` : '.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  function update(key: FieldKey, value: string) {
    if (!values) return;
    setValues({ ...values, [key]: value });
    setFieldErrors(errors => ({ ...errors, [key]: undefined }));
    setHasChanges(true);
  }

  function handleSave() {
    if (!values) return;
    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    const parsed = EnkryptLimitsInputSchema.safeParse(toInput(values));
    if (!parsed.success) {
      toast.error(formatZodError(parsed.error));
      return;
    }
    setFieldErrors({});
    mutation.mutate(parsed.data);
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Enkrypt limits</CardTitle>
        <CardDescription>
          Limits on the gateway&apos;s calls to Enkrypt for input and output guardrails. Changes
          reach the gateway within about a minute.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid gap-6 lg:grid-cols-3">
          {FIELDS.map(field => {
            const id = `enkrypt-limits-${field.key}`;
            const fieldError = fieldErrors[field.key];
            return (
              <div key={field.key} className="flex min-w-0 flex-col gap-2">
                <Label htmlFor={id}>{field.label}</Label>
                <p id={`${id}-description`} className="text-muted-foreground text-xs">
                  {field.description} {field.min.toLocaleString()} to {field.max.toLocaleString()}.
                </p>
                <Input
                  id={id}
                  type="number"
                  inputMode={field.key === 'timeoutSeconds' ? 'decimal' : 'numeric'}
                  min={field.min}
                  max={field.max}
                  step={field.key === 'timeoutSeconds' ? 'any' : 1}
                  aria-describedby={
                    fieldError ? `${id}-description ${id}-error` : `${id}-description`
                  }
                  aria-invalid={fieldError ? true : undefined}
                  value={values[field.key]}
                  onChange={e => update(field.key, e.target.value)}
                  className="w-full max-w-48"
                />
                {fieldError && (
                  <p id={`${id}-error`} className="text-destructive text-xs" role="alert">
                    {fieldError}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div>
          <Button onClick={handleSave} disabled={mutation.isPending || !hasChanges} size="sm">
            {mutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
