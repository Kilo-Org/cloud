import { describe, expect, it } from 'vitest';
import { getSecurityAgentCommandLifecycleConfig } from './command-lifecycle-config.js';

describe('getSecurityAgentCommandLifecycleConfig', () => {
  it('uses current default timeouts and retention', () => {
    expect(getSecurityAgentCommandLifecycleConfig({})).toEqual({
      acceptedCommandTimeoutMs: 5 * 60 * 1000,
      runningCommandTimeoutMs: 30 * 60 * 1000,
      commandRetentionMs: 30 * 24 * 60 * 60 * 1000,
    });
  });

  it('accepts positive integer overrides', () => {
    expect(
      getSecurityAgentCommandLifecycleConfig({
        SECURITY_AGENT_COMMAND_ACCEPTED_TIMEOUT_MS: '60000',
        SECURITY_AGENT_COMMAND_RUNNING_TIMEOUT_MS: '120000',
        SECURITY_AGENT_COMMAND_RETENTION_DAYS: '45',
      })
    ).toEqual({
      acceptedCommandTimeoutMs: 60_000,
      runningCommandTimeoutMs: 120_000,
      commandRetentionMs: 45 * 24 * 60 * 60 * 1000,
    });
  });

  it('falls back on invalid overrides', () => {
    expect(
      getSecurityAgentCommandLifecycleConfig({
        SECURITY_AGENT_COMMAND_ACCEPTED_TIMEOUT_MS: '0',
        SECURITY_AGENT_COMMAND_RUNNING_TIMEOUT_MS: '1.5',
        SECURITY_AGENT_COMMAND_RETENTION_DAYS: 'many',
      })
    ).toEqual({
      acceptedCommandTimeoutMs: 5 * 60 * 1000,
      runningCommandTimeoutMs: 30 * 60 * 1000,
      commandRetentionMs: 30 * 24 * 60 * 60 * 1000,
    });
  });
});
