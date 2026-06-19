'use client';

import {
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

type ModeSelection = AutoRoutingMode | 'inherit';

const modeOptions: Array<{ value: AutoRoutingMode; label: string; description: string }> = [
  {
    value: 'cost_per_accuracy',
    label: 'Best accuracy per dollar',
    description:
      'Chooses the model that passes the accuracy threshold and delivers the best accuracy per dollar.',
  },
  {
    value: 'best_accuracy',
    label: 'Best accuracy',
    description: 'Chooses the highest-accuracy model in the efficient model pool.',
  },
];

function unsetModeOption(organizationId: string | undefined) {
  return organizationId
    ? {
        value: 'inherit' as const,
        label: 'No organization override',
        description: "Uses the member's personal setting, then the default.",
      }
    : {
        value: 'inherit' as const,
        label: 'Use default setting',
        description: 'Uses best accuracy per dollar.',
      };
}

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

async function saveMode(organizationId: string | undefined, mode: AutoRoutingMode | null) {
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
  const [selectedMode, setSelectedMode] = useState<ModeSelection>('inherit');
  const currentSelection: ModeSelection = query.data?.configuredMode ?? 'inherit';

  useEffect(() => {
    setSelectedMode(currentSelection);
  }, [currentSelection]);

  const mutation = useMutation({
    mutationFn: (mode: ModeSelection) => saveMode(organizationId, mode === 'inherit' ? null : mode),
    onSuccess: data => {
      queryClient.setQueryData(queryKey, data);
      toast.success('Auto routing mode saved');
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : 'Failed to save auto routing mode');
    },
  });

  const resetOption = unsetModeOption(organizationId);
  const selectedOption =
    selectedMode === 'inherit'
      ? resetOption
      : (modeOptions.find(option => option.value === selectedMode) ?? modeOptions[0]);
  const disabled = readonly || query.isLoading || mutation.isPending;
  const hasChanges = selectedMode !== currentSelection;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="size-5" />
          Auto routing
        </CardTitle>
        <CardDescription>Choose how Kilo ranks models for kilo-auto/efficient.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={organizationId ? 'org-auto-routing-mode' : 'user-auto-routing-mode'}>
            Routing mode
          </Label>
          <Select
            value={selectedMode}
            onValueChange={value =>
              setSelectedMode(value === 'inherit' ? 'inherit' : AutoRoutingModeSchema.parse(value))
            }
            disabled={disabled}
          >
            <SelectTrigger id={organizationId ? 'org-auto-routing-mode' : 'user-auto-routing-mode'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={resetOption.value}>{resetOption.label}</SelectItem>
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
