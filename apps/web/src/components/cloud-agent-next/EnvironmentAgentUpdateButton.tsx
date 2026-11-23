'use client';

import { useId, useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import type { EnvironmentRepository } from '@/hooks/useCloudAgentEnvironments';
import { useEnvironmentSetupEnabled } from '@/hooks/useEnvironmentSetupRuns';
import { EnvironmentSetupModelPicker } from './EnvironmentSetupModelPicker';
import { SETUP_GUIDANCE_MAX_LENGTH, useEnvironmentSetupAgent } from './useEnvironmentSetupAgent';

type UpdateProps = {
  organizationId?: string;
  environmentId: string;
  repositories: EnvironmentRepository[];
  /** The agent starts from the saved environment, so unsaved edits block an update. */
  hasUnsavedChanges: boolean;
  onStarted?: () => void;
};

export function EnvironmentAgentUpdateButton({
  active = true,
  ...props
}: UpdateProps & { active?: boolean }) {
  const access = useEnvironmentSetupEnabled({
    organizationId: props.organizationId,
    enabled: active,
  });
  const [open, setOpen] = useState(false);
  if (access.data?.canStart !== true) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 pointer-coarse:min-h-11"
        >
          <Bot aria-hidden />
          Update with agent
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-4">
        <EnvironmentAgentUpdateForm {...props} onCancel={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function EnvironmentAgentUpdateForm({
  organizationId,
  environmentId,
  repositories,
  hasUnsavedChanges,
  onStarted,
  onCancel,
}: UpdateProps & { onCancel: () => void }) {
  const setup = useEnvironmentSetupAgent({
    organizationId,
    repositories,
    targetEnvironmentId: environmentId,
    onStarted,
  });
  const titleId = useId();
  const descriptionId = useId();

  return (
    <form
      className="space-y-3"
      aria-labelledby={titleId}
      onSubmit={event => {
        event.preventDefault();
        if (!hasUnsavedChanges) void setup.startSetup();
      }}
    >
      <div className="space-y-1">
        <p id={titleId} className="text-sm font-semibold">
          Update with an agent
        </p>
        <p id={descriptionId} className="text-muted-foreground text-xs">
          Describe the change. The agent edits this environment, tests it in a fresh session, and
          saves it.
        </p>
      </div>
      <fieldset disabled={setup.isStarting} className="min-w-0 space-y-3">
        <Textarea
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          value={setup.guidance}
          onChange={event => setup.setGuidance(event.target.value)}
          maxLength={SETUP_GUIDANCE_MAX_LENGTH}
          rows={3}
          placeholder="For example: add Playwright browsers so the end-to-end tests can run."
        />
        <div className="flex flex-wrap gap-2">
          <EnvironmentSetupModelPicker choice={setup.modelChoice} />
        </div>
      </fieldset>
      {hasUnsavedChanges && (
        <p role="note" className="text-muted-foreground text-xs">
          Save your changes first. The agent starts from the saved environment.
        </p>
      )}
      {setup.repositoryError && (
        <p role="alert" className="text-destructive text-xs">
          {setup.repositoryError}
        </p>
      )}
      {setup.error && (
        <Alert variant="destructive">
          <AlertDescription>{setup.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={hasUnsavedChanges || !setup.canStart}>
          {setup.isStarting && <Loader2 className="animate-spin" aria-hidden />}
          {setup.isStarting ? 'Starting update…' : 'Start update'}
        </Button>
      </div>
    </form>
  );
}
