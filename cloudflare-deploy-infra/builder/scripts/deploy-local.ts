#!/usr/bin/env npx tsx
/**
 * CLI tool to deploy a local directory to the builder.
 *
 * Usage:
 *   pnpm deploy:local <directory> [slug] [--env KEY=VALUE]...
 *   pnpm deploy:local ./my-site my-test-worker --env API_KEY=abc123 --env DEBUG=true
 *
 * Options:
 *   directory - Path to the local directory to deploy
 *   slug      - Worker name (default: basename of directory)
 *   --env     - Environment variable to pass to the build (can be repeated)
 *
 * Environment:
 *   BUILDER_URL - Builder URL (default: http://localhost:8787)
 *   BACKEND_AUTH_TOKEN - Auth token from .env file (falls back to "test-token")
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(): Record<string, string> {
  const envPath = path.resolve(__dirname, '../.env');
  const result: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    return result;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

const envFile = loadEnvFile();

const BUILDER_URL = process.env['BUILDER_URL'] || 'http://localhost:8787';
const BUILDER_AUTH_TOKEN = process.env['BACKEND_AUTH_TOKEN'] || envFile['BACKEND_AUTH_TOKEN'];
const POLL_INTERVAL = 2000; // ms

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type EnvVar = {
  key: string;
  value: string;
  isSecret: boolean;
};

function parseArgs(args: string[]): {
  directory: string | null;
  slug: string | null;
  envVars: EnvVar[];
} {
  const envVars: EnvVar[] = [];
  let directory: string | null = null;
  let slug: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--env' || arg === '-e') {
      const nextArg = args[++i];
      if (!nextArg) {
        console.error('Error: --env requires a KEY=VALUE argument');
        process.exit(1);
      }

      const eqIndex = nextArg.indexOf('=');
      if (eqIndex === -1) {
        console.error(`Error: Invalid env var format: ${nextArg}. Expected KEY=VALUE`);
        process.exit(1);
      }

      const key = nextArg.slice(0, eqIndex);
      const value = nextArg.slice(eqIndex + 1);
      envVars.push({ key, value, isSecret: false });
    } else if (arg.startsWith('--env=') || arg.startsWith('-e=')) {
      const envValue = arg.startsWith('--env=') ? arg.slice(6) : arg.slice(3);
      const eqIndex = envValue.indexOf('=');
      if (eqIndex === -1) {
        console.error(`Error: Invalid env var format: ${envValue}. Expected KEY=VALUE`);
        process.exit(1);
      }
      const key = envValue.slice(0, eqIndex);
      const value = envValue.slice(eqIndex + 1);
      envVars.push({ key, value, isSecret: false });
    } else if (!arg.startsWith('-')) {
      if (!directory) {
        directory = arg;
      } else if (!slug) {
        slug = arg;
      }
    }
  }

  return { directory, slug, envVars };
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (!parsed.directory) {
    console.error('Usage: pnpm deploy:local <directory> [slug] [--env KEY=VALUE]...');
    console.error('');
    console.error('Examples:');
    console.error('  pnpm deploy:local ./my-site');
    console.error('  pnpm deploy:local ./my-site my-test-worker');
    console.error('  pnpm deploy:local ./my-site my-test-worker --env API_KEY=abc123');
    console.error('  pnpm deploy:local ./my-site --env FOO=bar --env BAZ=qux');
    console.error('');
    console.error('Environment variables:');
    console.error('  BUILDER_URL       - Builder URL (default: http://localhost:8787)');
    console.error('  BUILDER_AUTH_TOKEN - Auth token (default: "test-token")');
    process.exit(1);
  }

  const directory = path.resolve(parsed.directory);
  const slug = parsed.slug || path.basename(directory);
  const envVars = parsed.envVars;

  // Validate directory exists
  if (!fs.existsSync(directory)) {
    console.error(`Error: Directory not found: ${directory}`);
    process.exit(1);
  }

  // Validate directory is actually a directory
  if (!fs.statSync(directory).isDirectory()) {
    console.error(`Error: Not a directory: ${directory}`);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Local Directory Deployment');
  console.log('='.repeat(60));
  console.log(`Directory: ${directory}`);
  console.log(`Slug:      ${slug}`);
  console.log(`Builder:   ${BUILDER_URL}`);
  if (envVars.length > 0) {
    console.log(`Env vars:  ${envVars.map(e => e.key).join(', ')}`);
  }
  console.log('='.repeat(60));
  console.log('');

  // Create tar.gz archive in temp location
  const archivePath = `/tmp/${slug}-${Date.now()}.tar.gz`;

  console.log('📦 Creating archive...');

  // Build exclusion list for tar command
  const excludePatterns = [
    '.next',
    'node_modules', // Dependencies
    '._*', // macOS metadata/resource fork files at root
    '**/._*', // macOS metadata/resource fork files at any depth
    '.DS_Store', // macOS folder metadata
    '.Spotlight-V100', // macOS Spotlight
    '.Trashes', // macOS trash
    '.TemporaryItems', // macOS temporary items
    '.fseventsd', // macOS file system events
    'Thumbs.db', // Windows thumbnail cache
    'desktop.ini', // Windows folder settings
    '$RECYCLE.BIN', // Windows recycle bin
    '.git', // Git repository
    '.svn', // SVN repository
    '.hg', // Mercurial repository
  ];

  const excludeFlags = excludePatterns.map(pattern => `--exclude='${pattern}'`).join(' ');

  try {
    // On macOS, set COPYFILE_DISABLE=1 to prevent tar from copying resource fork files
    const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
    execSync(`tar -czf "${archivePath}" -C "${directory}" ${excludeFlags} .`, {
      stdio: 'pipe',
      env: tarEnv,
    });
  } catch (error) {
    console.error('Failed to create archive:', error);
    process.exit(1);
  }

  const archiveSize = fs.statSync(archivePath).size;
  console.log(`   Archive created: ${(archiveSize / 1024).toFixed(1)} KB`);
  console.log('');

  try {
    // Upload to builder
    console.log('🚀 Uploading to builder...');
    const archiveData = fs.readFileSync(archivePath);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${BUILDER_AUTH_TOKEN}`,
      'Content-Type': 'application/gzip',
      'X-Slug': slug,
    };

    if (envVars.length > 0) {
      headers['X-Env-Vars'] = JSON.stringify(envVars);
    }

    const response = await fetch(`${BUILDER_URL}/deploy-archive`, {
      method: 'POST',
      headers,
      body: archiveData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upload failed: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as { error?: string; buildId: string };

    if (result.error) {
      throw new Error(result.error);
    }

    console.log(`   Build ID: ${result.buildId}`);
    console.log('');

    // Poll for status
    console.log('⏳ Building...');
    let lastStatus = '';
    let lastEventCount = 0;

    while (true) {
      // Fetch and display new events
      const eventsResponse = await fetch(`${BUILDER_URL}/deploy/${result.buildId}/events`, {
        headers: { Authorization: `Bearer ${BUILDER_AUTH_TOKEN}` },
      });

      const events = (await eventsResponse.json()) as {
        type: string;
        payload: { status?: string };
      }[];

      // Show new log events
      for (let i = lastEventCount; i < events.length; i++) {
        const event = events[i];
        console.log(`   ${JSON.stringify(event.payload)}`);

        if (event.type == 'status_change') {
          lastStatus = event.payload.status ?? '';
        }
      }
      lastEventCount = events.length;

      // Check if finished
      if (['deployed', 'failed', 'cancelled'].includes(lastStatus)) {
        break;
      }

      await sleep(POLL_INTERVAL);
    }

    console.log('');

    if (lastStatus === 'deployed') {
      console.log('='.repeat(60));
      console.log('✅ Deployment successful!');
      console.log('='.repeat(60));
      console.log('');
      console.log(`URL: https://${slug}.d.kiloapps.io`);
      console.log('');
    } else {
      console.log('='.repeat(60));
      console.log(`❌ Deployment ${lastStatus}`);
      console.log('='.repeat(60));
      process.exit(1);
    }
  } finally {
    // Cleanup archive
    try {
      fs.unlinkSync(archivePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch(err => {
  console.error('');
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
