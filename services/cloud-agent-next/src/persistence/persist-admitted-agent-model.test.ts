import { describe, expect, it } from 'vitest';

import { nextMetadataAfterAdmittedAgentModel } from './persist-admitted-agent-model.js';
import type { SessionMetadata } from './session-metadata.js';

function baseMetadata(agent: SessionMetadata['agent']): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_test',
      userId: 'user_test',
      orgId: 'org_test',
    },
    auth: {
      kiloSessionId: 'ses_test_aaaaaaaaaaaaaaaaaaaaaaaa',
      kilocodeToken: 'token',
    },
    agent,
    lifecycle: {
      version: 1,
      timestamp: 1,
    },
  };
}

describe('nextMetadataAfterAdmittedAgentModel', () => {
  it('returns null when metadata has no agent block', () => {
    expect(
      nextMetadataAfterAdmittedAgentModel(baseMetadata(undefined), {
        model: 'anthropic/claude-sonnet-4',
        variant: 'high',
      })
    ).toBeNull();
  });

  it('returns null when model and variant already match', () => {
    const metadata = baseMetadata({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
    expect(
      nextMetadataAfterAdmittedAgentModel(metadata, {
        model: 'anthropic/claude-sonnet-4',
        variant: 'high',
      })
    ).toBeNull();
  });

  it('returns updated metadata when model differs', () => {
    const metadata = baseMetadata({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
    const next = nextMetadataAfterAdmittedAgentModel(metadata, {
      model: 'openai/gpt-5',
      variant: 'high',
    });
    expect(next).not.toBeNull();
    expect(next?.agent).toEqual({
      mode: 'code',
      model: 'openai/gpt-5',
      variant: 'high',
    });
    expect(next?.lifecycle.version).toBeGreaterThan(metadata.lifecycle.version);
  });

  it('updates variant together with model when only variant differs', () => {
    const metadata = baseMetadata({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'low',
    });
    const next = nextMetadataAfterAdmittedAgentModel(metadata, {
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
    expect(next?.agent?.model).toBe('anthropic/claude-sonnet-4');
    expect(next?.agent?.variant).toBe('high');
  });

  it('clears variant when admitted run has no variant and stored had one', () => {
    const metadata = baseMetadata({
      mode: 'code',
      model: 'anthropic/claude-sonnet-4',
      variant: 'high',
    });
    const next = nextMetadataAfterAdmittedAgentModel(metadata, {
      model: 'anthropic/claude-sonnet-4',
    });
    expect(next?.agent?.variant).toBeUndefined();
  });
});
