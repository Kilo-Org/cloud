import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

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

function isAllowedEmail(email: string): boolean {
  const normalized = email.toLowerCase();
  if (ALLOWED_EMAILS.has(normalized)) return true;
  return PLACEHOLDER_DOMAINS.some(
    domain => normalized.endsWith(`@${domain}`) || normalized.endsWith(`.${domain}`)
  );
}

describe('email literal guardrail', () => {
  it('keeps production source email literals limited to placeholders and approved aliases', () => {
    const srcRoot = join(process.cwd(), 'src');
    const findings = listProductionSourceFiles(srcRoot).flatMap(file => {
      const content = readFileSync(file, 'utf8');
      return Array.from(content.matchAll(EMAIL_REGEX))
        .map(match => match[0])
        .filter(email => !isAllowedEmail(email))
        .map(email => `${relative(process.cwd(), file)}: ${email}`);
    });

    expect(findings).toEqual([]);
  });
});
