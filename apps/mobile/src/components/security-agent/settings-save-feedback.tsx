import { type ReactElement, useCallback, useState } from 'react';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { securityConfigMutationMessage } from '@/lib/security-agent-ledger';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';

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
 * Thrown by `run` when admission refuses a save (one is already in flight on
 * the same screen). It is not a save refusal — nothing was attempted, so no
 * refusal line is parked and no toast fires — it only tells the caller that
 * this attempt did not happen. Callers must treat resolving `run` as a save
 * that succeeded and never navigate from it, so refusal has to be observable
 * as a rejection: a header press refused in the pre-re-render window must stay
 * on screen, and a dialog Save refused while a header save is in flight must
 * not replay the leave.
 */
export class SettingsSaveAdmissionRefused extends Error {}

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
 *
 * `run` is also these screens' one save admission point. Both surfaces that can
 * start a save — the header `SettingsSaveButton` press and the back guard's
 * unsaved-changes dialog Save — pass through the same `run`, so its
 * `surface-feedback.begin()` (`@/lib/surface-feedback`, the family's one
 * admission authority) refuses a second save while the first is still in
 * flight: a back-guard Save pressed while a header save is pending starts no
 * duplicate mutation. A refused attempt throws `SettingsSaveAdmissionRefused`
 * before it touches state, so its caller — a button that swallows the
 * rejection and stays put, or a dialog that keeps its leave behind — never
 * navigates on an attempt that did not happen. An admitted attempt publishes
 * nothing (these screens render their own refusal line, not the store's phase),
 * so it settles with `abandon()` in a `finally`; `run` must keep rethrowing
 * real save refusals, which the header button's catch and the back guard's
 * `=== 'declined'` contract both depend on.
 */
export function useSettingsSaveFeedback(): SettingsSaveFeedback {
  const [failure, setFailure] = useState<unknown>(null);
  const { begin } = useSurfaceFeedback<never>();

  const run = useCallback(
    async (save: () => Promise<void>) => {
      const attempt = begin();
      // One save at a time per screen. A refused attempt must be observable:
      // the caller treats a resolved `run` as a save that succeeded, so a
      // silent resolve would pop the screen or replay the leave without a
      // save behind it. The sentinel rejects before any state is touched.
      if (attempt === null) {
        throw new SettingsSaveAdmissionRefused();
      }
      try {
        await save();
        setFailure(null);
      } catch (error) {
        setFailure(error);
        throw error;
      } finally {
        attempt.abandon();
      }
    },
    [begin]
  );

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
