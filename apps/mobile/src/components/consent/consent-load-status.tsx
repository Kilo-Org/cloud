import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';

/**
 * What the consent card's reserved footer status line holds while the stored
 * consent choice loads.
 *
 * The card's own error state still exists beside this union: a later action on
 * the card (a failed sign-out, a failed optional-save) writes its catalogue
 * key into the same slot, and the loading phase renders nothing there.
 */
export type ConsentLoadStatus =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed' };

type ConsentLoadStatusLineProps = {
  /** The load phase. */
  readonly load: ConsentLoadStatus;
  /** The catalogue key of the latest action error, or null. */
  readonly error: string | null;
  /** Re-runs the stored read after a failed attempt. */
  readonly onRetry: () => void;
  /** The loader for the status line's copy. */
  readonly t: (key: string) => string;
};

/**
 * The reserved footer status slot of the consent card (see the card's footer
 * comment for why the slot is reserved). While the stored read is in flight
 * the line names the wait, so a disabled-looking primary has its reason on
 * screen instead of reading as a dead control; when the read fails or times
 * out the line becomes the latest failure with its own Retry, because the
 * primary must stay disabled until the read answers.
 */
export function ConsentLoadStatusLine({ load, error, onRetry, t }: ConsentLoadStatusLineProps) {
  if (load.status === 'loading') {
    return (
      <AccessibleStatus
        message={t('consent.loadingConsentSettings')}
        tone="status"
        className="text-sm"
      />
    );
  }
  if (load.status === 'failed') {
    // Retry belongs to the load attempt: it re-runs the stored read, so it
    // stays beside the copy only while that copy is still the load failure.
    // A later action's failure (a failed sign-out, a failed optional-save)
    // owns the slot with no Retry — retrying the read there would clear a
    // failure it did not produce while the real problem is still live.
    const showsLoadFailure = error === null || error === 'consent.couldNotLoadConsentSettings';
    return (
      <View className="flex-row items-center justify-center gap-1">
        {/* The load failure seeds `error` with the load key, but a later
            action on the failed card can write its own key (Decline's failed
            sign-out, a failed optional-save). The latest error wins: the load
            error is only the default this state starts from, and a hardcoded
            copy would hide the real failure. */}
        <AccessibleStatus
          message={t(error ?? 'consent.couldNotLoadConsentSettings')}
          className="text-sm"
        />
        {showsLoadFailure ? (
          <Pressable
            onPress={onRetry}
            hitSlop={LINE_ACTION_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            // The shared line-action box: its `-my-[7px]` keeps the row one
            // line tall, so a failed load grows the reserved slot by nothing
            // and the actions below it never move.
            className={`${LINE_ACTION_BOX_CLASS} flex-row items-center gap-1 px-1 active:opacity-70`}
          >
            <Text className="text-sm font-semibold text-primary">{t('common.retry')}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return <AccessibleStatus message={error ? t(error) : null} className="text-sm" />;
}
