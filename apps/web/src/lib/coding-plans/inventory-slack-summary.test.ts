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

const CURRENT_WAITLIST_COUNTS = [
  { planId: 'minimax-token-plan-max', count: 4 },
  { planId: 'minimax-token-plan-plus', count: 9 },
];

function blockText(notification: ReturnType<typeof buildCodingPlanInventorySlackNotification>) {
  return JSON.stringify(notification.notification.blocks);
}

describe('buildCodingPlanInventorySlackNotification', () => {
  it('formats the current inventory into a compact Slack summary', () => {
    const result = buildCodingPlanInventorySlackNotification(
      CURRENT_COUNTS,
      [],
      new Date('2026-07-30T12:00:00.000Z')
    );

    expect(result.totals).toEqual({
      loaded: 263,
      assigned: 156,
      available: 83,
      waitlist: 0,
      revocationPending: 5,
      revocationFailed: 0,
      revoked: 19,
    });
    expect(result.notification.text).toBe(
      'Coding Plans inventory: `83` available, `156` assigned, `263` loaded, `0` waitlisted. `5` pending revocation. MiniMax Token Plan Plus: `79` available, `148` assigned, `251` loaded, `0` waitlist. MiniMax Token Plan Max: `3` available, `7` assigned, `10` loaded, `0` waitlist. MiniMax Token Plan Ultra: `1` available, `1` assigned, `2` loaded, `0` waitlist.'
    );

    const rendered = blockText(result);
    expect(rendered).toContain('MiniMax · Current snapshot');
    expect(rendered).toContain('*Total* · Available `83` · Assigned `156` · Loaded `263`');
    expect(rendered).toContain('*MiniMax*');
    expect(rendered).toContain('Token Plan Plus · Available `79` · Assigned `148` · Loaded `251`');
    expect(rendered).not.toContain('*Provider* | *Plan*');
    expect(rendered).toContain('`5` credentials are pending revocation');
    expect(rendered.match(/pending revocation/g)).toHaveLength(1);
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
    expect(rendered).toContain('`2` credentials failed revocation');
    expect(rendered).toContain('`3` quarantined');
    expect(rendered).toContain('Action required');
  });

  it('groups plans into sections by provider', () => {
    const result = buildCodingPlanInventorySlackNotification([
      { providerId: 'minimax', planId: 'minimax-token-plan-plus', status: 'available', count: 2 },
      {
        providerId: 'byteplus-coding',
        planId: 'byteplus-coding-plan-team-lite',
        status: 'assigned',
        count: 4,
      },
      {
        providerId: 'byteplus-coding',
        planId: 'byteplus-coding-plan-team-lite',
        status: 'available',
        count: 1,
      },
      {
        providerId: 'byteplus-coding',
        planId: 'byteplus-coding-plan-team-pro',
        status: 'available',
        count: 3,
      },
    ]);

    const rendered = blockText(result);
    expect(rendered).toContain('*MiniMax*');
    expect(rendered).toContain('Token Plan Plus · Available `2` · Assigned `0` · Loaded `2`');
    expect(rendered).toContain('*BytePlus*');
    expect(rendered).toContain('Coding Plan Lite · Available `1` · Assigned `4` · Loaded `5`');
    expect(rendered).toContain('Coding Plan Pro · Available `3` · Assigned `0` · Loaded `3`');
  });

  it('renders an explicit empty-inventory state', () => {
    const result = buildCodingPlanInventorySlackNotification([]);

    expect(result.totals.loaded).toBe(0);
    expect(result.notification.text).toContain('No inventory recorded');
    expect(blockText(result)).toContain('No Coding Plans inventory is currently recorded.');
  });

  it('includes the total and per-plan waitlist counts', () => {
    const result = buildCodingPlanInventorySlackNotification(
      CURRENT_COUNTS,
      CURRENT_WAITLIST_COUNTS
    );

    expect(result.totals).toMatchObject({ waitlist: 13 });
    expect(result.notification.text).toContain('`13` waitlisted');

    const rendered = blockText(result);
    expect(rendered).toContain('Token Plan Plus');
    expect(rendered).toContain('Waitlist `9`');
    expect(rendered).toContain('Token Plan Max');
    expect(rendered).toContain('Waitlist `4`');
  });

  it('defaults missing per-plan waitlist counts to zero', () => {
    const result = buildCodingPlanInventorySlackNotification(CURRENT_COUNTS, [
      { planId: 'minimax-token-plan-plus', count: 9 },
    ]);

    expect(result.totals).toMatchObject({ waitlist: 9 });
    const rendered = blockText(result);
    expect(rendered).toContain('Token Plan Plus ·');
    expect(rendered).toContain('Waitlist `9`');
    expect(rendered).toContain('Token Plan Max ·');
    expect(rendered).toContain('Waitlist `0`');
  });

  it('represents a waitlist when no inventory is recorded', () => {
    const result = buildCodingPlanInventorySlackNotification(
      [],
      [{ planId: 'minimax-token-plan-plus', count: 6 }]
    );

    expect(result.totals).toMatchObject({ loaded: 0, waitlist: 6 });
    const rendered = blockText(result);
    expect(rendered).toContain('No Coding Plans inventory is currently recorded.');
    expect(rendered).toContain('Token Plan Plus');
    expect(rendered).toContain('Waitlist `6`');
  });
});

describe('sendCodingPlanInventorySlackSummary', () => {
  it('queries current counts and sends the generated notification', async () => {
    const getCounts = jest.fn(async () => CURRENT_COUNTS);
    const getWaitlistCounts = jest.fn(async () => CURRENT_WAITLIST_COUNTS);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await expect(
      sendCodingPlanInventorySlackSummary({ getCounts, getWaitlistCounts, sendNotification })
    ).resolves.toMatchObject({
      available: 83,
      loaded: 263,
      waitlist: 13,
    });

    expect(getCounts).toHaveBeenCalledWith();
    expect(getWaitlistCounts).toHaveBeenCalledWith();
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('`13` waitlisted'),
      })
    );
  });
});
