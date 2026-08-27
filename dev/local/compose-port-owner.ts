import { execFileSync } from 'node:child_process';

/**
 * Which docker compose project holds a published host port.
 *
 * Offsets collide across worktrees: a *different* compose project
 * (`kilo-dev-<other-slug>-2500`) can keep this offset's postgres port after
 * `dev:stop`, and `docker compose up` then fails with a bare "port is already
 * allocated" that names neither the port's owner nor the fix.
 */

type PortOwner = {
  port: number;
  project: string;
  container: string;
};

/** `docker ps --format '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}'` */
function parsePortOwners(output: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const line of output.split('\n')) {
    const [project, container, ports] = line.split('\t');
    if (!container || !ports) continue;
    // "0.0.0.0:7932->5432/tcp, [::]:7932->5432/tcp" — published host ports only.
    for (const match of ports.matchAll(/(?:^|[\s,])(?:[\d.]+|\[[^\]]+\]):(\d+)->/g)) {
      const port = Number(match[1]);
      if (owners.some(owner => owner.port === port && owner.container === container)) continue;
      owners.push({
        port,
        project: project === '' ? '(no project)' : project,
        container,
      });
    }
  }
  return owners;
}

/**
 * `undefined` when docker did not answer — a stopped or wedged daemon. That is
 * not the same as "no container holds this port", and a caller that decides
 * ownership must not read an empty list as proof that nobody owns anything.
 */
function listPortOwners(): PortOwner[] | undefined {
  try {
    return parsePortOwners(
      execFileSync(
        'docker',
        ['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}'],
        // A wedged (not stopped) daemon must not hang `dev:status`, which
        // agents poll in loops.
        { encoding: 'utf-8', timeout: 2000 }
      )
    );
  } catch {
    return undefined; // no docker, or the daemon is down
  }
}

/** Ports among `ports` published by a container of some other compose project. */
function foreignPortOwners(
  ports: number[],
  ownProject: string,
  owners: PortOwner[] = listPortOwners() ?? []
): PortOwner[] {
  const wanted = new Set(ports);
  return owners.filter(owner => wanted.has(owner.port) && owner.project !== ownProject);
}

function describeForeignPortOwners(owners: PortOwner[]): string[] {
  return owners.map(
    owner =>
      `port ${owner.port} is held by container ${owner.container} of compose project ${owner.project}` +
      ` — free it with: docker compose -p ${owner.project} down`
  );
}

export { describeForeignPortOwners, foreignPortOwners, listPortOwners, parsePortOwners };
export type { PortOwner };
