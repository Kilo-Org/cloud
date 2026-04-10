import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const envFilePath = path.join(repoRoot, 'apps/web/.env.development.local');

function updateEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const pattern = new RegExp(`^${key}=.*`, 'm');

  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${value}`);
  } else {
    content = content.endsWith('\n') || content === '' ? content : content + '\n';
    content += `${key}=${value}\n`;
  }

  fs.writeFileSync(filePath, content);
}

if (spawnSync('stripe', ['--version'], { stdio: 'ignore' }).error) {
  console.error(
    'stripe CLI not found on PATH. Install it:\n  https://docs.stripe.com/stripe-cli#install\n  brew install stripe/stripe-cli/stripe'
  );
  process.exit(1);
}

console.log('Starting Stripe webhook listener...');

let secretPattern: RegExp | null = /whsec_[a-zA-Z0-9]+/;

const child = spawn('pnpm', ['--filter', 'web', 'run', 'stripe'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: repoRoot,
});

function handleOutput(data: Buffer) {
  process.stdout.write(data);

  if (!secretPattern) return;
  const match = data.toString().match(secretPattern);
  if (!match) return;

  const secret = match[0];
  updateEnvValue(envFilePath, 'STRIPE_WEBHOOK_SECRET', `"${secret}"`);

  console.log('\nSet STRIPE_WEBHOOK_SECRET in apps/web/.env.development.local');

  // Only capture once
  secretPattern = null;
}

child.stdout.on('data', handleOutput);
child.stderr.on('data', handleOutput);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on('close', code => {
  process.exit(code ?? 1);
});
