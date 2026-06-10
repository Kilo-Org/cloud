import type { MessageDeliveryState } from '@/lib/cloud-agent-sdk';

export type DeliveryBadge = {
  label: 'Queued' | 'Failed to deliver';
  tone: 'info' | 'error';
  title?: string;
};

export function getDeliveryBadge(state: MessageDeliveryState | undefined): DeliveryBadge | null {
  if (!state) return null;
  if (state.status === 'queued') return { label: 'Queued', tone: 'info' };
  return { label: 'Failed to deliver', tone: 'error', title: state.error };
}
