'use client';

import { useId } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { inferRouterOutputs } from '@trpc/server';
import { useTRPC } from '@/lib/trpc/utils';
import type { RootRouter } from '@/routers/root-router';
import {
  OrganizationDataRegionSchema,
  type OrganizationDataRegion,
} from '@kilocode/db/schema-types';
import { ORGANIZATION_DATA_REGION_NAMES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

type GatewaySettings =
  inferRouterOutputs<RootRouter>['organizations']['settings']['getGatewaySettings'];

type Props = {
  organizationId: string;
  canEdit: boolean;
  settings: GatewaySettings;
};

const GLOBAL_REGION = 'global';

export function AdvancedPoliciesTab({ organizationId, canEdit, settings }: Props) {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mutationCallbacks = {
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: trpc.organizations.settings.getGatewaySettings.queryKey({ organizationId }),
      });
      toast.success('Advanced policies saved');
    },
    onError: (error: { message: string }) => {
      toast.error(`Could not save advanced policies: ${error.message}`);
    },
  };
  const mutation = useMutation(
    trpc.organizations.settings.updateGatewaySettings.mutationOptions(mutationCallbacks)
  );
  const newModelsMutation = useMutation(
    trpc.organizations.settings.updateNewModelsPolicy.mutationOptions(mutationCallbacks)
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>New models</CardTitle>
          <CardDescription>
            Control whether models that become available to your organization can be used right
            away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex min-h-11 items-center gap-3">
              <Switch
                id={`${id}-new-models`}
                checked={settings.disable_new_models}
                disabled={!canEdit || newModelsMutation.isPending}
                aria-describedby={`${id}-new-models-help`}
                onCheckedChange={checked =>
                  newModelsMutation.mutate({ organizationId, disable_new_models: checked })
                }
              />
              <Label htmlFor={`${id}-new-models`}>Disable new models by default</Label>
            </div>
            <p id={`${id}-new-models-help`} className="text-muted-foreground ml-12 text-sm">
              {settings.disable_new_models
                ? 'Models that become available, such as newly released models or models an enabled provider starts serving, are added to the disabled models on the Models tab and recorded in the audit log. Enable them on the Models tab.'
                : 'Models that become available from enabled providers can be used right away. Turn this on to disable them until an admin enables them on the Models tab.'}
            </p>
          </div>
        </CardContent>
      </Card>

      {settings.available && (
        <GatewayPoliciesCard
          id={id}
          settings={settings}
          disabled={!canEdit || mutation.isPending}
          onChange={input => mutation.mutate({ organizationId, ...input })}
        />
      )}

      {!canEdit && (
        <p className="text-muted-foreground text-sm">
          Only organization owners and admins can change advanced policies.
        </p>
      )}
    </div>
  );
}

function GatewayPoliciesCard({
  id,
  settings,
  disabled,
  onChange,
}: {
  id: string;
  settings: GatewaySettings;
  disabled: boolean;
  onChange: (
    input: { disable_openrouter: boolean } | { data_region: OrganizationDataRegion | null }
  ) => void;
}) {
  const regionName = settings.data_region
    ? ORGANIZATION_DATA_REGION_NAMES[settings.data_region]
    : null;
  // OpenRouter cannot keep requests in a region, so a region turns it off.
  const openRouterOn = !regionName && !settings.disable_openrouter;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request routing</CardTitle>
        <CardDescription>
          Control where requests paid with Kilo credits are processed. Kilo sends these requests
          through the Vercel AI Gateway or OpenRouter.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="max-w-md space-y-2">
          <Label htmlFor={`${id}-region`}>Inference region</Label>
          <Select
            value={settings.data_region ?? GLOBAL_REGION}
            disabled={disabled}
            onValueChange={value =>
              onChange({
                data_region:
                  value === GLOBAL_REGION ? null : OrganizationDataRegionSchema.parse(value),
              })
            }
          >
            <SelectTrigger
              id={`${id}-region`}
              aria-describedby={`${id}-region-help`}
              className="min-h-11 w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GLOBAL_REGION} className="min-h-11">
                Global
              </SelectItem>
              {OrganizationDataRegionSchema.options.map(region => (
                <SelectItem key={region} value={region} className="min-h-11">
                  {ORGANIZATION_DATA_REGION_NAMES[region]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={`${id}-region-help`} className="text-muted-foreground text-sm">
            Keeps model inference in the selected region. Requests run only through the Vercel AI
            Gateway, in that region. A model that is not available there returns an error instead of
            running elsewhere.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex min-h-11 items-center gap-3">
            <Switch
              id={`${id}-openrouter`}
              checked={openRouterOn}
              disabled={disabled || !!regionName}
              aria-describedby={`${id}-openrouter-help`}
              onCheckedChange={checked => onChange({ disable_openrouter: !checked })}
            />
            <Label htmlFor={`${id}-openrouter`}>Allow OpenRouter</Label>
          </div>
          <p id={`${id}-openrouter-help`} className="text-muted-foreground ml-12 text-sm">
            {regionName
              ? 'OpenRouter is off while an inference region is selected, because it cannot keep requests in a region.'
              : 'When off, requests with Kilo credits do not go through OpenRouter. Models that require OpenRouter will return an error.'}
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">What these policies do not cover</h3>
          <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
            <li>
              Requests that use your organization&apos;s own API keys (BYOK), including OpenRouter
              and Vercel AI Gateway keys. Your provider contract applies to those.
            </li>
            <li>Autocomplete requests go directly to their model providers.</li>
            <li>
              Which models members see. Model lists stay the same, so a model may appear in the list
              and still return an error under these policies.
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Requests that need OpenRouter</h3>
          <p className="text-muted-foreground text-sm">
            Voice transcription and requests with a per-request spending limit run only through
            OpenRouter. While OpenRouter is off or an inference region is selected, they return an
            error unless they use your organization&apos;s own OpenRouter key.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
