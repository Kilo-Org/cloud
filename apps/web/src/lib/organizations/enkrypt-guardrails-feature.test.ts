import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { isEnkryptGuardrailsFeatureEnabled, KILO_ENCRYPT_FLAG } from './enkrypt-guardrails-feature';

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => false),
}));

const mockedIsReleaseToggleEnabled = jest.mocked(isReleaseToggleEnabled);
const organizationId = '00000000-0000-4000-8000-000000000002';
const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

afterEach(() => {
  env.NODE_ENV = originalNodeEnv;
  mockedIsReleaseToggleEnabled.mockResolvedValue(false);
});

describe('isEnkryptGuardrailsFeatureEnabled', () => {
  it('is off by default', async () => {
    await expect(isEnkryptGuardrailsFeatureEnabled(organizationId)).resolves.toBe(false);
    expect(mockedIsReleaseToggleEnabled).toHaveBeenCalledWith(KILO_ENCRYPT_FLAG, organizationId);
    expect(KILO_ENCRYPT_FLAG).toBe('kilo_encrypt');
  });

  it('follows the organization flag', async () => {
    mockedIsReleaseToggleEnabled.mockResolvedValue(true);
    await expect(isEnkryptGuardrailsFeatureEnabled(organizationId)).resolves.toBe(true);
  });

  it('is on in local development', async () => {
    env.NODE_ENV = 'development';
    await expect(isEnkryptGuardrailsFeatureEnabled(organizationId)).resolves.toBe(true);
  });
});
