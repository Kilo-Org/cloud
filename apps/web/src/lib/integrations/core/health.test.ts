import {
  isPlatformIntegrationActive,
  isPlatformIntegrationHealthy,
  isPlatformIntegrationSuspended,
} from './health';

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
    expect(
      isPlatformIntegrationHealthy({
        ...healthyIntegration,
        github_disconnected_at: '2026-06-25 18:00:00+00',
      })
    ).toBe(false);
  });

  it('rejects a missing integration', () => {
    expect(isPlatformIntegrationHealthy(null)).toBe(false);
    expect(isPlatformIntegrationHealthy(undefined)).toBe(false);
  });
});

describe('isPlatformIntegrationSuspended', () => {
  it('accepts an active integration that was never suspended', () => {
    expect(isPlatformIntegrationSuspended(healthyIntegration)).toBe(false);
  });

  it('detects suspension by status', () => {
    expect(
      isPlatformIntegrationSuspended({ ...healthyIntegration, integration_status: 'suspended' })
    ).toBe(true);
  });

  it('detects suspension by suspended_at timestamp', () => {
    expect(
      isPlatformIntegrationSuspended({
        ...healthyIntegration,
        suspended_at: '2026-06-25 18:00:00+00',
      })
    ).toBe(true);
  });

  it('rejects a missing integration', () => {
    expect(isPlatformIntegrationSuspended(null)).toBe(false);
    expect(isPlatformIntegrationSuspended(undefined)).toBe(false);
  });
});

describe('isPlatformIntegrationActive', () => {
  it('accepts an active integration that was never suspended', () => {
    expect(isPlatformIntegrationActive(healthyIntegration)).toBe(true);
  });

  it('rejects an integration that still carries an active status but a suspension timestamp', () => {
    expect(
      isPlatformIntegrationActive({
        ...healthyIntegration,
        suspended_at: '2026-06-25 18:00:00+00',
      })
    ).toBe(false);
  });

  it('rejects a suspended integration whose suspension timestamp is unset', () => {
    expect(
      isPlatformIntegrationActive({ ...healthyIntegration, integration_status: 'suspended' })
    ).toBe(false);
  });

  it('rejects an integration that never reached the active status', () => {
    expect(
      isPlatformIntegrationActive({ ...healthyIntegration, integration_status: 'pending' })
    ).toBe(false);
    expect(isPlatformIntegrationActive({ ...healthyIntegration, integration_status: null })).toBe(
      false
    );
  });

  it('rejects a missing integration', () => {
    expect(isPlatformIntegrationActive(null)).toBe(false);
    expect(isPlatformIntegrationActive(undefined)).toBe(false);
  });
});
