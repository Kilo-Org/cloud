import { describe, expect, it, jest } from '@jest/globals';

import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';
import {
  buildCodingPlanInventorySlackNotification,
  sendCodingPlanInventorySlackSummary,
  type CodingPlanInventoryCount,
} from './inventory-slack-summary';

const CURRENT_COUNTS: CodingPlanInventoryCount[] = [
  { providerId: 'minimax', planId: 'minimax-token-plan-max', status: 'assigned', count: 7 },
  { providerId: 'minimax', planId: 'minimax-token-plan-max', status: 'available', count: 3 },
  { providerId: 'minimax', planId: 'minimax-token-plan-plus', status: 'assigned', count: 148 },
  { providerId: 'minimax', planId: 'minimax-token-plan-plus', status: 'available', count: 79 },
  {
    providerId: 'minimax',
    planId: 'minimax-token-plan-plus',
    status: 'revocation_pending',
    count: 5,
  },
  { providerId: 'minimax', planId: 'minimax-token-plan-plus', status: 'revoked', count: 19 },
  { providerId: 'minimax', planId: 'minimax-token-plan-ultra', status: 'assigned', count: 1 },
  { providerId: 'minimax', planId: 'minimax-token-plan-ultra', status: 'available', count: 1 },
];

function blockText(notification: ReturnType<typeof buildCodingPlanInventorySlackNotification>) {
  return JSON.stringify(notification.notification.blocks);
}

describe('buildCodingPlanInventorySlackNotification', () => {
  it('formats the current inventory into a compact Slack summary', () => {
    const result = buildCodingPlanInventorySlackNotification(
      CURRENT_COUNTS,
      new Date('2026-07-30T12:00:00.000Z')
    );

    expect(result.totals).toEqual({
      loaded: 263,
      assigned: 156,
      available: 83,
      revocationPending: 5,
      revocationFailed: 0,
      revoked: 19,
    });
    expect(result.notification.text).toBe(
      'Coding Plans inventory: 83 available, 156 assigned, 263 loaded. 5 pending revocation. Token Plan Plus: 79 available. Token Plan Max: 3 available. Token Plan Ultra: 1 available.'
    );

    const rendered = blockText(result);
    expect(rendered).toContain('MiniMax · Current snapshot');
    expect(rendered).toContain('Token Plan Plus');
    expect(rendered).toContain('79 available · 148 assigned · 251 loaded');
    expect(rendered).toContain('5 pending revocation · 19 revoked');
    expect(rendered).toContain('Snapshot: 2026-07-30 12:00 UTC');
    expect(rendered).toContain('/admin/coding-plans|Open Coding Plans');
    expect(rendered).not.toContain('open_coding_plans_inventory');
  });

  it('prioritizes failed revocations and preserves unknown statuses', () => {
    const result = buildCodingPlanInventorySlackNotification([
      ...CURRENT_COUNTS,
      {
        providerId: 'minimax',
        planId: 'minimax-token-plan-plus',
        status: 'revocation_failed',
        count: 2,
      },
      { providerId: 'other', planId: 'future-plan', status: 'quarantined', count: 3 },
    ]);

    expect(result.totals.revocationFailed).toBe(2);
    expect(result.totals.loaded).toBe(268);
    const rendered = blockText(result);
    expect(rendered).toContain('2 failed revocation');
    expect(rendered).toContain('3 quarantined');
    expect(rendered).toContain('Action required');
  });

  it('renders an explicit empty-inventory state', () => {
    const result = buildCodingPlanInventorySlackNotification([]);

    expect(result.totals.loaded).toBe(0);
    expect(result.notification.text).toContain('No inventory recorded');
    expect(blockText(result)).toContain('No Coding Plans inventory is currently recorded.');
  });
});

describe('sendCodingPlanInventorySlackSummary', () => {
  it('queries current counts and sends the generated notification', async () => {
    const getCounts = jest.fn(async () => CURRENT_COUNTS);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await expect(
      sendCodingPlanInventorySlackSummary({ getCounts, sendNotification })
    ).resolves.toMatchObject({
      available: 83,
      loaded: 263,
    });

    expect(getCounts).toHaveBeenCalledWith();
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('83 available') })
    );
  });
});
