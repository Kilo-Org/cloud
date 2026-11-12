'use client';

import { useEffect, useId } from 'react';
import { ArrowRight, ChevronRight, Loader2, Terminal } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { EnvironmentRepositoryChips } from './EnvironmentRepositoriesField';
import { EnvironmentSetupModelPicker } from './EnvironmentSetupModelPicker';
import { SETUP_GUIDANCE_MAX_LENGTH, useEnvironmentSetupAgent } from './useEnvironmentSetupAgent';

const GUIDANCE_SUGGESTIONS = [
  {
    label: 'Install dependencies only',
    text: 'Install the dependencies only. Do not start services or run tests.',
  },
  {
    label: 'Match my CI workflow',
    text: 'Use the same setup as the CI workflow in the repository.',
  },
  {
    label: 'Dev server and tests',
    text: 'Prepare the local dev server and make the unit tests pass.',
  },
];

/** Starts agent setup for a new environment, with a way out to manual configuration. */
export function EnvironmentSetupComposer({
  organizationId,
  repositories,
  onRepositoriesChange,
  onConfigureManually,
  onStarted,
  onDirtyChange,
  onStartingChange,
}: {
  organizationId?: string;
  repositories: EnvironmentRepository[];
  onRepositoriesChange: (repositories: EnvironmentRepository[]) => void;
  onConfigureManually: () => void;
  onStarted?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onStartingChange?: (starting: boolean) => void;
}) {
  const setup = useEnvironmentSetupAgent({ organizationId, repositories, onStarted });
  const headingId = useId();
  const helpId = useId();
  const dirty = setup.guidance.trim().length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onStartingChange?.(setup.isStarting);
  }, [setup.isStarting, onStartingChange]);

  const addSuggestion = (text: string) => {
    setup.setGuidance(current => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
  };

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void setup.startSetup();
      }}
      className="mx-auto flex w-full max-w-xl flex-col gap-4"
    >
      <div className="space-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          What should this environment run?
        </h2>
        <p className="text-muted-foreground text-sm">
          An agent reads your repositories, writes the setup, asks for missing secrets, and tests it
          in a fresh session before it saves.
        </p>
      </div>

      <fieldset
        disabled={setup.isStarting}
        className="bg-muted/30 focus-within:ring-ring flex min-w-0 flex-col gap-2 rounded-lg border p-3 focus-within:ring-2"
      >
        <EnvironmentRepositoryChips
          organizationId={organizationId}
          repositories={repositories}
          onChange={onRepositoriesChange}
        />
        <textarea
          aria-labelledby={headingId}
          aria-describedby={helpId}
          value={setup.guidance}
          onChange={event => setup.setGuidance(event.target.value)}
          maxLength={SETUP_GUIDANCE_MAX_LENGTH}
          rows={4}
          placeholder="For example: run the API with Postgres and make the unit tests pass."
          className="placeholder:text-muted-foreground max-h-[40dvh] w-full resize-none border-0 bg-transparent py-1 text-base outline-none md:text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <EnvironmentSetupModelPicker choice={setup.modelChoice} disabled={setup.isStarting} />
          <Button type="submit" size="sm" className="ml-auto" disabled={!setup.canStart}>
            {setup.isStarting ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <ArrowRight aria-hidden />
            )}
            {setup.isStarting ? 'Starting setup…' : 'Start setup'}
          </Button>
        </div>
      </fieldset>
      <p id={helpId} className="text-muted-foreground -mt-2 text-xs">
        Optional. Leave blank to let the agent choose the setup from your repositories.
      </p>

      <div className="flex flex-wrap gap-2" aria-label="Guidance suggestions" role="group">
        {GUIDANCE_SUGGESTIONS.map(suggestion => (
          <Button
            key={suggestion.label}
            type="button"
            variant="outline"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 rounded-full px-3 text-xs pointer-coarse:min-h-11"
            disabled={setup.isStarting}
            onClick={() => addSuggestion(suggestion.text)}
          >
            {suggestion.label}
          </Button>
        ))}
      </div>

      {setup.repositoryError && (
        <p role="alert" className="text-destructive text-sm">
          {setup.repositoryError} Add a GitHub repository first, or configure the environment
          manually.
        </p>
      )}
      {setup.error && (
        <Alert variant="destructive">
          <AlertDescription>{setup.error}</AlertDescription>
        </Alert>
      )}

      <div
        className="text-muted-foreground before:bg-border after:bg-border flex items-center gap-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1"
        aria-hidden
      >
        or
      </div>
      <button
        type="button"
        disabled={setup.isStarting}
        onClick={onConfigureManually}
        className="hover:bg-accent focus-visible:ring-ring flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Terminal className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Configure manually</span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            Write the snapshot build script, the workspace start script, and the variables yourself.
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
      </button>
    </form>
  );
}
