'use client';

import {
  AutoRoutingModeResponseSchema,
  AutoRoutingModeSchema,
  type AutoRoutingMode,
  type AutoRoutingModeResponse,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Route } from 'lucide-react';
import React, { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { MODE_OPTIONS } from './custom-router-display';

type Props = {
  organizationId?: string;
  readonly?: boolean;
};

type ModeSelection = AutoRoutingMode | 'inherit';

async function readModeResponse(response: Response): Promise<AutoRoutingModeResponse> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (HTTP ${response.status})`
    );
  }
  const parsed = AutoRoutingModeResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('Invalid routing mode response. Try again.');
  return parsed.data;
}

export function AutoRoutingModeCard({ organizationId, readonly = false }: Props) {
  const id = useId();
  const queryClient = useQueryClient();
  const endpoint = organizationId
    ? `/api/auto-routing/mode?${new URLSearchParams({ organizationId })}`
    : '/api/auto-routing/mode';
  const [draft, setDraft] = useState<{ endpoint: string; mode: ModeSelection }>();
  const query = useQuery({
    queryKey: ['auto-routing-mode', organizationId ?? 'personal'],
    queryFn: async () => readModeResponse(await fetch(endpoint)),
  });
  const savedMode = query.data?.configuredMode ?? 'inherit';
  const selectedMode = draft?.endpoint === endpoint ? draft.mode : savedMode;
  const saveMutation = useMutation({
    mutationFn: async (mode: ModeSelection) =>
      readModeResponse(
        await fetch(endpoint, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode === 'inherit' ? null : mode }),
        })
      ),
    onSuccess: data => {
      const ownerOrganizationId = data.ownerType === 'org' ? data.ownerId : undefined;
      queryClient.setQueryData(['auto-routing-mode', ownerOrganizationId ?? 'personal'], data);
      setDraft(undefined);
    },
  });
  const inheritLabel = organizationId ? 'No organization override' : 'Use default setting';
  const modeDescription =
    selectedMode === 'inherit'
      ? organizationId
        ? "Uses each member's personal mode, then the default."
        : `Uses the default: ${MODE_OPTIONS.find(option => option.value === query.data?.defaultMode)?.label ?? 'Best accuracy per dollar'}.`
      : selectedMode === 'best_accuracy'
        ? 'Chooses the highest-accuracy model in the platform pool.'
        : 'Chooses the model that passes the accuracy threshold and delivers the best accuracy per dollar.';

  return (
    <Card className="w-full" id={`platform-routing-mode-${organizationId ? 'org' : 'user'}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-5" aria-hidden />
          Platform routing mode
        </CardTitle>
        <CardDescription>
          Kilo chooses the model pools for Efficient and Frontier. You choose Best accuracy per
          dollar or Best accuracy. This mode applies to both platform routers, not custom routers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <div aria-busy="true" aria-label="Loading platform routing mode">
            <Skeleton className="h-11 w-full sm:max-w-sm" />
          </div>
        ) : query.data ? (
          <>
            <div className="max-w-sm space-y-2">
              <Label htmlFor={id}>Routing mode</Label>
              <Select
                value={selectedMode}
                disabled={readonly || saveMutation.isPending}
                onValueChange={value => {
                  setDraft({
                    endpoint,
                    mode: value === 'inherit' ? value : AutoRoutingModeSchema.parse(value),
                  });
                  saveMutation.reset();
                }}
              >
                <SelectTrigger id={id} aria-describedby={`${id}-help`} className="min-h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit" className="min-h-11">
                    {inheritLabel}
                  </SelectItem>
                  {MODE_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value} className="min-h-11">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id={`${id}-help`} className="text-muted-foreground text-sm">
                {modeDescription}
              </p>
            </div>
            <p className="text-muted-foreground text-sm">
              {organizationId
                ? 'An organization mode overrides personal modes for organization requests.'
                : 'An organization mode takes precedence when you make organization requests.'}
            </p>
            {readonly ? (
              <p className="text-muted-foreground text-sm">
                Only organization owners, admins, and billing managers can change this mode.
              </p>
            ) : (
              <Button
                type="button"
                className="min-h-11"
                disabled={saveMutation.isPending || selectedMode === savedMode}
                onClick={() => saveMutation.mutate(selectedMode)}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save mode'}
              </Button>
            )}
          </>
        ) : null}
        {query.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load platform routing mode</AlertTitle>
            <AlertDescription>
              <p>{query.error.message}</p>
              <Button
                type="button"
                variant="secondary"
                className="min-h-11"
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {saveMutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not save platform routing mode</AlertTitle>
            <AlertDescription>
              {saveMutation.error.message} Your changes are not saved.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
