import { describe, expect, it } from 'vitest';

import {
  formatKiloPassTierDescription,
  KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION,
} from './subscription-page-copy';

describe('Kilo Pass subscription page copy', () => {
  it('describes the monthly subscription uses requested for App Store review', () => {
    expect(KILO_PASS_SUBSCRIPTION_HEADER_DESCRIPTION).toBe(
      'A monthly subscription that adds credits to your Kilo balance for running AI coding sessions in Kilo App — Cloud Agents, remote sessions, and KiloClaw chats.'
    );
  });

  it('describes guaranteed paid credits added monthly for each tier card', () => {
    expect(formatKiloPassTierDescription(19)).toBe(
      '$19 paid credits added monthly for Kilo App usage.'
    );
  });
});
