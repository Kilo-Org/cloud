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
import { OrganizationDataRegionSchema } from '@kilocode/db/schema-types';
import { ORGANIZATION_DATA_REGION_NAMES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

type GatewaySettings =
  inferRouterOutputs<RootRouter>['organizations']['settings']['getGatewaySettings'];

type Props = {
  organizationId: string;
  canEdit: boolean;
  settings: GatewaySettings;
};

const GLOBAL_REGION = 'global';

export function GatewaysTab({ organizationId, canEdit, settings }: Props) {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mutation = useMutation(
    trpc.organizations.settings.updateGatewaySettings.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.settings.getGatewaySettings.queryKey({ organizationId }),
        });
        toast.success('Gateway settings saved');
      },
      onError: error => {
        toast.error(`Could not save gateway settings: ${error.message}`);
      },
    })
  );
  const disabled = !canEdit || mutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateways</CardTitle>
        <CardDescription>
          Kilo routes chat requests through the Vercel AI Gateway or OpenRouter. When the Vercel AI
          Gateway is off, chat requests Kilo would send there go through OpenRouter instead. Chat
          requests that still end up on a disabled gateway fail with an error. These settings do not
          apply to embeddings yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-vercel`}
              checked={!settings.disable_vercel_ai_gateway}
              disabled={disabled}
              onCheckedChange={checked =>
                mutation.mutate({ organizationId, disable_vercel_ai_gateway: !checked })
              }
            />
            <Label htmlFor={`${id}-vercel`}>Vercel AI Gateway</Label>
          </div>
          {!settings.disable_vercel_ai_gateway && (
            <div className="ml-12 max-w-sm space-y-2">
              <Label htmlFor={`${id}-region`}>Inference region</Label>
              <Select
                value={settings.data_region ?? GLOBAL_REGION}
                disabled={disabled}
                onValueChange={value =>
                  mutation.mutate({
                    organizationId,
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
                Pins chat requests routed through the Vercel AI Gateway to this region. Requests for
                a model that is not available in the region fail with an error.
              </p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-openrouter`}
              checked={!settings.disable_openrouter}
              disabled={disabled}
              onCheckedChange={checked =>
                mutation.mutate({ organizationId, disable_openrouter: !checked })
              }
            />
            <Label htmlFor={`${id}-openrouter`}>OpenRouter</Label>
          </div>
          <p className="text-muted-foreground ml-12 text-sm">
            OpenRouter requests are not pinned to a region.
          </p>
        </div>

        <p className="text-muted-foreground text-sm">
          Disabling a gateway also blocks BYOK keys that route chat requests through it: a Vercel AI
          Gateway or OpenRouter key, and provider keys Kilo sends through the Vercel AI Gateway.
          Chat requests that would use those keys fail instead of falling back.
        </p>

        {!canEdit && (
          <p className="text-muted-foreground text-sm">
            Only organization owners and admins can change gateway settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
