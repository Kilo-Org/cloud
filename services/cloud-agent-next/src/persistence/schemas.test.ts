import { describe, it, expect } from 'vitest';
import {
  AttachmentsSchema,
  ImagesSchema,
  MCPServerConfigSchema,
  MetadataSchema,
  RuntimeAgentSchema,
  RuntimeSkillSchema,
  RuntimeSkillsSchema,
} from './schemas.js';
import type { MCPServerConfig } from './types.js';

describe('AttachmentsSchema', () => {
  it('accepts image and document UUID filenames up to the message limit', () => {
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: [
        '123e4567-e89b-12d3-a456-426614174001.pdf',
        '123e4567-e89b-12d3-a456-426614174002.txt',
        '123e4567-e89b-12d3-a456-426614174003.md',
        '123e4567-e89b-12d3-a456-426614174004.csv',
        '123e4567-e89b-12d3-a456-426614174005.jpeg',
      ],
    };

    expect(AttachmentsSchema.parse(attachments)).toEqual(attachments);
  });

  it('rejects unsupported document filename suffixes and more than five attachments', () => {
    expect(
      AttachmentsSchema.safeParse({
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: ['123e4567-e89b-12d3-a456-426614174001.docx'],
      }).success
    ).toBe(false);
    expect(
      AttachmentsSchema.safeParse({
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: [
          '123e4567-e89b-12d3-a456-426614174001.pdf',
          '123e4567-e89b-12d3-a456-426614174002.txt',
          '123e4567-e89b-12d3-a456-426614174003.md',
          '123e4567-e89b-12d3-a456-426614174004.png',
          '123e4567-e89b-12d3-a456-426614174005.jpg',
          '123e4567-e89b-12d3-a456-426614174006.gif',
        ],
      }).success
    ).toBe(false);
  });
});

