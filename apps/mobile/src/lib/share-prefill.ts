import { type RefObject, useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { takeSharePayload } from '@/lib/share-payload';
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
};

/**
 * Delivers a share payload into a composer once. Ordered: take → text → files →
 * signal delivery → clear route params. Text is applied before awaiting files so
 * a file failure cannot cost the user their text. On `addCandidates` throw the
 * payload is not restored and text is not re-applied.
 */
export async function applySharePrefill(options: ApplySharePrefillOptions): Promise<void> {
  const shareId = options.shareId;
  if (shareId === undefined || shareId === '') {
    return;
  }

  const payload = takeSharePayload(shareId);
  if (payload === null) {
    options.clearShareIdParam();
    return;
  }

  // Text first and unconditionally (when non-empty) so file failures keep it.
  if (payload.text !== '') {
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
      // Keep text; do not restore the payload. Upload hook toasts name failures.
    }
  }

  // Signal delivery before clearing the route param so the destination
  // composer arms its auto-send while autoSend is still on the URL.
  options.onDelivered?.();

  // URL hygiene only — nothing depends on clearing the param.
  options.clearShareIdParam();
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
 * Effect keyed on `shareId`. On a new non-empty id, takes the payload and
 * prefills the composer. Call sites own the input ref, change handler, and
 * attachment upload path.
 */
export function useSharePrefill({
  shareId,
  inputRef,
  maxLength,
  onChangeText,
  addCandidates,
  onDelivered,
}: UseSharePrefillOptions): void {
  const router = useRouter();
  const onChangeTextRef = useRef(onChangeText);
  onChangeTextRef.current = onChangeText;
  const addCandidatesRef = useRef(addCandidates);
  addCandidatesRef.current = addCandidates;
  const maxLengthRef = useRef(maxLength);
  maxLengthRef.current = maxLength;
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  useEffect(() => {
    if (shareId === undefined || shareId === '') {
      return;
    }

    void applySharePrefill({
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
    });
  }, [shareId, inputRef, router]);
}
