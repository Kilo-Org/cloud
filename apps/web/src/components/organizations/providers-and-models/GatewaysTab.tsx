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
    <div className="space-y-6">
      {settings.features.gateway_disable_toggles && (
        <Card>
          <CardHeader>
            <CardTitle>Gateways</CardTitle>
            <CardDescription>
              Kilo routes model requests through OpenRouter or the Vercel AI Gateway. Chat requests
              that would be routed through a disabled gateway fail with an error.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>
      )}

      {settings.features.data_region && (
        <Card>
          <CardHeader>
            <CardTitle>Data region</CardTitle>
            <CardDescription>
              Pins chat requests routed through OpenRouter or the Vercel AI Gateway to the selected
              region. Requests for a model that is not available in the region fail with an error.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-sm space-y-2">
              <Label htmlFor={`${id}-region`}>Region</Label>
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
                <SelectTrigger id={`${id}-region`} className="min-h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GLOBAL_REGION} className="min-h-11">
                    Global
                  </SelectItem>
                  <SelectItem value="eu" className="min-h-11">
                    EU
                  </SelectItem>
                  <SelectItem value="us" className="min-h-11">
                    US
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      {!canEdit && (
        <p className="text-muted-foreground text-sm">
          Only organization owners and admins can change gateway settings.
        </p>
      )}
    </div>
  );
}
