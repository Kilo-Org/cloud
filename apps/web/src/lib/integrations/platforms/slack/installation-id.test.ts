import { describe, expect, it } from '@jest/globals';
import { isSlackEnterpriseInstallationId } from './installation-id';

describe('isSlackEnterpriseInstallationId', () => {
  it('distinguishes Slack Enterprise and workspace installation IDs', () => {
    expect(isSlackEnterpriseInstallationId('E123')).toBe(true);
    expect(isSlackEnterpriseInstallationId('T123')).toBe(false);
  });
});
