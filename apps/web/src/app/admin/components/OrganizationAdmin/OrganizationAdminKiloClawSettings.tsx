'use client';

import { useEffect, useState } from 'react';
import { ServerCog } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useUpdateKiloClawNorthflankRollout } from '@/app/admin/api/organizations/hooks';

export function OrganizationAdminKiloClawSettings({ organizationId }: { organizationId: string }) {
  const { data: organization } = useOrganizationWithMembers(organizationId);
  const mutation = useUpdateKiloClawNorthflankRollout();
  const [enabled, setEnabled] = useState(false);
  const [trafficPercent, setTrafficPercent] = useState('0');

  useEffect(() => {
    if (!organization) return;
    setEnabled(organization.settings?.kiloclaw_northflank_enabled === true);
    setTrafficPercent(String(organization.settings?.kiloclaw_northflank_traffic_percent ?? 0));
  }, [organization]);

  const parsedTrafficPercent = Number(trafficPercent);
  const trafficPercentIsValid =
    Number.isInteger(parsedTrafficPercent) &&
    parsedTrafficPercent >= 0 &&
    parsedTrafficPercent <= 100;

  async function save() {
    if (!trafficPercentIsValid) {
      toast.error('Traffic percent must be an integer between 0 and 100');
      return;
    }

    try {
      await mutation.mutateAsync({
        organizationId,
        kiloclaw_northflank_enabled: enabled,
        kiloclaw_northflank_traffic_percent: parsedTrafficPercent,
      });
      toast.success('KiloClaw Northflank rollout settings updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update rollout settings');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="h-5 w-5" />
          KiloClaw Provider Rollout
        </CardTitle>
        <CardDescription>Control Northflank provisioning for this organization</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={async e => {
            e.preventDefault();
            await save();
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="kiloclaw-northflank-enabled">Enable Northflank</Label>
              <p className="text-muted-foreground text-sm">
                Allow new provisions to use Northflank.
              </p>
            </div>
            <Switch
              id="kiloclaw-northflank-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="kiloclaw-northflank-traffic">Northflank traffic percent</Label>
            <Input
              id="kiloclaw-northflank-traffic"
              type="number"
              min={0}
              max={100}
              step={1}
              value={trafficPercent}
              onChange={e => setTrafficPercent(e.target.value)}
              disabled={mutation.isPending}
            />
            {!trafficPercentIsValid && (
              <p className="text-destructive text-sm">Enter an integer from 0 to 100.</p>
            )}
          </div>

          <Button type="submit" disabled={mutation.isPending || !trafficPercentIsValid}>
            Save rollout settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
