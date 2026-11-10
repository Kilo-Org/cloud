'use client';

import { useId } from 'react';
import type { RepositoryEnvironmentDefaultSetting } from '@kilocode/cloud-agent-profile';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCloudAgentEnvironments,
  type EnvironmentRepository,
} from '@/hooks/useCloudAgentEnvironments';
import { cn } from '@/lib/utils';

type EnvironmentSelectProps = {
  environment: RepositoryEnvironmentDefaultSetting;
  organizationId?: string;
  repository: EnvironmentRepository;
  labelledBy: string;
  disabled: boolean;
  onChange: (environment: RepositoryEnvironmentDefaultSetting) => void;
};

export function EnvironmentSelect({
  environment,
  organizationId,
  repository,
  labelledBy,
  disabled,
  onChange,
}: EnvironmentSelectProps) {
  const helpId = useId();
  const query = useCloudAgentEnvironments({ organizationId, repository });
  const environments = query.data ?? [];
  const environmentId = environment.mode === 'environment' ? environment.environmentId : null;
  const listed = environments.find(environment => environment.id === environmentId);
  const unavailable = environmentId !== null && query.isSuccess && !listed;
  const name =
    environment.mode === 'none'
      ? 'No environment'
      : query.isLoading
        ? 'Loading environments...'
        : environmentId
          ? (listed?.name ?? (query.isError ? 'Saved environment' : 'Unavailable environment'))
          : 'Automatic';

  return (
    <>
      <Select
        value={environmentId ?? environment.mode}
        onValueChange={next =>
          onChange(
            next === 'automatic' || next === 'none'
              ? { mode: next }
              : { mode: 'environment', environmentId: next }
          )
        }
        disabled={disabled || query.isLoading}
      >
        <SelectTrigger
          className="w-full pointer-coarse:min-h-11"
          aria-labelledby={labelledBy}
          aria-describedby={helpId}
          aria-invalid={unavailable || undefined}
        >
          <SelectValue className="min-w-0">
            <span
              className={cn(
                'truncate',
                environment.mode === 'automatic' && 'text-muted-foreground'
              )}
            >
              {name}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="automatic">Automatic</SelectItem>
          <SelectItem value="none">No environment</SelectItem>
          {environmentId && !listed && (
            <SelectItem value={environmentId} disabled>
              {name}
            </SelectItem>
          )}
          {environments.map(environment => (
            <SelectItem key={environment.id} value={environment.id}>
              {environment.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        id={helpId}
        className={cn('text-xs', unavailable ? 'text-destructive' : 'text-muted-foreground')}
      >
        {unavailable ? (
          'This default is unavailable. Choose another environment, No environment, or Automatic.'
        ) : environment.mode === 'none' ? (
          'Sessions use no environment unless one is explicitly selected.'
        ) : query.isError ? (
          <>
            Could not load environments.{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </>
        ) : listed?.sandboxAllocation ? (
          'The environment sandbox takes precedence over the repository sandbox.'
        ) : listed ? (
          'Used for sessions without an environment selection.'
        ) : environments.length === 0 && query.isSuccess ? (
          'No environments contain this repository.'
        ) : (
          'Automatic uses the only matching environment, if there is one.'
        )}
      </p>
    </>
  );
}
