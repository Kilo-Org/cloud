import { type Href } from 'expo-router';

/**
 * The receipt screen for one moderation report. Shared so the confirmation's
 * toast action and any deep link name the same route.
 */
export function reportReceiptRoute(receiptId: string): Href {
  return `/(app)/report-receipt/${receiptId}` as Href;
}
