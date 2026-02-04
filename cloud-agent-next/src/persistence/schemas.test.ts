import { describe, it, expect } from 'vitest';
import { MCPServerConfigSchema, MetadataSchema } from './schemas.js';
import type { MCPServerConfig } from './types.js';

describe('MCPServerConfigSchema', () => {
  describe('valid stdio configuration', () => {
    it('should accept valid stdio config with command and args', () => {
      const config = {
        type: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      });
    });

    it('should accept stdio config without explicit type', () => {
      const config = {
        command: 'node',
        args: ['server.js'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.type).toBe('stdio');
      expect(result.command).toBe('node');
    });

    it('should accept stdio config with optional fields', () => {
      const config = {
        command: 'node',
        args: ['server.js'],
        cwd: '/path/to/project',
        env: { NODE_ENV: 'production' },
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        cwd: '/path/to/project',
        env: { NODE_ENV: 'production' },
      });
    });
  });

  describe('valid SSE configuration', () => {
    it('should accept valid sse config with URL', () => {
      const config = {
        type: 'sse' as const,
        url: 'https://mcp-server.example.com/sse',
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'sse',
        url: 'https://mcp-server.example.com/sse',
      });
    });

    it('should accept sse config with headers', () => {
      const config = {
        type: 'sse' as const,
        url: 'https://example.com/sse',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'sse',
        url: 'https://example.com/sse',
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom-Header': 'value',
        },
      });
    });
  });

  describe('valid streamable-http configuration', () => {
    it('should accept valid streamable-http config with URL', () => {
      const config = {
        type: 'streamable-http' as const,
        url: 'https://mcp-server.example.com/stream',
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'streamable-http',
        url: 'https://mcp-server.example.com/stream',
      });
    });

    it('should accept streamable-http config with headers', () => {
      const config = {
        type: 'streamable-http' as const,
        url: 'https://example.com/stream',
        headers: {
          'X-API-Key': 'key456',
        },
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'streamable-http',
        url: 'https://example.com/stream',
        headers: {
          'X-API-Key': 'key456',
        },
      });
    });
  });

  describe('stdio missing command', () => {
    it('should reject stdio config without command field', () => {
      const config = {
        type: 'stdio' as const,
        args: ['server.js'],
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject stdio config with empty command', () => {
      const config = {
        command: '',
        args: ['server.js'],
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow('Command cannot be empty');
    });
  });

  describe('SSE invalid URL', () => {
    it('should reject SSE config with malformed URL', () => {
      const config = {
        type: 'sse' as const,
        url: 'not-a-valid-url',
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod returns "Invalid input" for discriminated union validation failures
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });

    it('should reject SSE config without protocol', () => {
      const config = {
        type: 'sse' as const,
        url: 'example.com/sse',
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject streamable-http config with malformed URL', () => {
      const config = {
        type: 'streamable-http' as const,
        url: 'invalid url with spaces',
      };

      const result = MCPServerConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod returns "Invalid input" for discriminated union validation failures
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('field contamination', () => {
    it('should reject stdio with URL field', () => {
      const config = {
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        url: 'https://example.com',
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject stdio with headers field', () => {
      const config = {
        command: 'node',
        headers: { Authorization: 'Bearer token' },
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject SSE with command field', () => {
      const config = {
        type: 'sse' as const,
        url: 'https://example.com',
        command: 'node',
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject SSE with args field', () => {
      const config = {
        type: 'sse' as const,
        url: 'https://example.com',
        args: ['--flag'],
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject streamable-http with command field', () => {
      const config = {
        type: 'streamable-http' as const,
        url: 'https://example.com',
        command: 'node',
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject streamable-http with env field', () => {
      const config = {
        type: 'streamable-http' as const,
        url: 'https://example.com',
        env: { NODE_ENV: 'production' },
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });
  });

  describe('BaseConfig fields', () => {
    it('should accept timeout field within valid range', () => {
      const config = {
        command: 'node',
        timeout: 120,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.timeout).toBe(120);
    });

    it('should reject timeout below minimum', () => {
      const config = {
        command: 'node',
        timeout: 0,
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should reject timeout above maximum', () => {
      const config = {
        command: 'node',
        timeout: 3601,
      };

      expect(() => MCPServerConfigSchema.parse(config)).toThrow();
    });

    it('should accept alwaysAllow field', () => {
      const config = {
        command: 'node',
        alwaysAllow: ['tool1', 'tool2', 'tool3'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.alwaysAllow).toEqual(['tool1', 'tool2', 'tool3']);
    });

    it('should accept watchPaths field', () => {
      const config = {
        command: 'node',
        watchPaths: ['/src', '/config'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.watchPaths).toEqual(['/src', '/config']);
    });

    it('should accept disabledTools field', () => {
      const config = {
        command: 'node',
        disabledTools: ['dangerous-tool', 'deprecated-tool'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.disabledTools).toEqual(['dangerous-tool', 'deprecated-tool']);
    });

    it('should accept all BaseConfig fields together', () => {
      const config = {
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        timeout: 90,
        alwaysAllow: ['read_file'],
        watchPaths: ['/src'],
        disabledTools: ['delete_file'],
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        timeout: 90,
        alwaysAllow: ['read_file'],
        watchPaths: ['/src'],
        disabledTools: ['delete_file'],
      });
    });

    it('should apply default values for alwaysAllow and disabledTools', () => {
      const config = {
        command: 'node',
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.alwaysAllow).toEqual([]);
      expect(result.disabledTools).toEqual([]);
    });

    it('should apply default timeout value', () => {
      const config = {
        command: 'node',
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result.timeout).toBe(60);
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
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-puppeteer'],
        },
        remote: {
          type: 'sse',
          url: 'https://example.com/sse',
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
      expect(result.mcpServers!.puppeteer.type).toBe('stdio');
      expect(result.mcpServers!.remote.type).toBe('sse');
    });

    it('should accept server names at maximum length', () => {
      const longServerName = 'A'.repeat(100);
      const mcpServers: Record<string, MCPServerConfig> = {
        [longServerName]: {
          command: 'node',
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
          command: 'node',
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
