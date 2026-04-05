import { describe, it, expect } from 'vitest';
import { buildWrapperArgs, buildWrapperEnvBase } from './wrapper-plan.js';
import type { ExecutionId, SessionId } from '../types/ids.js';

describe('buildWrapperArgs', () => {
  const baseParams = {
    executionId: 'exec_12345678-1234-1234-1234-123456789abc' as ExecutionId,
    mode: 'code',
    promptFile: '/tmp/prompt-exec_12345678.txt',
  };

  it('should include required arguments', () => {
    const args = buildWrapperArgs(baseParams);

    expect(args).toContain('/usr/local/bin/kilocode-wrapper.js');
    expect(args).toContain(`--execution-id=${baseParams.executionId}`);
    expect(args).toContain(`--ingest-token=${baseParams.executionId}`);
    expect(args).toContain(`--mode=${baseParams.mode}`);
    expect(args).toContain(`--prompt=${baseParams.promptFile}`);
  });

  it('should include --auto-commit when autoCommit is true', () => {
    const args = buildWrapperArgs({ ...baseParams, autoCommit: true });

    expect(args).toContain('--auto-commit');
  });

  it('should not include --auto-commit when autoCommit is false', () => {
    const args = buildWrapperArgs({ ...baseParams, autoCommit: false });

    expect(args).not.toContain('--auto-commit');
  });

  it('should include --condense-on-complete when condenseOnComplete is true', () => {
    const args = buildWrapperArgs({ ...baseParams, condenseOnComplete: true });

    expect(args).toContain('--condense-on-complete');
  });

  it('should not include --condense-on-complete when condenseOnComplete is false', () => {
    const args = buildWrapperArgs({ ...baseParams, condenseOnComplete: false });

    expect(args).not.toContain('--condense-on-complete');
  });

  it('should include --idle-timeout when idleTimeoutMs is provided', () => {
    const args = buildWrapperArgs({ ...baseParams, idleTimeoutMs: 60000 });

    expect(args).toContain('--idle-timeout=60000');
  });

  it('should not include --idle-timeout when idleTimeoutMs is not provided', () => {
    const args = buildWrapperArgs(baseParams);

    expect(args.some(arg => arg.startsWith('--idle-timeout'))).toBe(false);
  });

  it('should include --append-system-prompt-file when appendSystemPromptFile is provided', () => {
    const appendSystemPromptFile = '/tmp/append-system-prompt-exec_12345678.txt';
    const args = buildWrapperArgs({ ...baseParams, appendSystemPromptFile });

    expect(args).toContain(`--append-system-prompt-file=${appendSystemPromptFile}`);
  });

  it('should not include --append-system-prompt-file when appendSystemPromptFile is not provided', () => {
    const args = buildWrapperArgs(baseParams);

    expect(args.some(arg => arg.startsWith('--append-system-prompt-file'))).toBe(false);
  });

  it('should not include --append-system-prompt-file when appendSystemPromptFile is empty string', () => {
    const args = buildWrapperArgs({ ...baseParams, appendSystemPromptFile: '' });

    expect(args.some(arg => arg.startsWith('--append-system-prompt-file'))).toBe(false);
  });
});

describe('buildWrapperEnvBase', () => {
  const baseParams = {
    sessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
    userId: 'user_abc123',
  };

  it('should include required environment variables', () => {
    const env = buildWrapperEnvBase(baseParams);

    expect(env.SESSION_ID).toBe(baseParams.sessionId);
    expect(env.USER_ID).toBe(baseParams.userId);
  });

  it('should include optional orgId when provided', () => {
    const env = buildWrapperEnvBase({ ...baseParams, orgId: 'org_xyz789' });

    expect(env.ORG_ID).toBe('org_xyz789');
  });

  it('should set empty string for orgId when not provided', () => {
    const env = buildWrapperEnvBase(baseParams);

    expect(env.ORG_ID).toBe('');
  });

  it('should include kilocodeToken when provided', () => {
    const env = buildWrapperEnvBase({ ...baseParams, kilocodeToken: 'token123' });

    expect(env.KILOCODE_TOKEN).toBe('token123');
  });

  it('should include kiloSessionId when provided', () => {
    const env = buildWrapperEnvBase({ ...baseParams, kiloSessionId: 'kilo-session-uuid' });

    expect(env.KILO_SESSION_ID).toBe('kilo-session-uuid');
  });

  it('should include upstreamBranch when provided', () => {
    const env = buildWrapperEnvBase({ ...baseParams, upstreamBranch: 'main' });

    expect(env.UPSTREAM_BRANCH).toBe('main');
  });
});
