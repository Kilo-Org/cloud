'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ServerCog } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

export function KiloclawProvidersTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(
    trpc.admin.kiloclawProviders.get.queryOptions({ provider: 'northflank' })
  );
  const [enabled, setEnabled] = useState(false);
  const [personalTrafficPercent, setPersonalTrafficPercent] = useState('0');
  const [organizationTrafficPercent, setOrganizationTrafficPercent] = useState('0');

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setPersonalTrafficPercent(String(data.personalTrafficPercent));
    setOrganizationTrafficPercent(String(data.organizationTrafficPercent));
  }, [data]);

  const parsedPersonalTrafficPercent = Number(personalTrafficPercent);
  const parsedOrganizationTrafficPercent = Number(organizationTrafficPercent);
  const personalTrafficPercentIsValid =
    Number.isInteger(parsedPersonalTrafficPercent) &&
    parsedPersonalTrafficPercent >= 0 &&
    parsedPersonalTrafficPercent <= 100;
  const organizationTrafficPercentIsValid =
    Number.isInteger(parsedOrganizationTrafficPercent) &&
    parsedOrganizationTrafficPercent >= 0 &&
    parsedOrganizationTrafficPercent <= 100;
  const formIsValid = personalTrafficPercentIsValid && organizationTrafficPercentIsValid;

  const mutation = useMutation(
    trpc.admin.kiloclawProviders.update.mutationOptions({
      onSuccess: () => {
        toast.success('KiloClaw provider rollout settings updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawProviders.get.queryKey({ provider: 'northflank' }),
        });
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  function save() {
    if (!formIsValid) {
      toast.error('Traffic percentages must be integers between 0 and 100');
      return;
    }

    mutation.mutate({
      provider: 'northflank',
      enabled,
      personalTrafficPercent: parsedPersonalTrafficPercent,
      organizationTrafficPercent: parsedOrganizationTrafficPercent,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="h-5 w-5" />
          KiloClaw Provider Rollout
        </CardTitle>
        <CardDescription>
          Control global Northflank targeting for new personal and organization provisions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-xl space-y-4"
          onSubmit={e => {
            e.preventDefault();
            save();
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="kiloclaw-northflank-enabled">Enable Northflank</Label>
              <p className="text-muted-foreground text-sm">
                Allow new provisions to target Northflank when their rollout bucket matches.
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
            <Label htmlFor="kiloclaw-northflank-personal-traffic">Personal traffic percent</Label>
            <Input
              id="kiloclaw-northflank-personal-traffic"
              type="number"
              min={0}
              max={100}
              step={1}
              value={personalTrafficPercent}
              onChange={e => setPersonalTrafficPercent(e.target.value)}
              disabled={mutation.isPending}
            />
            {!personalTrafficPercentIsValid && (
              <p className="text-destructive text-sm">Enter an integer from 0 to 100.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="kiloclaw-northflank-organization-traffic">
              Organization traffic percent
            </Label>
            <Input
              id="kiloclaw-northflank-organization-traffic"
              type="number"
              min={0}
              max={100}
              step={1}
              value={organizationTrafficPercent}
              onChange={e => setOrganizationTrafficPercent(e.target.value)}
              disabled={mutation.isPending}
            />
            {!organizationTrafficPercentIsValid && (
              <p className="text-destructive text-sm">Enter an integer from 0 to 100.</p>
            )}
          </div>

          <Button type="submit" disabled={mutation.isPending || !formIsValid}>
            Save rollout settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
