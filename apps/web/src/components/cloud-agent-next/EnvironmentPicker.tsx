'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { AlertCircle, Boxes, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useCloudAgentEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import {
  environmentIdentityKey,
  resolveEnvironmentSelection,
  type EnvironmentListStatus,
} from './environment-selection';
import { formatEnvironmentCounts } from './environment-display';
import { selectedEnvironmentAtom } from '@/components/cloud-agent/store/session-form-atoms';

type EnvironmentPickerProps = {
  organizationId?: string;
  repository: EnvironmentRepository | undefined;
};

/** Selects the environment a session uses. Management lives in Cloud agent settings. */
export function EnvironmentPicker({ organizationId, repository }: EnvironmentPickerProps) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useAtom(selectedEnvironmentAtom);

  const { data, isLoading, isError, refetch } = useCloudAgentEnvironments({
    organizationId,
    repository,
  });

  const identity = useMemo(
    () =>
      repository ? `${organizationId ?? 'personal'}:${environmentIdentityKey(repository)}` : null,
    [organizationId, repository]
  );
  const status: EnvironmentListStatus = isError ? 'error' : isLoading ? 'loading' : 'success';

  const selectEnvironment = (id: string | null) => {
    setSelection({ id, identity });
  };

  useEffect(() => {
    const next = resolveEnvironmentSelection(selection, {
      identity,
      environments: data,
      status,
    });
    if (next.id !== selection.id || next.identity !== selection.identity) setSelection(next);
  }, [identity, data, status, selection, setSelection]);

  const selectedEnvironment = data?.find(environment => environment.id === selection.id);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={!repository}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            'border border-border/50 bg-muted/30 hover:bg-muted/60 hover:border-border',
            'text-muted-foreground hover:text-foreground',
            open && 'border-border bg-muted/60 text-foreground',
            !repository && 'cursor-not-allowed opacity-50 hover:bg-muted/30'
          )}
        >
          <Boxes className="h-3 w-3 shrink-0" />
          <span className="font-medium">
            {selectedEnvironment?.name ??
              (selection.id ? 'Selected environment' : 'No environment')}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-3" align="end" sideOffset={6}>
        {isLoading ? (
          <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading environments…
          </div>
        ) : isError && !data ? (
          <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-xs">
            <p className="text-destructive flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" />
              Could not load environments.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <p className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
              Environment
            </p>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              <EnvironmentRow
                label="No environment"
                isSelected={!selection.id}
                onSelect={() => selectEnvironment(null)}
              />
              {data?.map(environment => (
                <EnvironmentRow
                  key={environment.id}
                  label={environment.name}
                  meta={formatEnvironmentCounts(environment)}
                  isSelected={environment.id === selection.id}
                  onSelect={() => selectEnvironment(environment.id)}
                />
              ))}
            </div>

            {data && data.length === 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                No environments for this repository.
              </p>
            )}

            <p className="text-muted-foreground mt-3 border-t pt-2 text-xs">
              Create and edit environments in Cloud agent settings.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

type EnvironmentRowProps = {
  label: string;
  meta?: string;
  isSelected: boolean;
  onSelect: () => void;
};

function EnvironmentRow({ label, meta, isSelected, onSelect }: EnvironmentRowProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        'hover:bg-accent text-left',
        isSelected && 'text-foreground'
      )}
      onClick={onSelect}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {isSelected && <Check className="text-primary h-3 w-3" />}
      </span>
      <span className={cn('flex-1 truncate', isSelected ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      {meta && <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>}
    </button>
  );
}
