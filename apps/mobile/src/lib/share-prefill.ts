import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { clearSharePayload, restoreSharePayload, takeSharePayload } from '@/lib/share-payload';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';

type SharePrefillTextInput = {
  setNativeProps(props: { text: string }): void;
};

type ApplySharePrefillOptions = {
  shareId: string | undefined;
  input: SharePrefillTextInput | null;
  maxLength: number;
  onChangeText: (text: string) => void;
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  clearShareIdParam: () => void;
  /**
   * Called after a payload was fully delivered (text applied, files queued)
   * and before the route params are cleared. Optional for callers that only
   * need text and file prefill.
   */
  onDelivered?: () => void;
  /**
   * Apply the payload's text. A retry after a failed file delivery passes
   * `false`: the text already landed on the first attempt, and the person may
   * have typed over it since.
   */
  applyText?: boolean;
};

/**
 * Delivers a share payload into a composer once. Ordered: take → text → files →
 * signal delivery → clear route params. Text is applied before awaiting files so
 * a file failure cannot cost the user their text. On `addCandidates` throw the
 * payload goes back to the store under the same id and the route params stay, so
 * the composer can offer a retry that delivers the same files instead of an
 * empty composer. Returns whether the payload was delivered.
 */
export async function applySharePrefill(options: ApplySharePrefillOptions): Promise<boolean> {
  const shareId = options.shareId;
  if (shareId === undefined || shareId === '') {
    return true;
  }

  const payload = takeSharePayload(shareId);
  if (payload === null) {
    options.clearShareIdParam();
    return true;
  }

  // Text first and unconditionally (when non-empty) so file failures keep it.
  // A retry after a file failure skips it: the text landed on the first attempt
  // and the person may have edited it since.
  if (payload.text !== '' && options.applyText !== false) {
    applyVoiceDraftToInput({
      input: options.input,
      draft: payload.text,
      maxLength: options.maxLength,
      onChangeText: options.onChangeText,
    });
  }

  if (payload.files.length > 0) {
    try {
      await options.addCandidates(payload.files);
    } catch {
      // Keep the text that already landed, but put the files back under the same
      // id and leave the param: the composer's own retry delivers this payload
      // again instead of leaving the person with an empty composer and no photo.
      // Neither the delivery signal nor the param clear runs, because nothing
      // was delivered.
      restoreSharePayload(shareId, payload);
      return false;
    }
  }

  // Signal delivery before clearing the route param so the destination
  // composer arms its auto-send while autoSend is still on the URL.
  options.onDelivered?.();

  // URL hygiene only — nothing depends on clearing the param.
  options.clearShareIdParam();
  return true;
}

type UseSharePrefillOptions = {
  shareId?: string;
  inputRef: RefObject<SharePrefillTextInput | null>;
  maxLength: number;
  onChangeText: (text: string) => void;
  addCandidates: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  onDelivered?: () => void;
};

/**
 * What a composer does with a staged payload it could not attach: show the
 * failure with a retry that re-delivers the same files, and a discard that
 * clears the staged payload so no unreachable entry outlives the screen.
 */
export type SharePrefillControl = {
  failed: boolean;
  retry: () => void;
  dismiss: () => void;
};

/**
 * Effect keyed on `shareId`. On a new non-empty id, takes the payload and
 * prefills the composer. Call sites own the input ref, change handler, and
 * attachment upload path.
 *
 * A rejected file delivery leaves the payload staged under the same id and
 * reports `failed`, so the composer's own Retry re-delivers it instead of
 * leaving the files held with no control that re-attaches them. The retry
 * skips the text: it landed on the first attempt.
 */
export function useSharePrefill({
  shareId,
  inputRef,
  maxLength,
  onChangeText,
  addCandidates,
  onDelivered,
}: UseSharePrefillOptions): SharePrefillControl {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onChangeTextRef = useRef(onChangeText);
  onChangeTextRef.current = onChangeText;
  const addCandidatesRef = useRef(addCandidates);
  addCandidatesRef.current = addCandidates;
  const maxLengthRef = useRef(maxLength);
  maxLengthRef.current = maxLength;
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  // A delivery that settles after this composer unmounts must not publish
  // `failed` into a tree that is gone.
  const activeRef = useRef(true);

  useEffect(() => {
    if (shareId === undefined || shareId === '') {
      return undefined;
    }

    activeRef.current = true;
    void (async () => {
      const delivered = await applySharePrefill({
        shareId,
        input: inputRef.current,
        maxLength: maxLengthRef.current,
        onChangeText: text => {
          onChangeTextRef.current(text);
        },
        addCandidates: async candidates => {
          await addCandidatesRef.current(candidates);
        },
        clearShareIdParam: () => {
          router.setParams({ shareId: undefined, autoSend: undefined });
        },
        onDelivered: onDeliveredRef.current,
        applyText: attempt === 0,
      });
      if (activeRef.current) {
        setFailed(!delivered);
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, [shareId, inputRef, router, attempt]);

  const retry = useCallback((): void => {
    setFailed(false);
    setAttempt(previous => previous + 1);
  }, []);

  const dismiss = useCallback((): void => {
    if (shareId !== undefined && shareId !== '') {
      clearSharePayload(shareId);
    }
    setFailed(false);
    router.setParams({ shareId: undefined, autoSend: undefined });
  }, [router, shareId]);

  return { failed, retry, dismiss };
}
