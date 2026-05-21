import { describe, expect, it } from 'vitest';

import {
  CurrentSessionMetadataSchema,
  parseSessionMetadata,
  serializeSessionMetadata,
} from './session-metadata.js';

const callbackTarget = {
  url: 'https://example.com/callback',
  headers: { 'X-Test': '1' },
};

const profile = {
  envVars: { NODE_ENV: 'test' },
  setupCommands: ['pnpm install'],
  runtimeAgents: [
    {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { mode: 'primary' as const, model: 'kilo/gpt-5' },
    },
  ],
};

describe('session metadata boundary', () => {
  it('parses and serializes current grouped metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_123',
        userId: 'user_123',
        orgId: 'org_123',
        botId: 'bot_123',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {
        kiloSessionId: 'cli_123',
        kilocodeToken: 'kilo-token',
      },
      repository: {
        type: 'github' as const,
        repo: 'acme/repo',
        token: 'github-token',
        githubInstallationId: '987',
        githubAppType: 'standard' as const,
        upstreamBranch: 'main',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'Build the thing',
        images: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.png'],
        },
      },
      agent: {
        mode: 'reviewer',
        model: 'kilo/gpt-5',
        variant: 'thinking',
        appendSystemPrompt: 'Extra context',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
        gateThreshold: 'warning' as const,
      },
      profile,
      callback: { target: callbackTarget },
      workspace: {
        sandboxId: 'usr-abcdef' as const,
        workspacePath: '/workspace',
        sessionHome: '/home/kilo',
        branchName: 'session/agent_123',
        shallow: true,
      },
      lifecycle: {
        version: 1234,
        timestamp: 1234,
        preparedAt: 1235,
        initiatedAt: 1236,
        kiloServerLastActivity: 1237,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
    expect(CurrentSessionMetadataSchema.parse(current)).toEqual(current);
  });

  it('parses and serializes current grouped DIND workspace metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_dind',
        userId: 'user_dind',
      },
      auth: {},
      workspace: {
        sandboxId: 'dind-abcdef' as const,
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('parses and serializes current grouped initial command metadata', () => {
    const current = {
      metadataSchemaVersion: 2 as const,
      identity: {
        sessionId: 'agent_command',
        userId: 'user_command',
      },
      auth: {
        kiloSessionId: 'cli_command',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bCmdMetaAbCdEfG',
        prompt: '/compact --aggressive',
        turn: {
          type: 'command' as const,
          command: 'compact',
          arguments: '--aggressive',
        },
      },
      lifecycle: {
        version: 1,
        timestamp: 1,
      },
    };

    expect(parseSessionMetadata(current)).toEqual(current);
    expect(serializeSessionMetadata(current)).toEqual(current);
  });

  it('maps legacy flat metadata into grouped current metadata', () => {
    const legacy = {
      version: 1234,
      timestamp: 1234,
      sessionId: 'agent_123',
      userId: 'user_123',
      orgId: 'org_123',
      botId: 'bot_123',
      createdOnPlatform: 'cloud-agent-web',
      kiloSessionId: 'cli_123',
      kilocodeToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      githubInstallationId: '987',
      githubAppType: 'standard' as const,
      upstreamBranch: 'main',
      prompt: 'Build the thing',
      initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      images: {
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: ['123e4567-e89b-12d3-a456-426614174001.png'],
      },
      mode: 'reviewer',
      model: 'kilo/gpt-5',
      variant: 'thinking',
      appendSystemPrompt: 'Extra context',
      autoCommit: true,
      condenseOnComplete: false,
      gateThreshold: 'warning' as const,
      callbackTarget,
      workspacePath: '/workspace',
      sessionHome: '/home/kilo',
      branchName: 'session/agent_123',
      sandboxId: 'usr-abcdef',
      shallow: true,
      preparedAt: 1235,
      initiatedAt: 1236,
      kiloServerLastActivity: 1237,
      profile,
    };

    expect(parseSessionMetadata(legacy)).toEqual({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: 'agent_123',
        userId: 'user_123',
        orgId: 'org_123',
        botId: 'bot_123',
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {
        kiloSessionId: 'cli_123',
        kilocodeToken: 'kilo-token',
      },
      repository: {
        type: 'github',
        repo: 'acme/repo',
        githubInstallationId: '987',
        githubAppType: 'standard',
        upstreamBranch: 'main',
      },
      initialMessage: {
        id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'Build the thing',
        images: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.png'],
        },
      },
      agent: {
        mode: 'reviewer',
        model: 'kilo/gpt-5',
        variant: 'thinking',
        appendSystemPrompt: 'Extra context',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
        gateThreshold: 'warning',
      },
      profile,
      callback: { target: callbackTarget },
      workspace: {
        sandboxId: 'usr-abcdef',
        workspacePath: '/workspace',
        sessionHome: '/home/kilo',
        branchName: 'session/agent_123',
        shallow: true,
      },
      lifecycle: {
        version: 1234,
        timestamp: 1234,
        preparedAt: 1235,
        initiatedAt: 1236,
        kiloServerLastActivity: 1237,
      },
    });
  });

  it('maps legacy DIND devcontainer metadata into grouped current metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_legacy_dind',
      userId: 'user_legacy_dind',
      sandboxId: 'dind-abcdef',
      devcontainer: {
        workspacePath: '/workspace/user/sessions/agent_legacy_dind',
        innerWorkspaceFolder: '/workspaces/repo',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      },
    });

    expect(metadata.workspace?.sandboxId).toBe('dind-abcdef');
    expect(metadata.devcontainer).toEqual({
      workspacePath: '/workspace/user/sessions/agent_legacy_dind',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    });
    expect(serializeSessionMetadata(metadata)).toEqual(metadata);
  });

  it('maps legacy gitlab metadata into grouped repository metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_gitlab',
      userId: 'user_123',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'gitlab-token',
      platform: 'gitlab' as const,
      gitlabTokenManaged: true,
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.repository).toEqual({
      type: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
      gitlabTokenManaged: true,
    });
  });

  it('preserves legacy generic git tokens in grouped repository metadata', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_git',
      userId: 'user_123',
      gitUrl: 'https://git.example.com/acme/repo.git',
      gitToken: 'generic-git-token',
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.repository).toEqual({
      type: 'git',
      url: 'https://git.example.com/acme/repo.git',
      token: 'generic-git-token',
    });
  });

  it('falls back to legacy flat profile fields only inside the parser boundary', () => {
    const metadata = parseSessionMetadata({
      version: 1,
      timestamp: 1,
      sessionId: 'agent_profile',
      userId: 'user_123',
      envVars: { A: 'B' },
      setupCommands: ['echo ok'],
      mode: 'code',
      model: 'kilo/gpt-5',
    });

    expect(metadata.profile).toEqual({
      envVars: { A: 'B' },
      setupCommands: ['echo ok'],
    });
  });

  it('does not parse invalid current metadata as legacy', () => {
    expect(() =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        version: 1,
        timestamp: 1,
        sessionId: 'agent_flat',
        userId: 'user_123',
      })
    ).toThrow('Invalid current session metadata');
  });
});
