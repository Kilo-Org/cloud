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
  | { readonly status: 'failed'; readonly message: string };

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
 * screen instead of reading as a dead control. In the `failed` phase the
 * load failure carries its own Retry (the primary stays disabled until the
 * read answers), and the newest failure wins the visible copy: an action
 * failure that arrived after the load failure hides the load copy while it
 * is live, but the Retry — which re-runs the read that blocks the primary —
 * stays for the whole phase.
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
    // The load failure lives in the union; the action-error slot is a
    // separate channel. The newest failure wins the copy: `error` carries a
    // later action's failure (a failed sign-out, a failed optional-save)
    // and hides the load copy while it is live, but Retry — the affordance
    // that re-runs the read that blocks the primary — stays rendered for
    // the whole `failed` phase, so the card can always reach `ready` again.
    return (
      <View className="flex-row items-center justify-center gap-1">
        <AccessibleStatus message={t(error ?? load.message)} className="text-sm" />
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
      </View>
    );
  }
  return <AccessibleStatus message={error ? t(error) : null} className="text-sm" />;
}
