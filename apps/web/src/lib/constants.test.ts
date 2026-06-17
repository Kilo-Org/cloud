import { describe, expect, it } from '@jest/globals';
import { resolveAppUrl } from './constants';

describe('resolveAppUrl', () => {
  it('uses the staging origin for production-mode Vercel staging deployments', () => {
    expect(
      resolveAppUrl({
        nodeEnv: 'production',
        vercelTargetEnv: 'staging',
      })
    ).toBe('https://staging-app.kilo.ai');
  });

  it('uses the production origin for production deployments', () => {
    expect(
      resolveAppUrl({
        nodeEnv: 'production',
        vercelTargetEnv: 'production',
      })
    ).toBe('https://app.kilo.ai');
  });

  it('allows an explicit origin to override deployment defaults', () => {
    expect(
      resolveAppUrl({
        appUrlOverride: 'https://custom.example.com/path/',
        nodeEnv: 'production',
        vercelTargetEnv: 'staging',
      })
    ).toBe('https://custom.example.com');
  });

  it('uses the configured local port outside production', () => {
    expect(resolveAppUrl({ nodeEnv: 'development', port: '3210' })).toBe('http://localhost:3210');
  });
});
