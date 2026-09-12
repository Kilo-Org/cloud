import { describe, expect, it } from '@jest/globals';
import { isSlackEnterpriseInstallationId } from './installation-id';

describe('isSlackEnterpriseInstallationId', () => {
  it('distinguishes Slack Enterprise and workspace installation IDs', () => {
    expect(isSlackEnterpriseInstallationId('E324567')).toBe(true);
    expect(isSlackEnterpriseInstallationId('E123ABC456')).toBe(true);
    expect(isSlackEnterpriseInstallationId('E')).toBe(false);
    expect(isSlackEnterpriseInstallationId('E_GRID')).toBe(false);
    expect(isSlackEnterpriseInstallationId('Example')).toBe(false);
    expect(isSlackEnterpriseInstallationId('e123ABC')).toBe(false);
    expect(isSlackEnterpriseInstallationId('E123-ABC')).toBe(false);
    expect(isSlackEnterpriseInstallationId('E123 ABC')).toBe(false);
    expect(isSlackEnterpriseInstallationId('T123ABC456')).toBe(false);
  });
});
