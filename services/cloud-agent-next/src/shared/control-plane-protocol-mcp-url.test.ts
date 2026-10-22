import { describe, expect, it } from 'vitest';
import { controlPlaneSessionCredentialsPayloadSchema } from './control-plane-protocol.js';

const base = {
  sessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
  kilo: { token: 'kilo-token' },
};

function parse(url: string) {
  return controlPlaneSessionCredentialsPayloadSchema.safeParse({
    ...base,
    cloudAgentMcp: { url, token: 'mcp-token', expiresAt: 1893456000 },
  });
}

describe('cloudAgentMcp URL schema', () => {
  it('accepts the production endpoint and local dev endpoints', () => {
    expect(parse('https://mcp.kiloapps.io/mcp').success).toBe(true);
    expect(parse('http://localhost:8815/mcp').success).toBe(true);
    expect(parse('http://127.0.0.1:11715/mcp').success).toBe(true);
    expect(parse('http://host.docker.internal:11715/mcp').success).toBe(true);
  });

  it('rejects other remote endpoints', () => {
    expect(parse('https://example.com/mcp').success).toBe(false);
    expect(parse('http://example.com:8815/mcp').success).toBe(false);
    expect(parse('https://localhost:8815/mcp').success).toBe(false);
    expect(parse('http://host.docker.internal:11715/other').success).toBe(false);
  });
});
