import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// ANSI color constants
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT_MARKER = 'kilocode-monorepo';

const REQUIRED_KEYS: readonly string[] = [
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
  'POSTGRES_URL',
  'CALLBACK_TOKEN_SECRET',
  'BYOK_ENCRYPTION_KEY',
  'USER_DELETION_AUDIT_HMAC_KEY',
  'USER_DELETION_ENCRYPTION_KEY',
  'INTERNAL_API_SECRET',
  'STRIPE_SECRET_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

const SECRET_KEYS = new Set<string>([
  'NEXTAUTH_SECRET',
  'INTERNAL_API_SECRET',
  'CALLBACK_TOKEN_SECRET',
  'BYOK_ENCRYPTION_KEY',
  'USER_DELETION_AUDIT_HMAC_KEY',
  'USER_DELETION_ENCRYPTION_KEY',
]);

const CI_PLACEHOLDER_VALUES: Record<string, string> = {
  NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'http://localhost:3000',
  POSTGRES_URL:
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
  STRIPE_SECRET_KEY: 'sk_test_setup_smoke_placeholder',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_setup_smoke_placeholder',
};

// ---------------------------------------------------------------------------
// Repo root detection (reuses `findRepoRoot` convention from dev/local/cli.ts)
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === REPO_ROOT_MARKER) return dir;
      } catch {
        // Not valid JSON, keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find repo root (package.json with name '${REPO_ROOT_MARKER}')`);
}

// ---------------------------------------------------------------------------
// .env.local.example parsing
// ---------------------------------------------------------------------------

function parseExampleFile(content: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values.set(key, value);
  }

  return values;
}

// ---------------------------------------------------------------------------
// Env value formatting (mirrors dev/local/env-sync/parse.ts)
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
  if (!value) return value;
  if (!needsQuoting(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

function generateSecret(): string {
  const result = spawnSync('openssl', ['rand', '-base64', '32'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`openssl rand failed: ${result.stderr?.trim() ?? 'unknown error'}`);
  }
  return result.stdout.trim();
}

const KEY_DESCRIPTIONS: Record<string, string> = {
  NEXTAUTH_SECRET: 'Used to encrypt NextAuth session tokens',
  NEXTAUTH_URL: 'The URL the app is served from',
  POSTGRES_URL:
    'Should match your local dev/docker-compose.yaml setup unless you are using a remote database',
  CALLBACK_TOKEN_SECRET: 'Secret used to sign webhook/callback tokens',
  BYOK_ENCRYPTION_KEY: 'Used for Bring-Your-Own-Key encryption of sensitive app data',
  USER_DELETION_AUDIT_HMAC_KEY: 'HMAC key for user-deletion email hashes',
  USER_DELETION_ENCRYPTION_KEY: 'AES key for user-deletion effect checkpoints and credentials',
  INTERNAL_API_SECRET: 'Internal API authentication secret',
  STRIPE_SECRET_KEY:
    'Stripe secret key — get test keys at https://dashboard.stripe.com/test/apikeys',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
    'Stripe publishable key — get test keys at https://dashboard.stripe.com/test/apikeys',
};

// ---------------------------------------------------------------------------
// Key-specific descriptions
// ---------------------------------------------------------------------------

function buildDescription(key: string): string | undefined {
  return KEY_DESCRIPTIONS[key];
}

function isCiMode(): boolean {
  return process.argv.includes('--ci');
}

function collectCiValue(key: string, defaultValue: string, isSecret: boolean): string {
  if (isSecret) return generateSecret();
  return CI_PLACEHOLDER_VALUES[key] ?? defaultValue;
}

// ---------------------------------------------------------------------------
// User interaction
// ---------------------------------------------------------------------------

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function promptForValue(
  key: string,
  defaultValue: string,
  description: string | undefined,
  isSecret: boolean
): Promise<string> {
  const bracketDefault = isSecret ? '' : defaultValue ? ` [${defaultValue}]` : '';
  const secretHint = isSecret ? ' (leave blank to generate)' : '';

  const prompt = `${CYAN}${key}${RESET}${bracketDefault}${YELLOW}${secretHint}${RESET} > `;

  if (description) {
    console.log(`\n${WHITE}${description}${RESET}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Prompts for a URL and validates it. On invalid input, offers a non-fatal
// recovery menu: re-enter, use a suggested fix (when available), or use the
// default / clear. Returns the validated URL string, or '' to mean
// "use the default / clear" — callers map '' to the appropriate fallback.
async function promptForUrl(args: {
  key: string;
  defaultValue: string;
  description?: string;
}): Promise<string> {
  while (true) {
    const raw = await promptForValue(args.key, args.defaultValue, args.description, false);
    if (raw === '') return '';
    const result = validateUrl(raw);
    if (result.ok) return result.value;
    let displaySuggestion: string | undefined;
    if (result.suggestion) {
      // Validate the suggestion before offering it, and normalize it the same
      // way successful inputs are normalized so the persisted value is
      // origin-only and matches what the validator would return.
      const suggestionCheck = validateUrl(result.suggestion);
      if (suggestionCheck.ok) {
        displaySuggestion = suggestionCheck.value;
      }
    }
    console.log(`  ${RED}✗ ${args.key}: ${result.error}${RESET}`);
    if (displaySuggestion) {
      console.log(`  ${YELLOW}Suggested: ${displaySuggestion}${RESET}`);
    }
    console.log('  Options:');
    console.log('    [r] Re-enter');
    if (displaySuggestion) console.log('    [s] Use suggested');
    console.log('    [d] Use default / clear');
    const choice = await promptForUrlRecoveryChoice(Boolean(displaySuggestion));
    if (choice === 'r') continue;
    if (choice === 's' && displaySuggestion) return displaySuggestion;
    return '';
  }
}

async function promptForUrlRecoveryChoice(hasSuggestion: boolean): Promise<'r' | 's' | 'd'> {
  const hint = hasSuggestion ? '[r/s/d]' : '[r/d]';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  Choice ${hint} (default d) > `, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'r' || a === 're-enter') return resolve('r');
      if (hasSuggestion && (a === 's' || a === 'suggested')) return resolve('s');
      resolve('d');
    });
  });
}

