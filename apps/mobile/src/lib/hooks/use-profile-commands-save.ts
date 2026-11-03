import { type RefObject, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { nonBlankCommands, sameCommands } from '@/components/profiles/profile-commands-model';
import { useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { chainSave } from '@/lib/hooks/save-chain';

export type ProfileCommandsSaveQueue = Readonly<{
  /** The list the server confirmed, for refetch reconciliation. */
  persistedRef: RefObject<string[]>;
  /** True from enqueue until the last queued write settles. */
  isSaving: boolean;
  /** Persist the whole list after any earlier write. */
  save: (commands: readonly string[]) => Promise<boolean>;
}>;

function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * Serialized whole-list saves for one profile's Setup commands. `setCommands`
 * replaces every command, so overlapping writes could land out of order and
 * resurrect a superseded list; `chainSave` keeps them FIFO per profile.
 */
export function useProfileCommandsSave({
  profileId,
  organizationId,
  initialCommands,
}: Readonly<{
  profileId: string;
  organizationId?: string;
  initialCommands: string[];
}>): ProfileCommandsSaveQueue {
  const { t } = useTranslation();
  const { setCommands: saveCommands } = useAgentProfileMutations(organizationId);
  const persistedRef = useRef(initialCommands);
  const pendingRef = useRef(0);
  const [isSaving, setIsSaving] = useState(false);
  const chainKey = `profile-commands:${organizationId ?? 'personal'}:${profileId}`;

  // eslint-disable-next-line typescript-eslint/promise-function-async -- chainSave already returns the promise; async would add nothing
  const write = (payload: string[]): Promise<boolean> =>
    chainSave(chainKey, async () => {
      // An unchanged payload — a reverted edit, or a moved draft row with no
      // text — has nothing to send.
      if (sameCommands(payload, persistedRef.current)) {
        return true;
      }
      const previous = persistedRef.current;
      persistedRef.current = payload;
      try {
        await saveCommands.mutateAsync({ profileId, commands: payload });
        return true;
      } catch (error) {
        persistedRef.current = previous;
        if (!hasUsableMessage(error)) {
          toast.error(t('profiles.commandsSaveFailed'));
        }
        return false;
      }
    });

  const save = async (commands: readonly string[]): Promise<boolean> => {
    const saved = write(nonBlankCommands(commands));
    pendingRef.current += 1;
    setIsSaving(true);
    try {
      return await saved;
    } finally {
      pendingRef.current -= 1;
      if (pendingRef.current === 0) {
        setIsSaving(false);
      }
    }
  };

  return { persistedRef, isSaving, save };
}
