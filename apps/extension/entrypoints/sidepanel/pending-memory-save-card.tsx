import { storage } from '#imports';
import { useSetAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { MAX_MEMORY_NOTE_LENGTH } from '@/src/shared/agent-memories';
import { addAgentMemory, clearPendingAgentMemoryDraft } from '@/src/shared/agent-memories-storage';
import {
  buildDraftSelectionPreview,
  classifySaveError,
  deriveNoteCharacterCount,
  deriveSaveCardState,
} from './pending-memory-save-card-state';
import { settingsDialogOpenAtom } from './settings-dialog-state';
import { useAgentMemories } from './use-agent-memories';

const SAVE_ERROR_MESSAGE = "Couldn't save memory. Try again.";
const LOAD_ERROR_MESSAGE = "Couldn't load memories. Try again.";
const FULL_MESSAGE = 'Memory is full. Delete memories to save new ones.';
const CONFIRMATION_MESSAGE = 'Saved to memory';
const TRUNCATION_NOTICE = 'Selection truncated to 8,000 characters';

const secondaryButtonClass =
  'h-8 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50';

const primaryButtonClass =
  'h-8 rounded-md bg-[#EDFF00] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-[#d9ea00] focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500';

export const PendingMemorySaveCard = (): JSX.Element | null => {
  const { isLoaded, loadError, memories, pendingDraft, reload } = useAgentMemories();
  const setSettingsOpen = useSetAtom(settingsDialogOpenAtom);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const lastDraftKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (pendingDraft === undefined) {
      lastDraftKeyRef.current = null;
      return;
    }

    const draftKey = `${pendingDraft.createdAt}:${pendingDraft.text}`;
    if (lastDraftKeyRef.current !== null && lastDraftKeyRef.current !== draftKey) {
      setSavedConfirmation(false);
      setSaveError(undefined);
      setNote('');
    } else if (lastDraftKeyRef.current === null) {
      // Fresh draft while confirmation may still be showing from a prior save.
      setSavedConfirmation(false);
      setSaveError(undefined);
    }

    lastDraftKeyRef.current = draftKey;
  }, [pendingDraft]);

  const view = deriveSaveCardState({
    isLoaded,
    loadError,
    memories,
    pendingDraft,
    saveError,
    savedConfirmation,
  });

  if (view.kind === 'hidden') {
    return null;
  }

  const handleCancel = (): void => {
    void clearPendingAgentMemoryDraft(storage);
    setSavedConfirmation(false);
    setSaveError(undefined);
    setNote('');
  };

  const handleDone = (): void => {
    setSavedConfirmation(false);
    setSaveError(undefined);
    setNote('');
  };

  const handleSave = async (): Promise<void> => {
    if (pendingDraft === undefined || isSaving) {
      return;
    }

    setIsSaving(true);
    try {
      const trimmedNote = note.trim();
      await addAgentMemory(storage, {
        createdAt: pendingDraft.createdAt,
        pageTitle: pendingDraft.pageTitle,
        pageUrl: pendingDraft.pageUrl,
        text: pendingDraft.text,
        ...(pendingDraft.truncated === undefined ? {} : { truncated: pendingDraft.truncated }),
        ...(trimmedNote.length === 0 ? {} : { note: trimmedNote }),
      });
      await clearPendingAgentMemoryDraft(storage);
      setSaveError(undefined);
      setSavedConfirmation(true);
      setNote('');
    } catch (error) {
      if (classifySaveError(error) === 'full') {
        // Reactive full view is already correct — do not set saveError.
        return;
      }

      setSaveError(SAVE_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  };

  const noteCount = deriveNoteCharacterCount(note);

  return (
    <section
      aria-label="Add to memory"
      className="shrink-0 border-b border-zinc-800 bg-zinc-950 px-3 py-3"
    >
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        {view.kind === 'confirmation' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-200">{CONFIRMATION_MESSAGE}</p>
            <div className="flex justify-end">
              <button className={primaryButtonClass} onClick={handleDone} type="button">
                Done
              </button>
            </div>
          </div>
        ) : null}

        {view.kind === 'loadError' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-300">{LOAD_ERROR_MESSAGE}</p>
            <div className="flex justify-end">
              <button className={primaryButtonClass} onClick={reload} type="button">
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {view.kind === 'full' || view.kind === 'saveError' || view.kind === 'draft' ? (
          <div className="flex flex-col gap-3">
            {view.kind === 'full' ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-zinc-300">{FULL_MESSAGE}</p>
                <div className="flex justify-end">
                  <button
                    className={secondaryButtonClass}
                    onClick={() => {
                      setSettingsOpen(true);
                    }}
                    type="button"
                  >
                    Manage memories
                  </button>
                </div>
              </div>
            ) : null}

            {view.kind === 'saveError' ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-zinc-300">{view.message}</p>
                <div className="flex justify-end">
                  <button
                    className={primaryButtonClass}
                    disabled={isSaving}
                    onClick={() => {
                      void handleSave();
                    }}
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : null}

            {pendingDraft === undefined ? null : (
              <>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-zinc-500">Selection</p>
                  <p className="whitespace-pre-wrap break-words text-sm text-zinc-200">
                    {buildDraftSelectionPreview(pendingDraft.text)}
                  </p>
                  {pendingDraft.truncated === true ? (
                    <p className="text-xs text-zinc-500">{TRUNCATION_NOTICE}</p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-zinc-500" htmlFor="memory-note">
                    Note (optional)
                  </label>
                  <textarea
                    aria-label="Memory note (optional)"
                    className="min-h-16 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm leading-5 text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30"
                    id="memory-note"
                    maxLength={MAX_MEMORY_NOTE_LENGTH}
                    onChange={event => {
                      setNote(event.target.value);
                    }}
                    value={note}
                  />
                  <p className="text-right text-xs text-zinc-500">
                    {noteCount.count}/{noteCount.max}
                  </p>
                </div>

                <div className="flex justify-end gap-2">
                  <button className={secondaryButtonClass} onClick={handleCancel} type="button">
                    Cancel
                  </button>
                  <button
                    className={primaryButtonClass}
                    disabled={isSaving}
                    onClick={() => {
                      void handleSave();
                    }}
                    type="button"
                  >
                    Save memory
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
};
