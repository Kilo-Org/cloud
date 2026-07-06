import { isPlatformIntegrationHealthy } from './health';

const healthyIntegration = {
  integration_status: 'active',
  suspended_at: null,
  auth_invalid_at: null,
};

describe('isPlatformIntegrationHealthy', () => {
  it('accepts only an active integration with valid authentication', () => {
    expect(isPlatformIntegrationHealthy(healthyIntegration)).toBe(true);
    expect(
      isPlatformIntegrationHealthy({ ...healthyIntegration, integration_status: 'suspended' })
    ).toBe(false);
    expect(
      isPlatformIntegrationHealthy({
        ...healthyIntegration,
        suspended_at: '2026-06-25 18:00:00+00',
      })
    ).toBe(false);
    expect(
      isPlatformIntegrationHealthy({
        ...healthyIntegration,
        auth_invalid_at: '2026-06-25 18:00:00+00',
      })
    ).toBe(false);
  });

  it('rejects a missing integration', () => {
    expect(isPlatformIntegrationHealthy(null)).toBe(false);
    expect(isPlatformIntegrationHealthy(undefined)).toBe(false);
  });
});
