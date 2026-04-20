'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ServerCog } from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function KiloclawProvidersTab() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data, error, isError, isLoading, isFetching, refetch } = useQuery(
    trpc.admin.kiloclawProviders.getRollout.queryOptions()
  );
  const [personalTrafficPercent, setPersonalTrafficPercent] = useState('0');
  const [organizationTrafficPercent, setOrganizationTrafficPercent] = useState('0');
  const [enabledOrganizationIdsText, setEnabledOrganizationIdsText] = useState('');

  useEffect(() => {
    if (!data) return;
    setPersonalTrafficPercent(String(data.rollout.northflank.personalTrafficPercent));
    setOrganizationTrafficPercent(String(data.rollout.northflank.organizationTrafficPercent));
    setEnabledOrganizationIdsText(data.rollout.northflank.enabledOrganizationIds.join('\n'));
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
  const enabledOrganizationIds = Array.from(
    new Set(
      enabledOrganizationIdsText
        .split(/[\n,]/)
        .map(value => value.trim())
        .filter(Boolean)
    )
  );
  const formIsValid = personalTrafficPercentIsValid && organizationTrafficPercentIsValid;
  const northflankAvailable = data?.availability.northflank === true;

  const mutation = useMutation(
    trpc.admin.kiloclawProviders.updateRollout.mutationOptions({
      onSuccess: () => {
        toast.success('KiloClaw provider rollout settings updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawProviders.getRollout.queryKey(),
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
      northflank: {
        personalTrafficPercent: parsedPersonalTrafficPercent,
        organizationTrafficPercent: parsedOrganizationTrafficPercent,
        enabledOrganizationIds,
      },
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
          Control runtime provider targeting for new personal and organization provisions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isError || !data ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Failed to load provider rollout settings</AlertTitle>
            <AlertDescription>
              <p>
                {error instanceof Error
                  ? error.message
                  : 'Provider rollout settings could not be loaded.'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isFetching}
                onClick={() => void refetch()}
              >
                {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Retry'}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <form
            className="max-w-xl space-y-4"
            onSubmit={e => {
              e.preventDefault();
              save();
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Source:</span>
              <Badge variant="outline">{data?.source === 'kv' ? 'KV (runtime)' : 'Default'}</Badge>
            </div>

            {!northflankAvailable && (
              <Alert variant="warning">
                <AlertDescription>
                  Northflank rollout is not available until Worker provider support is deployed. You
                  can save percentages and organization opt-ins now, but runtime selection will stay
                  on Fly.
                </AlertDescription>
              </Alert>
            )}

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

            <div className="space-y-2">
              <Label htmlFor="kiloclaw-northflank-enabled-organizations">
                Northflank-enabled organization IDs
              </Label>
              <Textarea
                id="kiloclaw-northflank-enabled-organizations"
                value={enabledOrganizationIdsText}
                onChange={e => setEnabledOrganizationIdsText(e.target.value)}
                disabled={mutation.isPending}
                placeholder="One organization ID per line, or comma-separated"
              />
              <p className="text-muted-foreground text-sm">
                Organization rollout only applies to these opted-in organizations. Parsed IDs:{' '}
                {enabledOrganizationIds.length}
              </p>
            </div>

            <Button type="submit" disabled={mutation.isPending || !formIsValid}>
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Save rollout settings'
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
