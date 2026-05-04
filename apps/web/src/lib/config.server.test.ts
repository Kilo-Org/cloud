import { describe, it, expect } from '@jest/globals';
import { resolveInstanceUrlTemplate } from './config.server';

describe('resolveInstanceUrlTemplate', () => {
  it('defaults to the canonical prod template when running in production with no override', () => {
    expect(resolveInstanceUrlTemplate(undefined, 'production')).toBe('https://{label}.kiloclaw.ai');
  });

  it('returns empty in dev/test when no override is set', () => {
    expect(resolveInstanceUrlTemplate(undefined, 'development')).toBe('');
    expect(resolveInstanceUrlTemplate(undefined, 'test')).toBe('');
    expect(resolveInstanceUrlTemplate(undefined, undefined)).toBe('');
  });

  it('honors an explicit override in production', () => {
    expect(resolveInstanceUrlTemplate('https://{label}.preview.kiloclaw.ai', 'production')).toBe(
      'https://{label}.preview.kiloclaw.ai'
    );
  });

  it('treats an explicit empty string as a kill switch in production', () => {
    // Operators can roll back without a code deploy by setting
    // KILOCLAW_INSTANCE_URL_TEMPLATE= (empty) in Vercel.
    expect(resolveInstanceUrlTemplate('', 'production')).toBe('');
  });

  it('honors a dev-parity override in development', () => {
    expect(
      resolveInstanceUrlTemplate('http://{label}.kiloclaw.localhost:8795', 'development')
    ).toBe('http://{label}.kiloclaw.localhost:8795');
  });
});
