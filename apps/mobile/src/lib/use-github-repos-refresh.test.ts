import { describe, expect, it } from 'vitest';

import {
  shouldClearConnectCheckFailed,
  shouldSetConnectCheckFailed,
} from './use-github-repos-refresh-helpers';

describe('shouldSetConnectCheckFailed', () => {
  it('sets when return-triggered AND integration not installed', () => {
    expect(
      shouldSetConnectCheckFailed({
        isReturnTriggered: true,
        integrationInstalled: false,
      })
    ).toBe(true);
  });

  it('does NOT set when return-triggered but integration IS installed', () => {
    expect(
      shouldSetConnectCheckFailed({
        isReturnTriggered: true,
        integrationInstalled: true,
      })
    ).toBe(false);
  });

  it('does NOT set when NOT return-triggered (manual Refresh / Check again)', () => {
    expect(
      shouldSetConnectCheckFailed({
        isReturnTriggered: false,
        integrationInstalled: false,
      })
    ).toBe(false);
  });

  it('does NOT set when integrationInstalled is undefined', () => {
    expect(
      shouldSetConnectCheckFailed({
        isReturnTriggered: true,
        integrationInstalled: undefined,
      })
    ).toBe(false);
  });
});

describe('shouldClearConnectCheckFailed', () => {
  it('clears when integration is installed', () => {
    expect(
      shouldClearConnectCheckFailed({
        integrationInstalled: true,
      })
    ).toBe(true);
  });

  it('does NOT clear when integration is not installed', () => {
    expect(
      shouldClearConnectCheckFailed({
        integrationInstalled: false,
      })
    ).toBe(false);
  });

  it('does NOT clear when integration is undefined', () => {
    expect(
      shouldClearConnectCheckFailed({
        integrationInstalled: undefined,
      })
    ).toBe(false);
  });
});
