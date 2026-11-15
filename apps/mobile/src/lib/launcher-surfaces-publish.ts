import { type LauncherSurfaceTargets } from '@/lib/launcher-surfaces';
import { type LauncherSurfacesPayload } from '@/lib/native-launcher-surfaces';

/**
 * Turns the derived launcher targets (pure, s1) into the payload the native
 * surface parses (s4), and gates the write so a refetch that derives the same
 * list does not rewrite an identical OS surface. Labels are translated here,
 * not natively, so the OS surface follows the app language like every other
 * in-app control.
 */

/**
 * The payload for one target set. `needsInputLabel` is always present, even
 * when `needsInputUrl` is null: it is the label of the tile's next state, not
 * a label for a shortcut that exists. "New agent" and "Needs input" reuse
 * `glanceable.newAgent` and `glanceable.needsInput`: the launcher surfaces and
 * the glanceable widget name the same actions, so a second key holding that
 * exact copy would fail the catalog duplicate check.
 */
export function buildLauncherSurfacesPayload(
  targets: LauncherSurfaceTargets,
  translate: (key: string) => string
): LauncherSurfacesPayload {
  return {
    newAgentUrl: targets.newAgentUrl,
    newAgentLabel: translate('glanceable.newAgent'),
    needsInputUrl: targets.needsInputUrl,
    needsInputLabel: translate('glanceable.needsInput'),
    openLastSessionUrl: targets.openLastSessionUrl,
    openLastSessionLabel: translate('launcher.openLastSession'),
  };
}

export type LauncherSurfacesPublisher = {
  /** Publish `targets` unless the serialized payload is unchanged. */
  apply: (targets: LauncherSurfaceTargets, translate: (key: string) => string) => void;
  /** Drop the surface and forget the memo, so the next `apply` writes again. */
  clear: () => void;
};

/**
 * The revision of the native surface: it moves whenever a clear runs outside a
 * publisher, so every publisher knows the surface it last wrote is no longer
 * the surface the OS holds. `apply` compares it beside the payload, and the
 * derivation that follows a boundary clear therefore writes the list again.
 */
let clearedRevision = 0;

/** Record a clear that ran outside a publisher. */
export function noteLauncherSurfacesCleared(): void {
  clearedRevision += 1;
}

/**
 * Memoized writer for the launcher surfaces. The serialized payload — not the
 * target object identity — is the memo key, because the session list is
 * re-derived on every refetch and the OS surface must only be rewritten when
 * something the user can see actually changed. `clear` resets the memo as well:
 * the native side just dropped the surface, so the next `apply` has to write
 * the list back even when it matches the pre-clear payload.
 */
export function createLauncherSurfacesPublisher(
  publish: (payload: LauncherSurfacesPayload) => void,
  clear: () => void
): LauncherSurfacesPublisher {
  let lastPublished: string | null = null;
  let publishedRevision = 0;

  return {
    apply(targets, translate) {
      const payload = buildLauncherSurfacesPayload(targets, translate);
      const serialized = JSON.stringify(payload);
      if (serialized === lastPublished && clearedRevision === publishedRevision) {
        return;
      }
      lastPublished = serialized;
      publishedRevision = clearedRevision;
      publish(payload);
    },
    clear() {
      lastPublished = null;
      clearedRevision += 1;
      publishedRevision = clearedRevision;
      clear();
    },
  };
}
