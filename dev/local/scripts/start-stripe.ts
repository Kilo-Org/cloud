import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
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

function parseTargetPort(value: string | undefined): number {
  if (value === undefined) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Next.js target port: ${value}`);
  }

  return port;
}

function findAvailablePort(port: number, retries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', error => {
      if ('code' in error && error.code === 'EADDRINUSE') {
        const nextPort = retries > 0 ? port + 1 : 0;
        const nextRetries = retries > 0 ? retries - 1 : 0;
        findAvailablePort(nextPort, nextRetries).then(resolve, reject);
        return;
      }

      reject(error);
    });

    server.once('listening', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error(`Could not resolve available port from ${port}`)));
        return;
      }

      const assignedPort = address.port;
      server.close(() => resolve(assignedPort));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  if (spawnSync('stripe', ['--version'], { stdio: 'ignore' }).error) {
    console.error(
      'stripe CLI not found on PATH. Install it:\n  https://docs.stripe.com/stripe-cli#install\n  brew install stripe/stripe-cli/stripe'
    );
    process.exit(1);
  }

  const targetPort = parseTargetPort(process.argv[2]);
  const forwardPort = await findAvailablePort(targetPort, 10);

  console.log(`Starting Stripe webhook listener for http://localhost:${forwardPort}...`);

  const secretPattern = /whsec_[a-zA-Z0-9]+/;
  const secretRedactionPattern = /whsec_[a-zA-Z0-9]+/g;
  let secretCaptured = false;
  let outputBuffer = '';

  const child = spawn('pnpm', ['--filter', 'web', 'run', 'stripe'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: repoRoot,
    env: { ...process.env, STRIPE_FORWARD_PORT: String(forwardPort) },
  });

  function processOutput(text: string): void {
    const match = secretCaptured ? null : text.match(secretPattern);
    if (match) {
      const secret = match[0];
      updateEnvValue(envFilePath, 'STRIPE_WEBHOOK_SECRET', `"${secret}"`);
      secretCaptured = true;
    }

    process.stdout.write(text.replace(secretRedactionPattern, '[redacted]'));

    if (match) {
      console.log('\nSet STRIPE_WEBHOOK_SECRET in apps/web/.env.development.local');
    }
  }

  function flushOutputBuffer(): void {
    if (outputBuffer === '') return;
    processOutput(outputBuffer);
    outputBuffer = '';
  }

  function handleOutput(data: Buffer): void {
    outputBuffer += data.toString();

    let newlineIndex = outputBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = outputBuffer.slice(0, newlineIndex + 1);
      outputBuffer = outputBuffer.slice(newlineIndex + 1);
      processOutput(line);
      newlineIndex = outputBuffer.indexOf('\n');
    }
  }

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('close', code => {
    flushOutputBuffer();
    process.exit(code ?? 1);
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
