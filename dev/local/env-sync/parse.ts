import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { services } from '../services';
import type { Annotation, ExampleEntry } from './types';

// ---------------------------------------------------------------------------
// JSONC parsing (handles // comments, /* */ comments, trailing commas)
// ---------------------------------------------------------------------------

function stripJsoncComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    if (inString) {
      if (text[i] === '\\' && i + 1 < text.length) {
        result += text[i] + text[i + 1];
        i += 2;
      } else if (text[i] === '"') {
        result += '"';
        inString = false;
        i++;
      } else {
        result += text[i];
        i++;
      }
    } else {
      if (text[i] === '"') {
        result += '"';
        inString = true;
        i++;
      } else if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
      } else {
        result += text[i];
        i++;
      }
    }
  }

  return result.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(content: string): unknown {
  return JSON.parse(stripJsoncComments(content));
}

// ---------------------------------------------------------------------------
// Env file parsing
// ---------------------------------------------------------------------------

function stripEnvQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\n])/g, (_match, ch: string) => (ch === 'n' ? '\n' : ch));
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(content: string): Map<string, string> {
  const vars = new Map<string, string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = stripEnvQuotes(line.slice(eqIdx + 1).trim());
    vars.set(key, value);
  }

  return vars;
}

function readEnvFile(filePath: string): Map<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Annotation parser
// ---------------------------------------------------------------------------

const KNOWN_DIRECTIVES = new Set(['url', 'from', 'pkcs8', 'exec']);

function parseAnnotation(directive: string, args: string): Annotation | undefined {
  switch (directive) {
    case 'url': {
      const refs = args.split(',').map(ref => {
        const trimmed = ref.trim();
        const slashIdx = trimmed.indexOf('/');
        if (slashIdx === -1) return { name: trimmed };
        return { name: trimmed.slice(0, slashIdx), path: trimmed.slice(slashIdx) };
      });
      return { type: 'url', services: refs };
    }
    case 'from':
      return { type: 'from', envLocalKey: args.trim() };
    case 'pkcs8':
      return { type: 'pkcs8' };
    case 'exec': {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || !parts[0]) return undefined;
      return { type: 'exec', command: parts[0], args: parts.slice(1) };
    }
    default:
      return undefined;
  }
}

