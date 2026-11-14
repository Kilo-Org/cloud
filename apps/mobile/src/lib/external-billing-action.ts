import { Platform } from 'react-native';

/**
 * How a control that leads to a paid-plan page may present itself.
 *
 * App Store review forbids an in-app link to an external purchase page, so iOS
 * gets the destination as plain text and every other platform opens it. The
 * decision lives here rather than in each screen, so no call site branches on
 * the platform itself and a new billing surface inherits the same rule.
 */
export type ExternalBillingAction = { kind: 'link'; url: string } | { kind: 'text'; url: string };

export function externalBillingAction(url: string): ExternalBillingAction {
  return Platform.OS === 'ios' ? { kind: 'text', url } : { kind: 'link', url };
}
