import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
let shutdownTimer;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;

  if (!children.some(child => child.pid)) return;

  for (const child of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error.message);
    }
  }

  shutdownTimer = setTimeout(() => {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error.message);
      }
    }
  }, 5000);
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

const apps = [
  ...(process.env.KILO_AI_GATEWAY_MANAGED === '1'
    ? []
    : [
        {
          name: 'ai-gateway',
          command: 'bash',
          args: ['scripts/dev.sh'],
          cwd: `${repoRoot}apps/ai-gateway`,
        },
      ]),
  {
    name: 'web',
    command: 'next',
    args: [
      'dev',
      '-H',
      process.env.NEXT_DEV_HOSTNAME || '0.0.0.0',
      '-p',
      process.env.PORT || '3000',
      ...process.argv.slice(2),
    ],
    cwd: `${repoRoot}apps/web`,
  },
];

for (const app of apps) {
  const child = spawn(app.command, app.args, {
    cwd: app.cwd,
    stdio: 'inherit',
    detached: true,
  });
  children.push(child);
  child.on('error', error => {
    console.error(`${app.name} failed to start: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${app.name} exited (${signal || code}); stopping web development servers`);
      stop(code === 0 && app.name === 'ai-gateway' ? 1 : (code ?? 1));
    }
    const groupsExited = children.every(server => {
      if (!server.pid) return true;
      try {
        process.kill(-server.pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    });
    if (groupsExited) {
      clearTimeout(shutdownTimer);
    }
  });
}
