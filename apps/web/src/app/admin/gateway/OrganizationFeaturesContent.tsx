'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ORGANIZATION_FEATURES,
  ORGANIZATION_FEATURE_DESCRIPTIONS,
  DEFAULT_ORGANIZATION_FEATURES,
  OrganizationFeaturesInputSchema,
  type OrganizationFeature,
  type OrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { formatZodError } from '@/lib/zod/format-zod-error';

type FeatureValues = Record<OrganizationFeature, string>;

function toFeatureValues(features: OrganizationFeatures): FeatureValues {
  return {
    experimental_byok: features.experimental_byok.join('\n'),
    enkrypt_output_guardrail: features.enkrypt_output_guardrail.join('\n'),
    gateway_settings: features.gateway_settings.join('\n'),
    request_logs: features.request_logs.join('\n'),
  };
}

function parseOrganizationIds(value: string): string[] {
  return value
    .split('\n')
    .map(id => id.trim())
    .filter(id => id !== '');
}

function OrganizationFeaturesPreview({
  values,
  hasChanges,
}: {
  values: FeatureValues;
  hasChanges: boolean;
}) {
  const trpc = useTRPC();
  const parsed = OrganizationFeaturesInputSchema.safeParse({
    experimental_byok: parseOrganizationIds(values.experimental_byok),
    enkrypt_output_guardrail: parseOrganizationIds(values.enkrypt_output_guardrail),
    gateway_settings: parseOrganizationIds(values.gateway_settings),
    request_logs: parseOrganizationIds(values.request_logs),
  });
  const features = parsed.success ? parsed.data : DEFAULT_ORGANIZATION_FEATURES;
  const hasOrganizations = ORGANIZATION_FEATURES.some(feature => features[feature].length > 0);
  const { data, isPending, error, refetch } = useQuery(
    trpc.admin.gatewayConfig.previewOrganizationFeatures.queryOptions(features, {
      enabled: parsed.success && hasOrganizations,
    })
  );
  const organizationsById = new Map(data?.map(organization => [organization.id, organization]));

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Organization preview</CardTitle>
          <Badge variant="secondary">
            {hasChanges ? 'Unsaved changes' : 'Stored configuration'}
          </Badge>
        </div>
        <CardDescription>
          Organizations in the editor. Editing updates this preview without saving.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {!parsed.success ? (
          <p className="text-muted-foreground text-sm" role="status">
            Enter valid organization IDs to see the preview. Each feature supports up to 1,000 IDs.
          </p>
        ) : hasOrganizations && error ? (
          <div className="flex flex-col items-start gap-2 text-sm" role="alert">
            <p className="text-destructive">Could not load organization names: {error.message}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : hasOrganizations && isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading organization names...
          </p>
        ) : (
          ORGANIZATION_FEATURES.map(feature => (
            <section key={feature} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">
                {ORGANIZATION_FEATURE_DESCRIPTIONS[feature].label}{' '}
                <span className="text-muted-foreground">({features[feature].length})</span>
              </h3>
              {features[feature].length === 0 ? (
                <p className="text-muted-foreground text-sm">No organizations enabled.</p>
              ) : (
                <ul className="max-h-80 space-y-3 overflow-y-auto rounded-md border p-3">
                  {features[feature].map(id => {
                    const organization = organizationsById.get(id);
                    return (
                      <li key={id} className="flex min-w-0 flex-col gap-1 text-sm">
                        {organization ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              href={`/admin/organizations/${id}`}
                              className="min-w-0 break-words underline underline-offset-4"
                            >
                              {organization.name}
                            </Link>
                            {organization.isDeleted && <Badge variant="destructive">Deleted</Badge>}
                          </div>
                        ) : (
                          <span className="text-destructive">Organization not found</span>
                        )}
                        <code className="text-muted-foreground break-all text-xs">{id}</code>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function OrganizationFeaturesContent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery(
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
        setHasChanges(false);
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

  if (isLoading || (data && !values)) {
    return <div className="text-muted-foreground py-8 text-sm">Loading...</div>;
  }

  if (!values) {
    return (
      <div className="flex flex-col items-start gap-2 py-8 text-sm" role="alert">
        <p className="text-destructive">
          Could not load organization features{error ? `: ${error.message}` : '.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  function handleSave() {
    if (!values) return;
    const parsed = OrganizationFeaturesInputSchema.safeParse({
      experimental_byok: parseOrganizationIds(values.experimental_byok),
      enkrypt_output_guardrail: parseOrganizationIds(values.enkrypt_output_guardrail),
      gateway_settings: parseOrganizationIds(values.gateway_settings),
      request_logs: parseOrganizationIds(values.request_logs),
    });
    if (!parsed.success) {
      setValidationError(formatZodError(parsed.error));
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data);
  }

  return (
    <div className="grid w-full gap-6 xl:grid-cols-2 xl:items-start">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Organization Features</CardTitle>
          <CardDescription>
            These features are experimental. Enable gateway features for specific organizations.
            Stored under <code>organization_features</code> in the <code>config</code> column of{' '}
            <code>ai_gateway_config</code>. Enter one organization ID per line. Gateway requests
            pick up changes within one minute on warm instances.
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
      <OrganizationFeaturesPreview values={values} hasChanges={hasChanges} />
    </div>
  );
}
