import { describe, expect, it } from 'vitest';

import { MASKED_MCP_VALUE } from '@/components/profiles/mcp-json';
import {
  buildMcpServerPayload,
  commandParts,
  countSecretValues,
  initialMcpFormState,
  type McpFormState,
  mcpServerRows,
  type McpServerSource,
  mcpServerSummary,
  validateMcpForm,
} from '@/components/profiles/profile-mcp-model';

function localSource(overrides: Partial<McpServerSource> = {}): McpServerSource {
  return {
    id: 'mcp-1',
    name: 'docs',
    type: 'local',
    enabled: true,
    timeout: null,
    config: { command: ['npx', '@example/mcp'], environment: { API_KEY: MASKED_MCP_VALUE } },
    ...overrides,
  };
}

function remoteSource(overrides: Partial<McpServerSource> = {}): McpServerSource {
  return {
    id: 'mcp-2',
    name: 'remote',
    type: 'remote',
    enabled: false,
    timeout: 5000,
    config: { url: 'https://example.com/mcp', headers: { Authorization: MASKED_MCP_VALUE } },
    ...overrides,
  };
}

describe('countSecretValues', () => {
  it('counts environment keys on a local server', () => {
    expect(countSecretValues(localSource())).toBe(1);
  });

  it('counts header keys on a remote server', () => {
    expect(countSecretValues(remoteSource())).toBe(1);
  });

  it('is zero when there is no record', () => {
    expect(countSecretValues(localSource({ config: { command: ['npx'] } }))).toBe(0);
    expect(countSecretValues(remoteSource({ config: { url: 'https://x.test' } }))).toBe(0);
  });
});

describe('mcpServerSummary', () => {
  it('joins the command line for a local server', () => {
    expect(mcpServerSummary(localSource())).toBe('npx @example/mcp');
  });

  it('uses the URL for a remote server', () => {
    expect(mcpServerSummary(remoteSource())).toBe('https://example.com/mcp');
  });
});

describe('mcpServerRows', () => {
  it('projects name, type, enabled, summary and secret count', () => {
    expect(mcpServerRows([localSource(), remoteSource()])).toEqual([
      {
        id: 'mcp-1',
        name: 'docs',
        type: 'local',
        enabled: true,
        summary: 'npx @example/mcp',
        secretCount: 1,
      },
      {
        id: 'mcp-2',
        name: 'remote',
        type: 'remote',
        enabled: false,
        summary: 'https://example.com/mcp',
        secretCount: 1,
      },
    ]);
  });
});

describe('initialMcpFormState', () => {
  it('seeds blank defaults for an add', () => {
    expect(initialMcpFormState()).toEqual({
      name: '',
      type: 'local',
      enabled: true,
      command: '',
      url: '',
      configJson: '',
      timeout: '',
    });
  });

  it('seeds a local server with its command line and masked environment', () => {
    const state = initialMcpFormState(localSource());
    expect(state.type).toBe('local');
    expect(state.command).toBe('npx @example/mcp');
    expect(state.url).toBe('');
    expect(JSON.parse(state.configJson)).toEqual({ API_KEY: MASKED_MCP_VALUE });
    expect(state.timeout).toBe('');
  });

  it('seeds a remote server with its url, masked headers and timeout', () => {
    const state = initialMcpFormState(remoteSource());
    expect(state.type).toBe('remote');
    expect(state.url).toBe('https://example.com/mcp');
    expect(JSON.parse(state.configJson)).toEqual({ Authorization: MASKED_MCP_VALUE });
    expect(state.timeout).toBe('5000');
  });
});

describe('commandParts', () => {
  it('splits on whitespace and drops blanks', () => {
    expect(commandParts('  npx   @example/mcp  --flag ')).toEqual([
      'npx',
      '@example/mcp',
      '--flag',
    ]);
    expect(commandParts('   ')).toEqual([]);
  });
});

function formState(overrides: Partial<McpFormState> = {}): McpFormState {
  return {
    name: 'docs',
    type: 'local',
    enabled: true,
    command: 'npx @example/mcp',
    url: '',
    configJson: '',
    timeout: '',
    ...overrides,
  };
}

describe('validateMcpForm', () => {
  it('accepts a valid local form', () => {
    expect(validateMcpForm(formState())).toBeNull();
  });

  it('requires a name and refuses a name outside the server pattern', () => {
    expect(validateMcpForm(formState({ name: '  ' }))).toBe('name-required');
    expect(validateMcpForm(formState({ name: 'bad name' }))).toBe('name-invalid');
  });

  it('requires a command for a local server', () => {
    expect(validateMcpForm(formState({ command: '   ' }))).toBe('command-required');
  });

  it('requires a parseable url for a remote server', () => {
    expect(validateMcpForm(formState({ type: 'remote', url: '' }))).toBe('url-required');
    expect(validateMcpForm(formState({ type: 'remote', url: 'not a url' }))).toBe('url-invalid');
    expect(
      validateMcpForm(formState({ type: 'remote', url: 'https://example.com/mcp' }))
    ).toBeNull();
  });

  it('refuses a timeout that is not a bounded integer', () => {
    expect(validateMcpForm(formState({ timeout: 'abc' }))).toBe('timeout-invalid');
    expect(validateMcpForm(formState({ timeout: '0' }))).toBe('timeout-invalid');
    expect(validateMcpForm(formState({ timeout: '1.5' }))).toBe('timeout-invalid');
    expect(validateMcpForm(formState({ timeout: '5000' }))).toBeNull();
  });

  it('refuses an env/header fragment that is not a string record', () => {
    expect(validateMcpForm(formState({ configJson: '{' }))).toBe('json-invalid');
    expect(validateMcpForm(formState({ configJson: '{"PORT":8080}' }))).toBe('json-invalid');
    expect(validateMcpForm(formState({ configJson: '{"API_KEY":"x"}' }))).toBeNull();
  });
});

describe('buildMcpServerPayload', () => {
  it('builds a local payload with command, environment and timeout', () => {
    expect(
      buildMcpServerPayload(
        formState({ configJson: '{"API_KEY":"sk-1"}', timeout: '5000', enabled: false })
      )
    ).toEqual({
      type: 'local',
      name: 'docs',
      enabled: false,
      timeout: 5000,
      config: { command: ['npx', '@example/mcp'], environment: { API_KEY: 'sk-1' } },
    });
  });

  it('builds a remote payload with url and headers', () => {
    expect(
      buildMcpServerPayload(
        formState({
          type: 'remote',
          url: ' https://example.com/mcp ',
          configJson: '{"Authorization":"Bearer x"}',
        })
      )
    ).toEqual({
      type: 'remote',
      name: 'docs',
      enabled: true,
      config: {
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    });
  });

  it('omits environment, headers and timeout when empty', () => {
    expect(buildMcpServerPayload(formState())).toEqual({
      type: 'local',
      name: 'docs',
      enabled: true,
      config: { command: ['npx', '@example/mcp'] },
    });
  });
});
