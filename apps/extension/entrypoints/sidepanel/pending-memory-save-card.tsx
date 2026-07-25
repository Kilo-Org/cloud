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
  'type-label h-8 rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

const primaryButtonClass =
  'type-label h-8 rounded-md bg-brand-primary px-3 text-brand-primary-foreground transition hover:bg-brand-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background disabled:cursor-not-allowed disabled:bg-surface-selected disabled:text-foreground-subtle';

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
      className="shrink-0 border-b border-border bg-surface-background px-3 py-3"
    >
      <div className="rounded-xl border border-border bg-surface-raised p-3">
        {view.kind === 'confirmation' ? (
          <div className="flex flex-col gap-3">
            <p className="type-body text-foreground">{CONFIRMATION_MESSAGE}</p>
            <div className="flex justify-end">
              <button className={primaryButtonClass} onClick={handleDone} type="button">
                Done
              </button>
            </div>
          </div>
        ) : null}

        {view.kind === 'loadError' ? (
          <div className="flex flex-col gap-3">
            <p className="type-body text-status-red-400">{LOAD_ERROR_MESSAGE}</p>
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
                <p className="type-body text-foreground">{FULL_MESSAGE}</p>
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
                <p className="type-body text-status-red-400">{view.message}</p>
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
                  <p className="type-label text-foreground-muted">Selection</p>
                  <p className="type-body whitespace-pre-wrap break-words text-foreground">
                    {buildDraftSelectionPreview(pendingDraft.text)}
                  </p>
                  {pendingDraft.truncated === true ? (
                    <p className="type-label text-foreground-muted">{TRUNCATION_NOTICE}</p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="type-label text-foreground-muted" htmlFor="memory-note">
                    Note (optional)
                  </label>
                  <textarea
                    aria-label="Memory note (optional)"
                    className="type-body min-h-16 w-full resize-y rounded-md border border-border-strong bg-input-bg px-2 py-1.5 text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
                    id="memory-note"
                    maxLength={MAX_MEMORY_NOTE_LENGTH}
                    onChange={event => {
                      setNote(event.target.value);
                    }}
                    value={note}
                  />
                  <p className="type-label text-right text-foreground-muted">
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
