import type { MessageDeliveryState } from '@kilocode/cloud-agent-sdk';

export type DeliveryBadge = {
  label: 'Queued' | 'Failed to deliver' | 'Response failed';
  tone: 'info' | 'error';
  title?: string;
};

export function getDeliveryBadge(state: MessageDeliveryState | undefined): DeliveryBadge | null {
  if (!state) return null;
  if (state.status === 'queued') return { label: 'Queued', tone: 'info' };
  // `execution` is the response failing, not the transport: the message reached
  // the agent. The badge agrees with the failure footer's title so the two do
  // not report one turn two different ways.
  if (state.reason === 'execution') {
    return { label: 'Response failed', tone: 'error', title: state.error };
  }
  return { label: 'Failed to deliver', tone: 'error', title: state.error };
}
