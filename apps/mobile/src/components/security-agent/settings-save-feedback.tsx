import { type ReactElement, useCallback, useState } from 'react';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { securityConfigMutationMessage } from '@/lib/security-agent-ledger';

type SettingsSaveFeedback = {
  /** Await a settings save, keep its refusal for the inline line, and rethrow it. */
  run: (save: () => Promise<void>) => Promise<void>;
  /** The durable refusal line, or `null` when the last save succeeded. */
  node: ReactElement | null;
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

  // No wrapper (and no reserved gap) in the empty state: the line appears only
  // when there is a refusal to show, between the header and the scrolling body.
  const node =
    failure === null ? null : (
      <View className="px-6 pb-2">
        <AccessibleStatus
          message={securityConfigMutationMessage(failure)}
          tone="error"
          className="text-sm"
        />
      </View>
    );

  return { run, node };
}