describe('ImagesSchema', () => {
  it('retains legacy image descriptor acceptance without accepting document suffixes', () => {
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: [
        '123e4567-e89b-12d3-a456-426614174001.png',
        '123e4567-e89b-12d3-a456-426614174002.jpg',
        '123e4567-e89b-12d3-a456-426614174003.webp',
        '123e4567-e89b-12d3-a456-426614174004.gif',
        '123e4567-e89b-12d3-a456-426614174005.jpeg',
      ],
    };

    expect(ImagesSchema.parse(images)).toEqual(images);
    expect(
      ImagesSchema.safeParse({
        path: images.path,
        files: ['123e4567-e89b-12d3-a456-426614174006.pdf'],
      }).success
    ).toBe(false);
  });

  it('rejects client-provided R2 service prefixes', () => {
    const result = ImagesSchema.safeParse({
      path: 'app-builder/123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects hyphen-only image filenames without UUID segments', () => {
    const result = ImagesSchema.safeParse({
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['------------------------------------.png'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects more than five files and unsafe filenames', () => {
    expect(
      ImagesSchema.safeParse({
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: [
          '123e4567-e89b-12d3-a456-426614174001.png',
          '123e4567-e89b-12d3-a456-426614174002.png',
          '123e4567-e89b-12d3-a456-426614174003.png',
          '123e4567-e89b-12d3-a456-426614174004.png',
          '123e4567-e89b-12d3-a456-426614174005.png',
          '123e4567-e89b-12d3-a456-426614174006.png',
        ],
      }).success
    ).toBe(false);

    expect(
      ImagesSchema.safeParse({
        path: '123e4567-e89b-12d3-a456-426614174000',
        files: ['../123e4567-e89b-12d3-a456-426614174001.svg'],
      }).success
    ).toBe(false);
  });
});

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
      const envelope = {
        encryptedData: 'ciphertext',
        encryptedDEK: 'dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      };
      const config = {
        type: 'local' as const,
        command: ['node', 'server.js'],
        environment: { NODE_ENV: envelope },
        enabled: true,
        timeout: 30000,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'local',
        command: ['node', 'server.js'],
        environment: { NODE_ENV: envelope },
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
      const envelope = {
        encryptedData: 'ciphertext',
        encryptedDEK: 'dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      };
      const config = {
        type: 'remote' as const,
        url: 'https://example.com/mcp',
        headers: {
          Authorization: envelope,
          'X-Custom-Header': envelope,
        },
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: {
          Authorization: envelope,
          'X-Custom-Header': envelope,
        },
      });
    });

    it('should accept remote config with all optional fields', () => {
      const envelope = {
        encryptedData: 'ciphertext',
        encryptedDEK: 'dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      };
      const config = {
        type: 'remote' as const,
        url: 'https://example.com/mcp',
        headers: { 'X-API-Key': envelope },
        enabled: false,
        timeout: 60000,
      };

      const result = MCPServerConfigSchema.parse(config);
      expect(result).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { 'X-API-Key': envelope },
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
        environment: {
          NODE_ENV: {
            encryptedData: 'c',
            encryptedDEK: 'k',
            algorithm: 'rsa-aes-256-gcm',
            version: 1,
          },
        },
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

  describe('variant', () => {
    it('should accept valid variant string', () => {
      const metadata = {
        version: 1,
        sessionId: 'session123',
        orgId: 'org456',
        userId: 'user789',
        timestamp: Date.now(),
        variant: 'high',
      };

      const result = MetadataSchema.parse(metadata);
      expect(result.variant).toBe('high');
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

describe('MCPServerConfigSchema with mixed plain-string and envelope values', () => {
  const envelope = {
    encryptedData: 'ciphertext',
    encryptedDEK: 'dek',
    algorithm: 'rsa-aes-256-gcm' as const,
    version: 1 as const,
  };

  it('accepts local config with envelope-valued environment record', () => {
    const config = {
      type: 'local' as const,
      command: ['node', 'server.js'],
      environment: { API_KEY: envelope, OTHER: envelope },
    };

    const result = MCPServerConfigSchema.parse(config);
    expect(result.type).toBe('local');
    if (result.type === 'local') {
      const v = result.environment?.API_KEY;
      expect(typeof v).toBe('object');
      if (v && typeof v !== 'string') expect(v.algorithm).toBe('rsa-aes-256-gcm');
    }
  });

  it('accepts remote config with envelope-valued headers record', () => {
    const config = {
      type: 'remote' as const,
      url: 'https://example.com/mcp',
      headers: { Authorization: envelope },
    };

    const result = MCPServerConfigSchema.parse(config);
    expect(result.type).toBe('remote');
    if (result.type === 'remote') {
      const v = result.headers?.Authorization;
      expect(typeof v).toBe('object');
      if (v && typeof v !== 'string') expect(v.algorithm).toBe('rsa-aes-256-gcm');
    }
  });

  it('accepts plain-string environment values', () => {
    const config = {
      type: 'local' as const,
      command: ['node'],
      environment: { LOCALE: 'en-US', PORT: '4000' },
    };
    const result = MCPServerConfigSchema.parse(config);
    expect(result.type).toBe('local');
    if (result.type === 'local') {
      expect(result.environment?.LOCALE).toBe('en-US');
      expect(result.environment?.PORT).toBe('4000');
    }
  });

  it('accepts plain-string header values', () => {
    const config = {
      type: 'remote' as const,
      url: 'https://example.com/mcp',
      headers: { 'X-Region': 'eu-west-1' },
    };
    const result = MCPServerConfigSchema.parse(config);
    expect(result.type).toBe('remote');
    if (result.type === 'remote') {
      expect(result.headers?.['X-Region']).toBe('eu-west-1');
    }
  });

  it('accepts mixed plain-string and envelope environment values per key', () => {
    const config = {
      type: 'local' as const,
      command: ['node'],
      environment: { LOCALE: 'en-US', API_KEY: envelope },
    };
    const result = MCPServerConfigSchema.parse(config);
    if (result.type === 'local') {
      expect(result.environment?.LOCALE).toBe('en-US');
      const apiKey = result.environment?.API_KEY;
      expect(typeof apiKey).toBe('object');
    }
  });

  it('rejects environment values that are neither strings nor envelopes', () => {
    const bad = {
      type: 'local' as const,
      command: ['node'],
      environment: { API_KEY: { not: 'an envelope' } },
    };
    const result = MCPServerConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects header values that are neither strings nor envelopes', () => {
    const bad = {
      type: 'remote' as const,
      url: 'https://example.com/mcp',
      headers: { Authorization: 12345 },
    };
    const result = MCPServerConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('RuntimeSkillSchema', () => {
  it('accepts a well-formed runtime skill', () => {
    const skill = {
      name: 'my-skill',
      rawMarkdown: '---\nname: my-skill\n---\nBody',
    };
    expect(RuntimeSkillSchema.parse(skill)).toEqual(skill);
  });

  it('rejects uppercase or symbols in skill names', () => {
    const badCases = ['My-Skill', 'my skill', 'my.skill', '-leading-dash'];
    for (const name of badCases) {
      expect(RuntimeSkillSchema.safeParse({ name, rawMarkdown: 'body' }).success).toBe(false);
    }
  });

  it('rejects markdown exceeding the size limit', () => {
    const huge = 'x'.repeat(100_001);
    expect(RuntimeSkillSchema.safeParse({ name: 'big', rawMarkdown: huge }).success).toBe(false);
  });

  it('caps the runtime skills array at 50 entries', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      name: `skill-${i}`,
      rawMarkdown: 'body',
    }));
    expect(RuntimeSkillsSchema.safeParse(many).success).toBe(false);
  });
});

describe('MetadataSchema with runtimeSkills', () => {
  it('accepts runtimeSkills on persisted metadata', () => {
    const metadata = {
      version: 1,
      sessionId: 'session123',
      userId: 'user789',
      timestamp: Date.now(),
      runtimeSkills: [{ name: 'demo', rawMarkdown: 'body' }],
    };
    const result = MetadataSchema.parse(metadata);
    expect(result.runtimeSkills).toEqual([{ name: 'demo', rawMarkdown: 'body' }]);
  });
});

describe('RuntimeAgentSchema', () => {
  it('accepts a well-formed custom slug', () => {
    const agent = { slug: 'reviewer', name: 'Reviewer', config: {} };
    expect(RuntimeAgentSchema.parse(agent)).toEqual(agent);
  });

  it('rejects built-in slugs so they cannot override the bundled agents', () => {
    for (const slug of ['code', 'plan', 'architect', 'custom', 'orchestrator', 'ask']) {
      const result = RuntimeAgentSchema.safeParse({ slug, name: slug, config: {} });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a variant without a model — variants are model-specific', () => {
    const result = RuntimeAgentSchema.safeParse({
      slug: 'reviewer',
      name: 'Reviewer',
      config: { variant: 'high' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a variant when paired with a model', () => {
    const agent = {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { model: 'anthropic/claude-opus', variant: 'high' },
    };
    expect(RuntimeAgentSchema.parse(agent)).toEqual(agent);
  });
});
