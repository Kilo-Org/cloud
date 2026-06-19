'use client';

import {
  DEFAULT_AUTO_ROUTING_MODE,
  AutoRoutingModeSchema,
  AutoRoutingModeResponseSchema,
  type AutoRoutingMode,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Route } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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

type Props = {
  organizationId?: string;
  readonly?: boolean;
};

const modeOptions: Array<{ value: AutoRoutingMode; label: string; description: string }> = [
  {
    value: 'cost_per_accuracy',
    label: 'Least $/accuracy',
    description: 'Routes to the benchmarked candidate with the lowest cost per accuracy point.',
  },
  {
    value: 'best_accuracy',
    label: 'Best accuracy',
    description: 'Routes to the highest-accuracy benchmarked candidate, regardless of cost.',
  },
];

function endpoint(organizationId: string | undefined): string {
  if (!organizationId) return '/api/auto-routing/mode';
  const params = new URLSearchParams({ organizationId });
  return `/api/auto-routing/mode?${params}`;
}

async function fetchMode(organizationId: string | undefined) {
  const response = await fetch(endpoint(organizationId));
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Failed to load auto routing mode'
    );
  }
  return AutoRoutingModeResponseSchema.parse(body);
}

async function saveMode(organizationId: string | undefined, mode: AutoRoutingMode) {
  const response = await fetch(endpoint(organizationId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : 'Failed to save auto routing mode'
    );
  }
  return AutoRoutingModeResponseSchema.parse(body);
}

export function AutoRoutingModeCard({ organizationId, readonly = false }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ['auto-routing-mode', organizationId ?? 'personal'];
  const query = useQuery({
    queryKey,
    queryFn: () => fetchMode(organizationId),
  });
  const [selectedMode, setSelectedMode] = useState<AutoRoutingMode>(DEFAULT_AUTO_ROUTING_MODE);
  const currentMode = query.data?.mode ?? DEFAULT_AUTO_ROUTING_MODE;

  useEffect(() => {
    setSelectedMode(currentMode);
  }, [currentMode]);

  const mutation = useMutation({
    mutationFn: (mode: AutoRoutingMode) => saveMode(organizationId, mode),
    onSuccess: data => {
      queryClient.setQueryData(queryKey, data);
      toast.success('Auto routing mode saved');
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : 'Failed to save auto routing mode');
    },
  });

  const selectedOption =
    modeOptions.find(option => option.value === selectedMode) ?? modeOptions[0];
  const disabled = readonly || query.isLoading || mutation.isPending;
  const hasChanges = selectedMode !== currentMode;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-5" />
          Auto routing
        </CardTitle>
        <CardDescription>
          Choose how Kilo ranks benchmarked candidates for kilo-auto/efficient.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={organizationId ? 'org-auto-routing-mode' : 'user-auto-routing-mode'}>
            Routing mode
          </Label>
          <Select
            value={selectedMode}
            onValueChange={value => setSelectedMode(AutoRoutingModeSchema.parse(value))}
            disabled={disabled}
          >
            <SelectTrigger id={organizationId ? 'org-auto-routing-mode' : 'user-auto-routing-mode'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modeOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-sm">{selectedOption.description}</p>
        </div>
        {!readonly && (
          <Button
            type="button"
            onClick={() => mutation.mutate(selectedMode)}
            disabled={disabled || !hasChanges}
          >
            {mutation.isPending ? 'Saving...' : 'Save routing mode'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
