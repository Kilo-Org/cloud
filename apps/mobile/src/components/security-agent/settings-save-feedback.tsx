import { type ReactElement, useCallback, useState } from 'react';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { securityConfigMutationMessage } from '@/lib/security-agent-ledger';

/**
 * Largest OS font scale the refusal line grows to. It is a status line whose
 * copy length the catalog does not bound, so it carries a cap on how far a
 * raised text size can grow it — the same rule the cannot-send reason uses.
 */
const REFUSAL_MAX_FONT_SCALE = 1.6;

type SettingsSaveFeedback = {
  /** Await a settings save, keep its refusal for the inline line, and rethrow it. */
  run: (save: () => Promise<void>) => Promise<void>;
  /** The refusal line: `null` until a save is refused, then the parked refusal. */
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
 * The line costs the body nothing while no save is refused: `node` is `null`
 * and the first card starts at the scroller's own top padding, because the
 * design review rejected a permanent band above the body on these short
 * screens. The line sits between the header and the scroller rather than inside
 * the scroller, so a parked refusal stays in view at any scroll position; it
 * costs the body the line's own height until a save clears it.
 *
 * A parked sentence is never clipped — the tail is the part that says what to
 * do next — so the line grows with its copy instead of losing it, and that
 * growth is bounded by `REFUSAL_MAX_FONT_SCALE` so a raised text size cannot
 * take the body's room without limit.
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

  // Nothing to report mounts nothing at all: no wrapper, no live region, no
  // announcement to clear, and no gap between the header and the first card.
  // The wrapper appears only with a parked refusal and takes exactly the
  // sentence's height, so the body gives up that room only while it is needed.
  const node =
    failure === null ? null : (
      <View className="px-6">
        <AccessibleStatus
          message={securityConfigMutationMessage(failure)}
          tone="error"
          className="text-sm"
          maxFontSizeMultiplier={REFUSAL_MAX_FONT_SCALE}
        />
      </View>
    );

  return { run, node };
}
