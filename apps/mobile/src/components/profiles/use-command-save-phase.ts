import { useCallback } from 'react';

import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { readTrpcErrorField } from '@/lib/trpc-error';

import {
  type KiloCommandCreatePayload,
  type KiloCommandSource,
  type KiloCommandUpdatePayload,
} from '@/components/profiles/profile-kilo-commands-model';
import { type KiloCommandSaveFailure } from '@/components/profiles/kilo-command-form-sheet';

/** The admission and failure key of the add form: no command exists yet to name it. */
export const ADD_FORM_KEY = 'new';

/** One save this screen can start: a create, or an update of the command it edits. */
type CommandSaveIntent =
  | { readonly kind: 'create'; readonly payload: KiloCommandCreatePayload }
  | {
      readonly kind: 'update';
      readonly target: KiloCommandSource;
      readonly payload: KiloCommandUpdatePayload;
    };

/** The two section mutations a save runs, resolved to their settled values. */
type SaveRunners = Readonly<{
  create: (payload: KiloCommandCreatePayload) => Promise<void>;
  update: (commandId: string, payload: KiloCommandUpdatePayload) => Promise<void>;
}>;

/** What a save needs from the form that owns it. */
type SaveOwner = Readonly<{
  /** The resource key its admission is filed under. */
  key: string;
  /** Bumped by every open and close, so a settle can tell it is stale. */
  generation: () => number;
  isCurrent: (generation: number) => boolean;
}>;

/** What one command's save reports, keyed by the resource and never reset while pending. */
export type CommandSavePhase = Readonly<{
  isSaving: boolean;
  failure: KiloCommandSaveFailure | null;
  saveCommand: (intent: CommandSaveIntent, onSaved: () => void) => Promise<void>;
  /** Clears the settled refusal filed under `key`; a pending admission stays. */
  retireFailure: (key: string) => void;
}>;

/**
 * One slash command's save phase.
 *
 * Admission is keyed by the resource being saved, so reopening a command whose
 * save is still running cannot admit a second save for it. The form generation
 * fences both sides of the settle: only the form that started the save may
 * publish its refusal or close itself, so a form reopened while the save is out
 * starts clean instead of opening on its predecessor's error.
 */
export function useCommandSavePhase(owner: SaveOwner, runners: SaveRunners): CommandSavePhase {
  const { key: formKey, generation, isCurrent } = owner;
  const saves = useKeyedSurfaceFeedback<string, KiloCommandSaveFailure>();
  const phase = saves.snapshot.states.get(formKey);

  const saveCommand = useCallback(
    async (intent: CommandSaveIntent, onSaved: () => void) => {
      const key = intent.kind === 'create' ? ADD_FORM_KEY : intent.target.id;
      const startedAt = generation();
      const attempt = saves.begin(key);
      if (attempt === null) {
        // Already saving this command.
        return;
      }
      try {
        await (intent.kind === 'create'
          ? runners.create(intent.payload)
          : runners.update(intent.target.id, intent.payload));
      } catch (error) {
        const failure: KiloCommandSaveFailure =
          readTrpcErrorField(error, 'code') === 'CONFLICT'
            ? { kind: 'name-conflict' }
            : { kind: 'refused' };
        // A refusal belongs to the form that sent it: once a later open or a
        // close replaced that form, publishing would show the error on a form
        // that never sent the save.
        if (isCurrent(startedAt)) {
          attempt.fail(failure);
        } else {
          attempt.abandon();
        }
        return;
      }
      if (attempt.abandon() && isCurrent(startedAt)) {
        onSaved();
      }
    },
    [generation, isCurrent, runners, saves]
  );

  return {
    isSaving: phase?.status === 'pending',
    failure: phase?.status === 'failed' ? phase.failure : null,
    saveCommand,
    retireFailure: (key: string) => {
      saves.clearWhere(key, () => true);
    },
  };
}
