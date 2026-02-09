import { describe, it, expect } from '@jest/globals';
import { needsResumeConfiguration } from './session-config';
import type { SessionConfig, ResumeConfig, StreamResumeConfig } from './types';

describe('needsResumeConfiguration', () => {
  it('returns false when no session is loaded', () => {
    expect(
      needsResumeConfiguration({
        currentDbSessionId: null,
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns false when resumeConfig is provided', () => {
    const resumeConfig: ResumeConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig,
        streamResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns false when streamResumeConfig is provided', () => {
    const streamResumeConfig: StreamResumeConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
      githubRepo: 'owner/repo',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns true for CLI session without valid config', () => {
    const invalidConfig: SessionConfig = {
      mode: 'build',
      model: '', // Empty model is invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('returns false for web session with valid config', () => {
    const validConfig: SessionConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'agent_xyz',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: validConfig,
      })
    ).toBe(false);
  });

  it('returns true for legacy web session with invalid config (empty model)', () => {
    const invalidConfig: SessionConfig = {
      mode: 'build',
      model: '', // Legacy sessions may have empty model
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('returns true when sessionConfig is null', () => {
    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(true);
  });

  it('returns true for session with invalid mode', () => {
    const invalidConfig: SessionConfig = {
      mode: 'invalid-mode', // Not a valid AgentMode, but SessionConfig.mode is string
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('prioritizes resumeConfig over invalid sessionConfig', () => {
    const resumeConfig: ResumeConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
    };

    const invalidConfig: SessionConfig = {
      mode: 'build',
      model: '', // Invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig,
        streamResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(false);
  });

  it('prioritizes streamResumeConfig over invalid sessionConfig', () => {
    const streamResumeConfig: StreamResumeConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
      githubRepo: 'owner/repo',
    };

    const invalidConfig: SessionConfig = {
      mode: 'build',
      model: '', // Invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        streamResumeConfig,
        sessionConfig: invalidConfig,
      })
    ).toBe(false);
  });
});
