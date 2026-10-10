import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

const REPOSITORY_ROOT = join(process.cwd(), '../..');
// packages/web-shared holds server code moved out of apps/web; scan both.
const SOURCE_ROOTS = [join(process.cwd(), 'src'), join(REPOSITORY_ROOT, 'packages/web-shared/src')];

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mdx']);
const ALLOWED_EMAILS = new Set([
  'sales@kilocode.ai',
  'teams@kilocode.ai',
  'hi@kilocode.ai',
  'hi@app.kilocode.ai',
  'hi@kilo.ai',
  'admin@kilocode.ai',
  'git@github.com',
  'git@gitlab.com',
]);
const PLACEHOLDER_DOMAINS = [
  'example.com',
  'example.co.uk',
  'example.test',
  'test.local',
  'admin.example.com',
];
const EXCLUDED_PATH_PARTS = new Set(['tests', 'scripts']);
const MAILGUN_ACCESS_PATTERNS = [
  /from ['"]mailgun\.js['"]/,
  /api\.mailgun\.net/,
  /messages\.create\s*\(/,
];

function listProductionSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (!EXCLUDED_PATH_PARTS.has(entry)) {
        files.push(...listProductionSourceFiles(path));
      }
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
    if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue;
    files.push(path);
  }

  return files;
}

function listNonTestSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...listNonTestSourceFiles(path));
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
    if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue;
    files.push(path);
  }

  return files;
}

function isAllowedEmail(email: string): boolean {
  const normalized = email.toLowerCase();
  if (ALLOWED_EMAILS.has(normalized)) return true;
  return PLACEHOLDER_DOMAINS.some(
    domain => normalized.endsWith(`@${domain}`) || normalized.endsWith(`.${domain}`)
  );
}

describe('email literal guardrail', () => {
  it('keeps production source email literals limited to placeholders and approved aliases', () => {
    const findings = SOURCE_ROOTS.flatMap(listProductionSourceFiles).flatMap(file => {
      const content = readFileSync(file, 'utf8');
      return Array.from(content.matchAll(EMAIL_REGEX))
        .map(match => match[0])
        .filter(email => !isAllowedEmail(email))
        .map(email => `${relative(REPOSITORY_ROOT, file)}: ${email}`);
    });

    expect(findings).toEqual([]);
  });

  it('keeps Mailgun provider access behind the environment-aware transport', () => {
    const providerFiles = SOURCE_ROOTS.flatMap(listNonTestSourceFiles)
      .filter(file => {
        const content = readFileSync(file, 'utf8');
        return MAILGUN_ACCESS_PATTERNS.some(pattern => pattern.test(content));
      })
      .map(file => relative(REPOSITORY_ROOT, file));

    expect(providerFiles).toEqual(['packages/web-shared/src/lib/email-mailgun.ts']);
  });
});
