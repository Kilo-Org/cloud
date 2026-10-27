'use client';

import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/lib/trpc/utils';

type Props = {
  organizationId: string;
  readonly: boolean;
};

export function OrganizationGuardrailScanningCard({ organizationId, readonly }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queryKey = trpc.organizations.settings.getEnkryptShadowGuardrails.queryKey({
    organizationId,
  });
  const { data } = useQuery(
    trpc.organizations.settings.getEnkryptShadowGuardrails.queryOptions({ organizationId })
  );
  const update = useMutation(
    trpc.organizations.settings.updateEnkryptShadowGuardrails.mutationOptions({
      onSuccess: (_result, { enabled }) => {
        toast.success(enabled ? 'Guardrail scanning turned on' : 'Guardrail scanning turned off');
        void queryClient.invalidateQueries({ queryKey });
      },
      onError: error => {
        toast.error(error.message || 'Could not update guardrail scanning. Try again.');
      },
    })
  );

  if (!data?.available) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <ShieldCheck className="mr-2 inline h-5 w-5" />
          Guardrail scanning
        </CardTitle>
        <CardDescription>
          After each chat response, send the new prompt, tool results, and response to Enkrypt AI
          for prompt-injection, PII, secret, and toxicity detection. Scans never block or delay
          requests, and each scan uses organization credits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label className="flex cursor-pointer items-center gap-2">
          <Switch
            checked={data.enabled}
            disabled={readonly || update.isPending}
            onCheckedChange={enabled => update.mutate({ organizationId, enabled })}
          />
          <span>Scan chat traffic in shadow mode</span>
        </Label>
        {readonly && (
          <p className="text-muted-foreground text-xs">
            Only organization owners and admins can change guardrail scanning.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
