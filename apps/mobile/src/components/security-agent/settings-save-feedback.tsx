import { type ReactElement, useCallback, useState } from 'react';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { securityConfigMutationMessage } from '@/lib/security-agent-ledger';

type SettingsSaveFeedback = {
  /** Await a settings save, keep its refusal for the inline line, and rethrow it. */
  run: (save: () => Promise<void>) => Promise<void>;
  /** The line's reserved slot: blank until a save is refused, then the refusal. */
  node: ReactElement;
};

/**
 * The durable refusal line the Security Agent settings screens share.
 *
 * `SettingsSaveButton` swallows the save's rejection and decides navigation
 * from it, so without this the only trace of a refused save is a toast that
 * fades in a few seconds while the screen still shows the dirty draft. The
 * caller passes its save through `run` and mounts `node` between the header and
 * the scrolling body; a refused save parks its error there until a save
 * succeeds, so the reader keeps the reason next to the draft that caused it.
 *
 * The refusal is stored as the error itself and its sentence is re-derived on
 * every render, so a language change re-translates the line instead of freezing
 * one catalog's copy in state. The stored error survives a re-render and a
 * later attempt: a retry in flight keeps the previous line up rather than
 * blinking it off and back.
 *
 * The slot is reserved in every state, at one line of the status copy's
 * height, so the body below it never moves when a refusal arrives or clears
 * (apps/mobile/AGENTS.md: never shift layout when state changes). The empty
 * state is that blank slot and nothing else: no line, no live region, and so
 * nothing announced.
 *
 * `AccessibleStatus` is the single announcement owner here — a live region where
 * the platform has one, an imperative announcement otherwise — so the save hook
 * is called with `announceFailed: false` on these screens. Announcing the
 * refusal again through `announceForA11y` would speak it twice.
 */
export function useSettingsSaveFeedback(): SettingsSaveFeedback {
  const [failure, setFailure] = useState<unknown>(null);

  const run = useCallback(async (save: () => Promise<void>) => {
    try {
      await save();
      setFailure(null);
    } catch (error) {
      setFailure(error);
      throw error;
    }
  }, []);

  // `min-h-5` is one line of `text-sm` at the 14pt rem (1.25rem = 17.5dp), the
  // reserved-status slot the app already uses for a line that comes and goes.
  // The wrapper carries no bottom padding: 17.5dp plus the scroll view's own
  // `pt-4` (14dp) is 31.5dp of empty band above the first block in the empty
  // state, inside the 38dp the design gate allows (scroll padding + one 24dp
  // section break). A `pb-2` on top would be 38.5dp and trip its leading-gap.
  const node = (
    <View className="min-h-5 justify-center px-6">
      {/* Nothing to report mounts nothing at all: the empty state is the slot's
          reserved height, with no live region and no announcement to clear. */}
      {failure === null ? null : (
        <AccessibleStatus
          message={securityConfigMutationMessage(failure)}
          tone="error"
          className="text-sm"
        />
      )}
    </View>
  );

  return { run, node };
}
