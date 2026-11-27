import { X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, matchesGlob, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';

const SERVICE = join(import.meta.dirname, '../..');
const ROOT = join(SERVICE, '../..');
const read = (path: string) => readFileSync(join(SERVICE, path), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('one object, one container (contract §1)', () => {
  it('addresses exactly one Durable Object name, runs, and never a unique id', () => {
    const calls: string[] = [];
    for (const file of sourceFiles(join(SERVICE, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(SERVICE, file)).not.toMatch(/newUniqueId|idFromName|idFromString/);
      for (const match of text.matchAll(/getByName\(([^)]*)\)/g)) {
        calls.push(`${relative(SERVICE, file)}:${match[1]}`);
      }
    }
    expect(calls).toEqual(["src/index.ts:'runs'"]);
  });
});

describe('the standalone container package (contract §1, security round 4 (b))', () => {
  const dockerfile = read('container/Dockerfile');
  const manifest = JSON.parse(read('container/package.json')) as {
    packageManager: string;
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('builds from container/ alone in both deployments', () => {
    const raw = experimental_readRawConfig({ config: join(SERVICE, 'wrangler.jsonc') })
      .rawConfig as {
      containers?: unknown[];
      env?: Record<string, { containers?: unknown[] }>;
    };
    const expected = [
      {
        class_name: 'MigrationRunDO',
        scheduling_policy: 'durable_object',
        images: { proxy: { dockerfile: './container/Dockerfile', build_context: './container' } },
      },
    ];
    expect(raw.containers).toEqual(expected);
    expect(raw.env?.staging?.containers).toEqual(expected);
  });

  it('pins the base image by digest to the .nvmrc Node version', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    const from = dockerfile.split('\n').filter(line => line.startsWith('FROM '));
    expect(from).toEqual([
      expect.stringMatching(
        new RegExp(`^FROM node:${nvmrc.replace(/\./g, '\\.')}-slim@sha256:[0-9a-f]{64}$`)
      ),
    ]);
  });

  it('installs with the frozen standalone lockfile and nothing else', () => {
    const instructions = dockerfile.split('\n').filter(line => !line.startsWith('#'));
    const installs = instructions.filter(line => /\b(pnpm|npm|yarn) (install|i|add)\b/.test(line));
    expect(installs).toHaveLength(1);
    expect(installs[0]?.replace(/.*pnpm install/, 'pnpm install').replace(/\s*\\$/, '')).toBe(
      'pnpm install --frozen-lockfile --ignore-workspace --ignore-pnpmfile'
    );
    expect(instructions.join('\n')).not.toMatch(
      /(^|[^p])npm install|:latest|COPY \.\.|pnpmfile\.cjs/
    );
  });

  it('pins pnpm by version and sha512, and every dependency exactly', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const lock = read('container/pnpm-lock.yaml');
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(lock).toContain(`      ${name}:\n        specifier: ${version}\n`);
    }
  });

  it('is in no root workspace glob', () => {
    const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const globs: string[] = [];
    let inPackages = false;
    for (const line of workspace.split('\n')) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (inPackages && /^\s+-\s+/.test(line))
        globs.push(line.replace(/^\s+-\s+/, '').replace(/['"]/g, ''));
      else if (inPackages && /^\S/.test(line)) inPackages = false;
    }
    expect(globs.length).toBeGreaterThan(0);
    const positive = globs.filter(glob => !glob.startsWith('!'));
    const excluded = globs.filter(glob => glob.startsWith('!')).map(glob => glob.slice(1));
    const included =
      positive.some(glob => matchesGlob('services/migration-proxy/container', glob)) &&
      !excluded.some(glob => matchesGlob('services/migration-proxy/container', glob));
    expect(included).toBe(false);
    expect(positive.some(glob => matchesGlob('services/migration-proxy', glob))).toBe(true);
  });
});

describe('the CA bundle (contract §2)', () => {
  it('holds exactly the Supabase Root 2021 CA', () => {
    const pem = read('container/ca-bundle.pem');
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    expect(blocks).toHaveLength(1);
    const [block = ''] = blocks;
    expect(pem.replace(block, '').trim()).toBe('');
    const certificate = new X509Certificate(block);
    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toContain('CN=Supabase Root 2021 CA');
    expect(certificate.fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA'
    );
  });
});
