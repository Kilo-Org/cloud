import type { MessageDeliveryState } from '@kilocode/cloud-agent-sdk';

export type DeliveryBadge = {
  label: 'Queued' | 'Sending' | 'Failed to deliver';
  tone: 'info' | 'error';
  title?: string;
  spinner?: boolean;
};

export function getDeliveryBadge(
  state: MessageDeliveryState | undefined,
  options?: { sending?: boolean }
): DeliveryBadge | null {
  if (state) {
    if (state.status === 'queued') return { label: 'Queued', tone: 'info' };
    return { label: 'Failed to deliver', tone: 'error', title: state.error };
  }
  if (options?.sending) return { label: 'Sending', tone: 'info', spinner: true };
  return null;
}
