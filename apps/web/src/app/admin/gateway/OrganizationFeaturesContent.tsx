'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ORGANIZATION_FEATURES,
  ORGANIZATION_FEATURE_DESCRIPTIONS,
  OrganizationFeaturesInputSchema,
  type OrganizationFeature,
  type OrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatZodError } from '@/lib/zod/format-zod-error';

type FeatureValues = Record<OrganizationFeature, string>;

function toFeatureValues(features: OrganizationFeatures): FeatureValues {
  return {
    experimental_byok: features.experimental_byok.join('\n'),
    gateway_disable_toggles: features.gateway_disable_toggles.join('\n'),
    data_region: features.data_region.join('\n'),
  };
}

function parseOrganizationIds(value: string): string[] {
  return value
    .split('\n')
    .map(id => id.trim())
    .filter(id => id !== '');
}

export function OrganizationFeaturesContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(
    trpc.admin.gatewayConfig.getOrganizationFeatures.queryOptions()
  );

  const [values, setValues] = useState<FeatureValues | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setValues(toFeatureValues(data));
      setHasChanges(false);
    }
  }, [data]);

  const mutation = useMutation(
    trpc.admin.gatewayConfig.setOrganizationFeatures.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.gatewayConfig.getOrganizationFeatures.queryKey(),
        });
        toast.success('Organization features updated');
      },
      onError: error => {
        toast.error(formatZodError(error));
      },
    })
  );

  if (isLoading || !values) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  function handleSave() {
    if (!values) return;
    const parsed = OrganizationFeaturesInputSchema.safeParse({
      experimental_byok: parseOrganizationIds(values.experimental_byok),
      gateway_disable_toggles: parseOrganizationIds(values.gateway_disable_toggles),
      data_region: parseOrganizationIds(values.data_region),
    });
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Features</CardTitle>
        <CardDescription>
          Enables gateway features for specific organizations. Stored under{' '}
          <code>organization_features</code> in the <code>config</code> column of{' '}
          <code>ai_gateway_config</code>. Enter one organization ID per line. Gateway requests pick
          up changes within one minute on warm instances.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {ORGANIZATION_FEATURES.map(feature => {
          const id = `organization-feature-${feature}`;
          return (
            <div key={feature} className="flex flex-col gap-2">
              <Label htmlFor={id}>{ORGANIZATION_FEATURE_DESCRIPTIONS[feature].label}</Label>
              <p id={`${id}-description`} className="text-muted-foreground text-xs">
                {ORGANIZATION_FEATURE_DESCRIPTIONS[feature].description} Feature key:{' '}
                <code>{feature}</code>.
              </p>
              <Textarea
                id={id}
                aria-describedby={`${id}-description`}
                placeholder="00000000-0000-0000-0000-000000000000"
                value={values[feature]}
                onChange={e => {
                  setValues({ ...values, [feature]: e.target.value });
                  setValidationError(null);
                  setHasChanges(true);
                }}
                rows={4}
                className="font-mono text-sm"
              />
            </div>
          );
        })}

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
      </CardContent>
    </Card>
  );
}