function parseExampleFile(content: string): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  let pendingAnnotation: Annotation | undefined;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Blank lines clear pending annotations
    if (line === '') {
      pendingAnnotation = undefined;
      continue;
    }

    // Comment lines
    if (line.startsWith('#')) {
      // Commented-out keys like #KILOCODE_TOKEN_OVERRIDE=... are just comments
      const directiveMatch = line.match(/^#\s*@(\w+)\s*(.*)$/);
      if (directiveMatch) {
        const [, directive, args] = directiveMatch;
        if (KNOWN_DIRECTIVES.has(directive)) {
          pendingAnnotation = parseAnnotation(directive, args);
        }
        // Unknown @directives are treated as regular comments (no effect)
      }
      // Regular comments without @directive don't affect pending annotations
      continue;
    }

    // KEY=VALUE line
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      pendingAnnotation = undefined;
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    const defaultValue = stripEnvQuotes(line.slice(eqIdx + 1).trim());

    entries.push({
      key,
      defaultValue,
      annotation: pendingAnnotation ?? { type: 'passthrough' },
    });

    pendingAnnotation = undefined;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Service port resolution (single source of truth: services.ts)
// ---------------------------------------------------------------------------

function servicePort(name: string): number | undefined {
  return services.get(name)?.port;
}

// ---------------------------------------------------------------------------
// PKCS#1 → PKCS#8 conversion
// ---------------------------------------------------------------------------

function toPkcs8IfNeeded(pem: string): string {
  if (!pem || !pem.includes('-----BEGIN RSA PRIVATE KEY-----')) return pem;
  try {
    const privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
    return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  } catch {
    return pem;
  }
}

// ---------------------------------------------------------------------------
// Annotation-based value resolution
// ---------------------------------------------------------------------------

function resolveAnnotatedValue(
  key: string,
  entry: ExampleEntry,
  envLocal: Map<string, string>,
  lanIp: string | undefined,
  serviceUsesLanIp: boolean
): { value: string; resolved: boolean } {
  switch (entry.annotation.type) {
    case 'from': {
      const val = envLocal.get(entry.annotation.envLocalKey);
      if (val !== undefined) return { value: val, resolved: true };
      if (entry.defaultValue) return { value: entry.defaultValue, resolved: true };
      return { value: '', resolved: false };
    }

    case 'url': {
      const isOrigins = key.includes('ORIGINS');
      const isHostname = key.includes('HOSTNAME') && !key.includes('URL');
      const isWs = key.includes('_WS_');
      // LAN IP for container services, but never for ORIGINS keys
      const host = serviceUsesLanIp && !isOrigins && lanIp ? lanIp : 'localhost';
      const protocol = isWs ? 'ws' : 'http';

      const resolvedParts: string[] = [];
      for (const svcRef of entry.annotation.services) {
        const port = servicePort(svcRef.name);
        if (port === undefined) {
          console.warn(`⚠ Unknown service "${svcRef.name}" in @url annotation for ${key}`);
          continue;
        }
        if (isHostname) {
          resolvedParts.push(`${host}:${port}`);
        } else if (isOrigins) {
          resolvedParts.push(`http://localhost:${port}`);
        } else {
          const base = `${protocol}://${host}:${port}`;
          resolvedParts.push(svcRef.path ? base + svcRef.path : base);
        }
      }

      if (resolvedParts.length > 0) {
        return { value: resolvedParts.join(','), resolved: true };
      }
      // All services unknown — fall back to default
      if (entry.defaultValue) return { value: entry.defaultValue, resolved: true };
      return { value: '', resolved: false };
    }

    case 'pkcs8': {
      const val = envLocal.get(key);
      if (val !== undefined) return { value: toPkcs8IfNeeded(val), resolved: true };
      if (entry.defaultValue) return { value: entry.defaultValue, resolved: true };
      return { value: '', resolved: false };
    }

    case 'exec': {
      const result = spawnSync(entry.annotation.command, entry.annotation.args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      if (result.status === 0 && result.stdout.trim()) {
        return { value: result.stdout.trim(), resolved: true };
      }
      if (entry.defaultValue) return { value: entry.defaultValue, resolved: true };
      return { value: '', resolved: false };
    }

    case 'passthrough': {
      const val = envLocal.get(key);
      if (val !== undefined) return { value: val, resolved: true };
      if (entry.defaultValue) return { value: entry.defaultValue, resolved: true };
      return { value: '', resolved: false };
    }
  }
}

// ---------------------------------------------------------------------------
// File generation utilities
// ---------------------------------------------------------------------------

function needsQuoting(value: string): boolean {
  return (
    value.includes('\n') ||
    value.includes('"') ||
    value.includes("'") ||
    value.includes(' ') ||
    value.includes('#')
  );
}

function formatValue(value: string): string {
  if (!needsQuoting(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function generateDevVars(keys: Map<string, string>): string {
  const header = [
    '# Auto-generated by dev/local/env-sync.ts — do not edit manually',
    '# Source: .env.local + .dev.vars.example annotations',
    `# Generated: ${new Date().toISOString()}`,
    '',
  ].join('\n');

  const lines: string[] = [];
  for (const [key, value] of keys) {
    lines.push(`${key}=${formatValue(value)}`);
  }

  return header + lines.join('\n') + '\n';
}

export {
  parseJsonc,
  parseEnvFile,
  readEnvFile,
  parseExampleFile,
  servicePort,
  resolveAnnotatedValue,
  formatValue,
  generateDevVars,
};
