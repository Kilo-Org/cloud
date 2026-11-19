import { Effect } from 'effect';
import { Alert } from 'react-native';

import { i18n } from '@/i18n';

/**
 * The settings where one direction of the change needs the person's ok, and the
 * dialog body that asks for it. The table is the single source of truth for the
 * guarded set: the catalog entries read it through `guardedChangeSummary`, and
 * the test suite iterates the same names.
 */
type GuardedChange = Readonly<{
  name: string;
  /** The boolean value that asks first; the opposite value is written at once. */
  direction: 'on' | 'off';
  summaryKey: string;
}>;

const GUARDED_CHANGES = [
  {
    name: 'notifications.spendAlerts',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.spendAlertsOff',
  },
  {
    name: 'notifications.balanceAlerts',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.balanceAlertsOff',
  },
  {
    name: 'notifications.securityFindings',
    direction: 'off',
    summaryKey: 'settingsTools.guarded.securityFindingsOff',
  },
  {
    name: 'hideBalance',
    direction: 'on',
    summaryKey: 'settingsTools.guarded.hideBalanceOn',
  },
] as const satisfies readonly GuardedChange[];

/**
 * The dialog body to show before writing this change, or nothing when the
 * change does not need one. Value-triggered: only the guarded direction of a
 * guarded setting returns a summary.
 */
export function guardedChangeSummary(name: string, value: unknown): string | undefined {
  const guarded = GUARDED_CHANGES.find(change => change.name === name);
  if (guarded === undefined) {
    return undefined;
  }
  const guardedValue = guarded.direction === 'on';
  return value === guardedValue ? i18n.t(guarded.summaryKey) : undefined;
}

/**
 * Asks the person to confirm a settings change that needs their word. Resolves
 * true when they choose Save, false on Cancel, on dismissal, and on a back
 * press.
 *
 * Used for the destructive trusted-host list, and for the value-triggered
 * guarded settings named in `GUARDED_CHANGES` above: an agent's tool call never
 * reaches the store until this resolves true, so those settings never change in
 * silence.
 */
export function confirmSettingChange(summary: string): Effect.Effect<boolean> {
  return Effect.promise(
    // eslint-disable-next-line typescript-eslint/promise-function-async -- the promise settles on the alert button press, not on an await
    () =>
      new Promise<boolean>(resolve => {
        Alert.alert(
          i18n.t('settingsTools.confirmTitle'),
          summary,
          [
            {
              text: i18n.t('common.cancel'),
              style: 'cancel',
              onPress: () => {
                resolve(false);
              },
            },
            {
              text: i18n.t('common.save'),
              onPress: () => {
                resolve(true);
              },
            },
          ],
          {
            cancelable: false,
            onDismiss: () => {
              resolve(false);
            },
          }
        );
      })
  );
}
