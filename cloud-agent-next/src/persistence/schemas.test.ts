import { describe, it, expect } from 'vitest';
import { MCPServerConfigSchema, MetadataSchema } from './schemas.js';
import type { MCPServerConfig } from './types.js';

describe('MCPServerConfigSchema', () => {
  describe('valid local configuration', () => {
    it('should accept valid local config with command array', () => {
      const config = {
        type: 'local' as const,
        command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
      });
    });

    it('should accept local config with all optional fields', () => {
      const config = {
        type: 'local' as const,
        command: ['node', 'server.js'],
        environment: { NODE_ENV: 'production' },
        enabled: true,
        timeout: 30000,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'local',
        command: ['node', 'server.js'],
        environment: { NODE_ENV: 'production' },
        enabled: true,
        timeout: 30000,
      });
    });

    it('should accept local config with enabled: false', () => {
      const config = {
        type: 'local' as const,
        command: ['node', 'server.js'],
        enabled: false,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.enabled).toBe(false);
    });
  });

  describe('valid remote configuration', () => {
    it('should accept valid remote config with URL', () => {
      const config = {
        type: 'remote' as const,
        url: 'https://mcp-server.example.com/sse',
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'remote',
        url: 'https://mcp-server.example.com/sse',
      });
    });

    it('should accept remote config with headers', () => {
      const config = {
        type: 'remote' as const,
        url: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      });
    });

    it('should accept remote config with all optional fields', () => {
      const config = {
        type: 'remote' as const,
        url: 'https://example.com/mcp',
        headers: { 'X-API-Key': 'key456' },
        enabled: false,
        timeout: 60000,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { 'X-API-Key': 'key456' },
        enabled: false,
        timeout: 60000,
      });
    });
  });

  describe('local missing/invalid command', () => {
    it('should reject local config without command field', () => {
      const config = { type: 'local' };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject local config with empty command array', () => {
      const config = {
        type: 'local' as const,
        command: [],
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });
  });

  describe('remote invalid URL', () => {
    it('should reject remote config with malformed URL', () => {
      const config = {
        type: 'remote' as const,
        url: 'not-a-valid-url',
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject remote config without protocol', () => {
      const config = {
        type: 'remote' as const,
        url: 'example.com/mcp',
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('missing type discriminator', () => {
    it('should reject config without type field', () => {
      const config = { command: ['node', 'server.js'] };
      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject config with unknown type', () => {
      const config = { type: 'stdio', command: 'node' };
      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('strict mode rejects unknown fields', () => {
    it('should reject local config with url field', () => {
      const config = {
        type: 'local' as const,
        command: ['node'],
        url: 'https://example.com',
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject local config with headers field', () => {
      const config = {
        type: 'local' as const,
        command: ['node'],
        headers: { Authorization: 'Bearer token' },
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject remote config with command field', () => {
      const config = {
        type: 'remote' as const,
        url: 'https://example.com',
        command: ['node'],
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject remote config with environment field', () => {
      const config = {
        type: 'remote' as const,
        url: 'https://example.com',
        environment: { NODE_ENV: 'production' },
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject local config with legacy fields', () => {
      const config = {
        type: 'local' as const,
        command: ['node'],
        alwaysAllow: ['tool1'],
      };
      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });
  });

  describe('optional fields', () => {
    it('should accept timeout on local config', () => {
      const config = {
        type: 'local' as const,
        command: ['node'],
        timeout: 30000,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.timeout).toBe(30000);
    });

    it('should not add defaults for missing optional fields', () => {
      const config = {
        type: 'local' as const,
        command: ['node'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({ type: 'local', command: ['node'] });
    });
  });
});

describe('MetadataSchema', () => {
  describe('valid envVars', () => {
    it('should accept valid environment variables within limits', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars: {
          NODE_ENV: 'production',
          API_KEY: 'secret123',
          DEBUG: 'true',
        },
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.envVars).toEqual({
        NODE_ENV: 'production',
        API_KEY: 'secret123',
        DEBUG: 'true',
      });
    });

    it('should accept exactly 50 environment variables', () => {
      const envVars: Record<string, string> = {};
      for (let i = 1; i <= 50; i++) {
        envVars[`VAR_${i}`] = `value${i}`;
      }

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars,
      };

      const result = MetadataSchema.parse(metadata);
      expect(Object.keys(result.envVars!).length).toBe(50);
    });

    it('should accept keys and values at maximum length', () => {
      const longKey = 'A'.repeat(256);
      const longValue = 'B'.repeat(256);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars: {
          [longKey]: longValue,
        },
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.envVars![longKey]).toBe(longValue);
    });
  });

  describe('too many envVars', () => {
    it('should reject more than 50 environment variables', () => {
      const envVars: Record<string, string> = {};
      for (let i = 1; i <= 51; i++) {
        envVars[`VAR_${i}`] = `value${i}`;
      }

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars,
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          'Maximum 50 environment variables allowed'
        );
      }
    });
  });

  describe('key too long', () => {
    it('should reject env var keys exceeding 256 characters', () => {
      const longKey = 'A'.repeat(257);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars: {
          [longKey]: 'value',
        },
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });
  });

  describe('value too long', () => {
    it('should reject env var values exceeding 256 characters', () => {
      const longValue = 'B'.repeat(257);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        envVars: {
          KEY: longValue,
        },
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });
  });

  describe('valid setupCommands', () => {
    it('should accept valid setup commands within limits', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        setupCommands: ['npm install', 'npm run build', 'npm test'],
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.setupCommands).toEqual(['npm install', 'npm run build', 'npm test']);
    });

    it('should accept exactly 20 setup commands', () => {
      const setupCommands: string[] = [];
      for (let i = 1; i <= 20; i++) {
        setupCommands.push(`command ${i}`);
      }

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        setupCommands,
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.setupCommands!.length).toBe(20);
    });

    it('should accept commands at maximum length', () => {
      const longCommand = 'A'.repeat(500);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        setupCommands: [longCommand],
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.setupCommands![0]).toBe(longCommand);
    });
  });

  describe('too many commands', () => {
    it('should reject more than 20 setup commands', () => {
      const setupCommands: string[] = [];
      for (let i = 1; i <= 21; i++) {
        setupCommands.push(`command ${i}`);
      }

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        setupCommands,
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });
  });

  describe('command too long', () => {
    it('should reject commands exceeding 500 characters', () => {
      const longCommand = 'A'.repeat(501);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        setupCommands: [longCommand],
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });
  });

  describe('valid mcpServers', () => {
    it('should accept valid record of MCP server configs', () => {
      const mcpServers: Record<string, MCPServerConfig> = {
        puppeteer: {
          type: 'local',
          command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
        },
        remote: {
          type: 'remote',
          url: 'https://example.com/mcp',
        },
      };

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        mcpServers,
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.mcpServers).toBeDefined();
      expect(result.mcpServers!['puppeteer'].type).toBe('local');
      expect(result.mcpServers!['remote'].type).toBe('remote');
    });

    it('should accept server names at maximum length', () => {
      const longServerName = 'A'.repeat(100);
      const mcpServers: Record<string, MCPServerConfig> = {
        [longServerName]: {
          type: 'local',
          command: ['node'],
        },
      };

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        mcpServers,
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.mcpServers![longServerName]).toBeDefined();
    });
  });

  describe('server name too long', () => {
    it('should reject server names exceeding 100 characters', () => {
      const longServerName = 'A'.repeat(101);
      const mcpServers: Record<string, MCPServerConfig> = {
        [longServerName]: {
          type: 'local',
          command: ['node'],
        },
      };

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        mcpServers,
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });
  });

  describe('required fields', () => {
    it('should accept metadata with all required fields', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
      };

      const result = MetadataSchema.parse(metadata);
      expect(result).toMatchObject({
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
      });
    });

    it('should reject metadata missing required fields', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        // Missing orgId, userId, timestamp
      };

      expect(() => MetadataSchema.parse(metadata)).toThrow();
    });
  });

  describe('optional fields', () => {
    it('should accept optional githubRepo and githubToken', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        githubRepo: 'facebook/react',
        githubToken: 'ghp_token123',
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.githubRepo).toBe('facebook/react');
      expect(result.githubToken).toBe('ghp_token123');
    });

    it('should work without optional fields', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.envVars).toBeUndefined();
      expect(result.setupCommands).toBeUndefined();
      expect(result.mcpServers).toBeUndefined();
      expect(result.githubRepo).toBeUndefined();
      expect(result.githubToken).toBeUndefined();
    });
  });

  describe('appendSystemPrompt', () => {
    it('should accept valid appendSystemPrompt', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        appendSystemPrompt: 'Always respond in JSON format.',
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.appendSystemPrompt).toBe('Always respond in JSON format.');
    });

    it('should accept appendSystemPrompt at maximum length (10000 chars)', () => {
      const longPrompt = 'A'.repeat(10000);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        appendSystemPrompt: longPrompt,
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.appendSystemPrompt).toBe(longPrompt);
    });

    it('should reject appendSystemPrompt exceeding 10000 characters', () => {
      const tooLongPrompt = 'A'.repeat(10001);

      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        appendSystemPrompt: tooLongPrompt,
      };

      const result = MetadataSchema.safeParse(metadata);
      expect(result.success).toBe(false);
    });

    it('should work without appendSystemPrompt', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.appendSystemPrompt).toBeUndefined();
    });
  });
});
