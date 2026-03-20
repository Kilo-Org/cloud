import { services } from '../services/registry';
import * as ui from '../utils/ui';

export async function logs(args: string[], root: string) {
  if (args.length === 0) {
    ui.header('Available services');
    for (const svc of services) {
      const portInfo = svc.port ? ` (port ${svc.port})` : '';
      console.log(`  ${svc.name.padEnd(20)} ${ui.dim(svc.description)}${portInfo}`);
    }
    return;
  }

  const name = args[0];
  const svc = services.find(s => s.name === name);
  if (!svc) {
    ui.error(`Unknown service: "${name}"`);
    return;
  }

  if (svc.type === 'infra' && svc.devCommand?.startsWith('docker compose')) {
    const proc = Bun.spawn(
      ['docker', 'compose', '-f', 'dev/docker-compose.yml', 'logs', '-f', svc.name],
      { stdout: 'inherit', stderr: 'inherit', cwd: root }
    );
    await proc.exited;
  } else if (svc.type === 'infra') {
    ui.warn(
      `"${svc.name}" is not a Docker Compose service (runs: ${svc.devCommand ?? 'n/a'}).\n  It does not produce persistent logs that can be tailed.`
    );
  } else {
    ui.warn(
      `Log tailing for running dev servers is not yet supported.\n  Start the service with 'pnpm kilo dev up ${name}' to see its output.`
    );
  }
}