type UrlValidation =
  | { ok: true; value: string }
  | { ok: false; error: string; suggestion?: string };

// Validates a URL string for use as NEXTAUTH_URL / APP_URL_OVERRIDE:
//   - no whitespace, quotes, or '#' (which would corrupt .env files)
//   - parseable by the URL parser
//   - http or https protocol
//   - non-empty hostname
//   - origin only: no credentials, path, query, or fragment
// On failure, returns an error and (when possible) a suggested fix such as
// prepending http:// for a protocol-less input.
function validateUrl(raw: string): UrlValidation {
  if (/[\s"'#\n\r]/.test(raw)) {
    return {
      ok: false,
      error: 'must not contain whitespace, quotes, newlines, or "#" (reserved in .env files)',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const suggestion = raw.includes('://') ? undefined : `http://${raw.replace(/^\/+/, '')}`;
    return {
      ok: false,
      error: 'not a valid URL — include the protocol (e.g. http:// or https://)',
      suggestion,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `protocol must be http or https (got "${parsed.protocol}")` };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'URL is missing a hostname' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain credentials (user:pass@)' };
  }
  if (parsed.pathname !== '/') {
    return { ok: false, error: 'URL must not contain a path (origin only, e.g. http://host:port)' };
  }
  if (parsed.search) {
    return { ok: false, error: 'URL must not contain a query string' };
  }
  return { ok: true, value: parsed.origin };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ciMode = isCiMode();
  const repoRoot = findRepoRoot();
  const examplePath = path.join(repoRoot, '.env.local.example');
  const envLocalPath = path.join(repoRoot, '.env.local');

  if (!fs.existsSync(examplePath)) {
    console.error(`${RED}Missing ${examplePath}${RESET}`);
    process.exit(1);
  }

  const exampleContent = fs.readFileSync(examplePath, 'utf-8');
  const exampleValues = parseExampleFile(exampleContent);

  // -----------------------------------------------------------------------
  // Step 1: Check for existing .env.local
  // -----------------------------------------------------------------------

  let envLocalExists = false;
  if (fs.existsSync(envLocalPath)) {
    const existingContent = fs.readFileSync(envLocalPath, 'utf-8').trim();
    if (existingContent.length > 0) {
      envLocalExists = true;
    }
  }

  if (envLocalExists && ciMode) {
    console.error(
      `${RED}.env.local already exists; refusing to overwrite it in --ci mode.${RESET}`
    );
    process.exit(1);
  }

  if (envLocalExists) {
    console.log();
    console.log(
      `${RED}${BOLD}WARNING${RESET}${RED}: .env.local already exists and is non-empty.${RESET}`
    );
    console.log(
      `${YELLOW}Running this setup may overwrite existing values, including secrets.${RESET}`
    );
    console.log(`${YELLOW}Recommend backing up .env.local before continuing.${RESET}`);
    console.log();
    const shouldContinue = await confirm(`  Do you want to continue anyway? [y/N] `);
    if (!shouldContinue) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // -----------------------------------------------------------------------
  // Step 2 & 3: Collect values, then write once
  // -----------------------------------------------------------------------

  const collected = new Map<string, string>();

  // Optional base URL. When provided, it becomes the default for the
  // NEXTAUTH_URL prompt (which the user can still override) and is also
  // written as APP_URL_OVERRIDE so auth and server-side redirects resolve
  // at the same public origin (LAN IP, Cloudflare Access, etc.). Left
  // empty in CI and when the user presses enter (or chooses to clear
  // during the recovery menu for an invalid value).
  const baseUrl = ciMode
    ? ''
    : await promptForUrl({
        key: 'BASE_URL',
        defaultValue: '',
        description:
          'Base URL — the URL you use to access the dev server. Sets NEXTAUTH_URL (as its default) and APP_URL_OVERRIDE so auth and server-side redirects resolve at the same origin. Press enter to leave unset.',
      });

  for (const key of REQUIRED_KEYS) {
    if (key === 'NEXTAUTH_URL') {
      const exampleDefault = exampleValues.get(key) ?? '';
      const defaultValue = baseUrl || exampleDefault;
      const answer = ciMode
        ? collectCiValue(key, defaultValue, false)
        : await promptForUrl({
            key,
            defaultValue,
            description: buildDescription(key),
          });
      collected.set(key, answer === '' ? defaultValue : answer);
      continue;
    }
    const exampleDefault = exampleValues.get(key) ?? '';
    const defaultValue = exampleDefault;
    const description = buildDescription(key);
    const isSecret = SECRET_KEYS.has(key);

    const answer = ciMode
      ? collectCiValue(key, defaultValue, isSecret)
      : await promptForValue(key, defaultValue, description, isSecret);

    if (answer === '') {
      if (isSecret) {
        console.log(`  ${DIM}Generating random secret...${RESET}`);
        const generated = generateSecret();
        console.log(`  ${GREEN}✓ Generated${RESET}`);
        collected.set(key, generated);
      } else {
        collected.set(key, defaultValue);
      }
    } else {
      collected.set(key, answer);
    }
  }

  if (baseUrl) {
    // Derive APP_URL_OVERRIDE from the final NEXTAUTH_URL rather than from
    // the raw BASE_URL input, so the two stay in sync even if the user
    // overrode NEXTAUTH_URL at its prompt.
    collected.set('APP_URL_OVERRIDE', collected.get('NEXTAUTH_URL') ?? baseUrl);
  }

  // -----------------------------------------------------------------------
  // Step 6: Build final content and write atomically once
  // -----------------------------------------------------------------------

  let finalContent = exampleContent;
  for (const [key, value] of collected) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^(${escapedKey}=).*$`, 'm');
    if (regex.test(finalContent)) {
      // Use the function form so `$`, `$&`, etc. in `value` are treated literally
      // instead of being interpreted as replacement tokens.
      finalContent = finalContent.replace(
        regex,
        (_match, prefix) => `${prefix}${formatValue(value)}`
      );
    } else {
      finalContent = finalContent.trimEnd() + `\n${key}=${formatValue(value)}\n`;
    }
  }

  const tmpPath = path.join(repoRoot, '.env.local.tmp');
  try {
    fs.writeFileSync(tmpPath, finalContent, 'utf-8');
    fs.renameSync(tmpPath, envLocalPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }

  // -----------------------------------------------------------------------
  // Post-setup guidance
  // -----------------------------------------------------------------------

  console.log();
  console.log(`${GREEN}${BOLD}✓ Wrote .env.local${RESET}`);
  console.log();
  console.log(`${DIM}Next steps:${RESET}`);
  console.log(
    `  1. Run ${CYAN}pnpm dev:env${RESET} to sync worker \`.dev.vars\` and \`.env.development.local\``
  );
  console.log(`  2. Run ${CYAN}pnpm dev:start${RESET} to launch all services`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'setup-env.ts');

if (isMain) {
  main().catch((err: unknown) => {
    console.error(`${RED}Error:${RESET}`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
