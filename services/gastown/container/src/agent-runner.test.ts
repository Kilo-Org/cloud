import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
}));
vi.mock('./git-manager', () => ({
  cloneRepo: vi.fn(),
  createWorktree: vi.fn(),
  setupRigBrowseWorktree: vi.fn(),
}));
vi.mock('./process-manager', () => ({
  startAgent: vi.fn(),
}));
vi.mock('./control-server', () => ({
  getCurrentTownConfig: vi.fn(() => ({})),
}));
vi.mock('./logger', () => ({
  log: { info: vi.fn() },
}));

import { buildAgentEnv, buildKiloAuthEnv, buildKiloConfigContent } from './agent-runner';
import type { StartAgentRequest } from './types';

function baseRequest(overrides: Partial<StartAgentRequest> = {}): StartAgentRequest {
  return {
    agentId: 'agent-1',
    rigId: 'rig-1',
    townId: 'town-1',
    role: 'polecat',
    name: 'TestAgent',
    identity: 'TestAgent-polecat-1',
    prompt: 'test prompt',
    model: 'anthropic/claude-sonnet-4.6',
    gitUrl: 'https://github.com/test/repo.git',
    branch: 'gt/test',
    defaultBranch: 'main',
    ...overrides,
  };
}

describe('buildAgentEnv', () => {
  it('sets KILO_AUTH_CONTENT with valid JSON auth for the kilo provider when KILOCODE_TOKEN is present', () => {
    const env = buildAgentEnv(
      baseRequest({
        envVars: { KILOCODE_TOKEN: 'tok-123' },
      })
    );

    expect(env.KILO_AUTH_CONTENT).toBeDefined();
    const parsed = JSON.parse(env.KILO_AUTH_CONTENT);
    expect(parsed).toEqual({ kilo: { type: 'api', key: 'tok-123' } });
  });

  it('does not set KILO_AUTH_CONTENT when KILOCODE_TOKEN is absent', () => {
    const prev = process.env.KILOCODE_TOKEN;
    delete process.env.KILOCODE_TOKEN;
    try {
      const env = buildAgentEnv(baseRequest());
      expect(env.KILO_AUTH_CONTENT).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KILOCODE_TOKEN = prev;
    }
  });

  it('sets KILO_PLATFORM to gastown', () => {
    const prev = process.env.KILOCODE_TOKEN;
    delete process.env.KILOCODE_TOKEN;
    try {
      const env = buildAgentEnv(baseRequest());
      expect(env.KILO_PLATFORM).toBe('gastown');
    } finally {
      if (prev !== undefined) process.env.KILOCODE_TOKEN = prev;
    }
  });

  it('sets KILO_ORG_ID when organizationId is provided', () => {
    const env = buildAgentEnv(
      baseRequest({
        organizationId: 'org-abc',
        envVars: { KILOCODE_TOKEN: 'tok-123' },
      })
    );
    expect(env.KILO_ORG_ID).toBe('org-abc');
  });

  it('does not set KILO_ORG_ID when organizationId is absent', () => {
    const prev = process.env.KILOCODE_TOKEN;
    delete process.env.KILOCODE_TOKEN;
    try {
      const env = buildAgentEnv(baseRequest());
      expect(env.KILO_ORG_ID).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KILOCODE_TOKEN = prev;
    }
  });
});

describe('buildKiloConfigContent', () => {
  it('includes kilocodeOrganizationId when organizationId is provided', () => {
    const json = buildKiloConfigContent(
      'tok',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5',
      'org-xyz'
    );
    const parsed = JSON.parse(json);
    expect(parsed.provider.kilo.options.kilocodeOrganizationId).toBe('org-xyz');
  });

  it('omits kilocodeOrganizationId when organizationId is absent', () => {
    const json = buildKiloConfigContent(
      'tok',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5'
    );
    const parsed = JSON.parse(json);
    expect(parsed.provider.kilo.options.kilocodeOrganizationId).toBeUndefined();
  });
});

describe('buildKiloAuthEnv', () => {
  it('sets KILO_PLATFORM to gastown', () => {
    const env = buildKiloAuthEnv(undefined, undefined);
    expect(env.KILO_PLATFORM).toBe('gastown');
  });

  it('sets KILO_AUTH_CONTENT when kilocodeToken is provided', () => {
    const env = buildKiloAuthEnv('tok-abc', undefined);
    expect(env.KILO_AUTH_CONTENT).toBe(JSON.stringify({ kilo: { type: 'api', key: 'tok-abc' } }));
  });

  it('omits KILO_AUTH_CONTENT when kilocodeToken is absent', () => {
    const env = buildKiloAuthEnv(undefined, undefined);
    expect(env.KILO_AUTH_CONTENT).toBeUndefined();
  });

  it('sets KILO_ORG_ID when organizationId is provided', () => {
    const env = buildKiloAuthEnv('tok', 'org-123');
    expect(env.KILO_ORG_ID).toBe('org-123');
  });

  it('omits KILO_ORG_ID when organizationId is null', () => {
    const env = buildKiloAuthEnv('tok', null);
    expect(env.KILO_ORG_ID).toBeUndefined();
  });

  it('omits KILO_ORG_ID when organizationId is undefined', () => {
    const env = buildKiloAuthEnv('tok', undefined);
    expect(env.KILO_ORG_ID).toBeUndefined();
  });

  it('sets all three env vars when both inputs are provided', () => {
    const env = buildKiloAuthEnv('tok-full', 'org-full');
    expect(env).toEqual({
      KILO_PLATFORM: 'gastown',
      KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'tok-full' } }),
      KILO_ORG_ID: 'org-full',
    });
  });
});
