import { describe, it, expect, jest } from '@jest/globals';
import { workerUrlForInstance } from './instance-url';
import { sandboxIdFromUserId, sandboxIdFromInstanceId } from '@kilocode/worker-utils/sandbox-id';

const LEGACY = 'https://claw.kilo.ai';
const TEMPLATE = 'https://{label}.kiloclaw.ai';

describe('workerUrlForInstance', () => {
  it('falls back to the legacy URL when the template is unset', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 2,
        template: '',
        fallback: LEGACY,
      })
    ).toBe(LEGACY);
  });

  it('falls back to the legacy URL and warns once when the template has no {label} placeholder', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        workerUrlForInstance({
          sandboxId,
          controllerCapabilitiesVersion: 2,
          template: 'https://claw.kiloclaw.ai',
          fallback: LEGACY,
        })
      ).toBe(LEGACY);
      // Subsequent calls with the same misconfiguration must not spam logs.
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 2,
        template: 'https://claw.kiloclaw.ai',
        fallback: LEGACY,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/missing the \{label\} placeholder/);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the legacy URL for pre-v2 instances', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: null,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toBe(LEGACY);
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 1,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toBe(LEGACY);
  });

  it('falls back to the legacy URL when sandboxId is null (no-instance sentinel)', () => {
    expect(
      workerUrlForInstance({
        sandboxId: null,
        controllerCapabilitiesVersion: 2,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toBe(LEGACY);
  });

  it('expands the template for instance-keyed sandboxIds on v2+', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 2,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toBe('https://i-550e8400e29b41d4a716446655440000.kiloclaw.ai');
  });

  it('expands the template for legacy userId sandboxes on v2+', () => {
    const sandboxId = sandboxIdFromUserId('oauth/google:118234567890');
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 2,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toMatch(/^https:\/\/u-[0-9a-v]+\.kiloclaw\.ai$/);
  });

  it('falls back to the legacy URL when the sandboxId cannot be safely labelled', () => {
    const overlongSandboxId = sandboxIdFromUserId('a'.repeat(39));
    expect(
      workerUrlForInstance({
        sandboxId: overlongSandboxId,
        controllerCapabilitiesVersion: 2,
        template: TEMPLATE,
        fallback: LEGACY,
      })
    ).toBe(LEGACY);
  });

  it('uses the hardcoded default when fallback is empty', () => {
    expect(
      workerUrlForInstance({
        sandboxId: null,
        controllerCapabilitiesVersion: 2,
        template: '',
        fallback: '',
      })
    ).toBe('https://claw.kilo.ai');
  });

  it('works with dev-parity templates (http + port)', () => {
    const sandboxId = sandboxIdFromInstanceId('550e8400-e29b-41d4-a716-446655440000');
    expect(
      workerUrlForInstance({
        sandboxId,
        controllerCapabilitiesVersion: 2,
        template: 'http://{label}.kiloclaw.localhost:8795',
        fallback: 'http://localhost:8795',
      })
    ).toBe('http://i-550e8400e29b41d4a716446655440000.kiloclaw.localhost:8795');
  });
});
