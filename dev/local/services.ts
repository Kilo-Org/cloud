import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type ServiceType = 'infra' | 'nextjs' | 'worker' | 'process';

type ServiceGroup = {
  id: string;
  label: string;
  alwaysOn: boolean;
  groupDependsOn?: string[];
  /** When true, an empty spacer row is rendered above this group in the sidebar. */
  sectionBreakBefore?: boolean;
};

const groups: ServiceGroup[] = [
  { id: 'core', label: 'Core', alwaysOn: true },
  { id: 'kiloclaw', label: 'KiloClaw', alwaysOn: false, sectionBreakBefore: true },
  { id: 'cloud-agent', label: 'Cloud Agent', alwaysOn: false },
  { id: 'code-review', label: 'Code Review', alwaysOn: false, groupDependsOn: ['cloud-agent'] },
  { id: 'app-builder', label: 'App Builder', alwaysOn: false, groupDependsOn: ['cloud-agent'] },
  { id: 'gastown', label: 'Gastown', alwaysOn: false },
  {
    id: 'auto-triage',
    label: 'Auto Triage',
    alwaysOn: false,
    groupDependsOn: ['cloud-agent'],
    sectionBreakBefore: true,
  },
  { id: 'auto-fix', label: 'Auto Fix', alwaysOn: false, groupDependsOn: ['cloud-agent'] },
  { id: 'deploy', label: 'Deploy', alwaysOn: false },
  { id: 'observability', label: 'Observability', alwaysOn: false },
  { id: 'storybook', label: 'Storybook', alwaysOn: false, sectionBreakBefore: true },
];

type ServiceDef = {
  name: string;
  type: ServiceType;
  dir: string;
  port: number;
  dependsOn: string[];
  command: string[];
  group: string;
  useLanIp?: boolean;
};

type ServiceMeta = {
  group: string;
  dependsOn: string[];
  dir?: string;
  useLanIp?: boolean;
};

const serviceMeta: Record<string, ServiceMeta> = {
  // core
  nextjs: { group: 'core', dependsOn: ['postgres', 'redis'] },
  postgres: { group: 'core', dependsOn: [] },
  redis: { group: 'core', dependsOn: [] },
  // cloud-agent
  'cloud-agent-next': {
    group: 'cloud-agent',
    dependsOn: ['postgres', 'nextjs', 'cloudflare-session-ingest'],
    dir: 'services/cloud-agent-next',
    useLanIp: true,
  },
  'cloudflare-webhook-agent-ingest': {
    group: 'cloud-agent',
    dependsOn: ['cloud-agent-next', 'nextjs', 'postgres'],
    dir: 'services/webhook-agent-ingest',
  },
  'cloudflare-session-ingest': {
    group: 'cloud-agent',
    dependsOn: ['postgres'],
    dir: 'services/session-ingest',
  },
  // app-builder
  'app-builder-tunnel': { group: 'app-builder', dependsOn: [] },
  'cloudflare-app-builder': {
    group: 'app-builder',
    dependsOn: ['cloudflare-db-proxy', 'cloudflare-git-token-service', 'app-builder-tunnel'],
    dir: 'services/app-builder',
    useLanIp: true,
  },
  'cloudflare-db-proxy': {
    group: 'app-builder',
    dependsOn: ['postgres'],
    dir: 'services/db-proxy',
  },
  'cloudflare-git-token-service': {
    group: 'app-builder',
    dependsOn: ['postgres'],
    dir: 'services/git-token-service',
  },
  // code-review
  'cloudflare-code-review-infra': {
    group: 'code-review',
    dependsOn: ['cloud-agent-next', 'nextjs'],
    dir: 'services/code-review-infra',
  },
  // auto-triage
  'cloudflare-auto-triage-infra': {
    group: 'auto-triage',
    dependsOn: ['cloud-agent-next', 'nextjs'],
    dir: 'services/auto-triage-infra',
  },
  // auto-fix
  'cloudflare-auto-fix-infra': {
    group: 'auto-fix',
    dependsOn: ['cloud-agent-next', 'nextjs'],
    dir: 'services/auto-fix-infra',
  },
  // deploy
  'cloudflare-deploy-builder': {
    group: 'deploy',
    dependsOn: ['nextjs'],
    dir: 'services/deploy-infra/builder',
  },
  'cloudflare-deploy-dispatcher': {
    group: 'deploy',
    dependsOn: [],
    dir: 'services/deploy-infra/dispatcher',
  },
  // kiloclaw
  'kiloclaw-tunnel': { group: 'kiloclaw', dependsOn: [] },
  'kiloclaw-stripe': { group: 'kiloclaw', dependsOn: [] },
  kiloclaw: {
    group: 'kiloclaw',
    dependsOn: ['postgres', 'kiloclaw-tunnel'],
    dir: 'services/kiloclaw',
  },
  'kiloclaw-inbound-email': {
    group: 'kiloclaw',
    dependsOn: ['kiloclaw'],
    dir: 'services/kiloclaw-inbound-email',
  },
  'kiloclaw-billing': {
    group: 'kiloclaw',
    dependsOn: ['postgres', 'nextjs', 'kiloclaw'],
    dir: 'services/kiloclaw-billing',
  },
  // observability
  'cloudflare-o11y': {
    group: 'observability',
    dependsOn: ['nextjs'],
    dir: 'services/o11y',
  },
  'cloudflare-ai-attribution': {
    group: 'observability',
    dependsOn: [],
    dir: 'services/ai-attribution',
  },
  // storybook
  storybook: { group: 'storybook', dependsOn: [] },
  // gastown
  'cloudflare-gastown': {
    group: 'gastown',
    dependsOn: ['postgres', 'cloudflare-git-token-service', 'nextjs'],
    dir: 'services/gastown',
  },
};

function dockerComposeUp(service: string): string[] {
  return ['docker', 'compose', '-f', 'dev/docker-compose.yml', 'up', '-d', service];
}

function isPrimaryWorktree(): boolean {
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim();
  return path.resolve(gitDir) === path.resolve(gitCommonDir);
}

function computeAutoOffset(): number {
  if (isPrimaryWorktree()) return 0;

  const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  const slug = path.basename(root);

  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) - hash + slug.charCodeAt(i)) | 0;
  }
  return (((hash % 50) + 50) % 50) * 100;
}

function getPortOffset(): number {
  const explicit = process.env.KILO_PORT_OFFSET;
  if (explicit === undefined) return 0; // disabled by default
  if (explicit === 'auto') return computeAutoOffset();
  return Number(explicit);
}

export const portOffset = getPortOffset();

// ---------------------------------------------------------------------------
// Wrangler config discovery
// ---------------------------------------------------------------------------

function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Strings: copy verbatim (preserves "//" inside strings)
    if (text[i] === '"') {
      const start = i;
      i++; // opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      result += text.slice(start, i);
      continue;
    }
    // Line comment
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip */
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, '$1');
}

function readWranglerPort(dir: string): number {
  const configPath = path.join(dir, 'wrangler.jsonc');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No wrangler.jsonc found in ${dir}`);
  }
  const text = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(stripJsonComments(text));
  const port = config?.dev?.port;
  if (typeof port !== 'number') {
    throw new Error(`No dev.port in ${configPath}`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// Build service definitions from serviceMeta + wrangler.jsonc
// ---------------------------------------------------------------------------

const INFRA_PORTS: Record<string, number> = { postgres: 5432, redis: 6379 };

function buildServiceDefs(): ServiceDef[] {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const defs: ServiceDef[] = [];

  for (const [name, meta] of Object.entries(serviceMeta)) {
    const dir = meta.dir ?? name;

    if (name === 'nextjs') {
      defs.push({
        name,
        type: 'nextjs',
        dir: 'apps/web',
        port: 3000 + portOffset,
        dependsOn: meta.dependsOn,
        command: ['pnpm', 'run', 'dev'],
        group: meta.group,
      });
      continue;
    }

    if (name === 'storybook') {
      defs.push({
        name,
        type: 'process',
        dir: 'apps/storybook',
        port: 6006 + portOffset,
        dependsOn: meta.dependsOn,
        command: ['pnpm', 'run', 'storybook', '--', '-p', String(6006 + portOffset)],
        group: meta.group,
      });
      continue;
    }

    if (name in INFRA_PORTS) {
      defs.push({
        name,
        type: 'infra',
        dir: 'dev',
        port: INFRA_PORTS[name],
        dependsOn: meta.dependsOn,
        command: dockerComposeUp(name),
        group: meta.group,
      });
      continue;
    }

    if (name === 'kiloclaw-tunnel') {
      const nextjsPort = 3000 + portOffset;
      const kiloclawPort = readWranglerPort(path.join(repoRoot, 'services/kiloclaw')) + portOffset;
      defs.push({
        name,
        type: 'process',
        dir: '.',
        port: 0,
        dependsOn: meta.dependsOn,
        command: [
          'tsx',
          'dev/local/scripts/start-tunnel.ts',
          String(nextjsPort),
          String(kiloclawPort),
        ],
        group: meta.group,
      });
      continue;
    }

    if (name === 'kiloclaw-stripe') {
      defs.push({
        name,
        type: 'process',
        dir: '.',
        port: 0,
        dependsOn: meta.dependsOn,
        command: ['tsx', 'dev/local/scripts/start-stripe.ts'],
        group: meta.group,
      });
      continue;
    }

    if (name === 'app-builder-tunnel') {
      const appBuilderPort =
        readWranglerPort(path.join(repoRoot, 'services/app-builder')) + portOffset;
      defs.push({
        name,
        type: 'process',
        dir: '.',
        port: 0,
        dependsOn: meta.dependsOn,
        command: ['tsx', 'dev/local/scripts/start-app-builder-tunnel.ts', String(appBuilderPort)],
        group: meta.group,
      });
      continue;
    }

    // Worker — read port from wrangler.jsonc
    const basePort = readWranglerPort(path.join(repoRoot, dir));
    const port = basePort + portOffset;
    const inspectorPort = port + 10000;

    defs.push({
      name,
      type: 'worker',
      dir,
      port,
      dependsOn: meta.dependsOn,
      command: [
        'pnpm',
        'run',
        'dev',
        '--port',
        String(port),
        '--inspector-port',
        String(inspectorPort),
        '--ip',
        '0.0.0.0',
      ],
      group: meta.group,
      ...(meta.useLanIp ? { useLanIp: true } : {}),
    });
  }

  return defs;
}

const serviceDefs = buildServiceDefs();

export const services = new Map<string, ServiceDef>(serviceDefs.map(s => [s.name, s]));

export const shortcuts: Record<string, string[]> = {
  app: ['nextjs'],
  'app-builder': [
    'nextjs',
    'cloud-agent-next',
    'cloudflare-session-ingest',
    'cloudflare-db-proxy',
    'cloudflare-git-token-service',
    'app-builder-tunnel',
    'cloudflare-app-builder',
  ],
  agents: ['cloud-agent-next', 'nextjs', 'cloudflare-session-ingest'],
  all: serviceDefs.map(s => s.name),
};

export function resolveTransitiveDeps(targets: string[]): string[] {
  const result = new Set<string>();
  const stack = [...targets];

  while (stack.length > 0) {
    const name = stack.pop()!;
    if (result.has(name)) continue;
    const svc = services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);
    result.add(name);
    for (const dep of svc.dependsOn) {
      if (!result.has(dep)) {
        stack.push(dep);
      }
    }
  }

  return [...result];
}

// Kahn's algorithm — throws on cycles
export function topologicalSort(serviceNames: string[]): string[] {
  const nameSet = new Set(serviceNames);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const name of nameSet) {
    inDegree.set(name, 0);
    adjacency.set(name, []);
  }

  for (const name of nameSet) {
    const svc = services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);
    for (const dep of svc.dependsOn) {
      if (!nameSet.has(dep)) continue;
      adjacency.get(dep)!.push(name);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nameSet.size) {
    throw new Error('Cycle detected in service dependency graph');
  }

  return sorted;
}

const groupIds = new Set(groups.map(g => g.id));

export function resolveTargets(targets: string[]): string[] {
  const groupIdsToExpand: string[] = [];
  for (const target of targets) {
    if (target in shortcuts) {
      groupIdsToExpand.push(...shortcuts[target].map(name => services.get(name)!.group));
    } else if (groupIds.has(target)) {
      groupIdsToExpand.push(target);
    } else if (services.has(target)) {
      groupIdsToExpand.push(services.get(target)!.group);
    } else {
      const validTargets = [...services.keys(), ...groupIds, ...Object.keys(shortcuts)].join(', ');
      throw new Error(`Unknown target: ${target}. Valid targets: ${validTargets}`);
    }
  }
  const uniqueGroupIds = [...new Set(groupIdsToExpand)];
  const allNames = resolveGroups(resolveGroupTransitiveDeps(uniqueGroupIds));
  return topologicalSort(resolveTransitiveDeps(allNames));
}

export function getService(name: string): ServiceDef {
  const svc = services.get(name);
  if (!svc) throw new Error(`Unknown service: ${name}`);
  return svc;
}

export function getPortMap(): Map<string, number> {
  return new Map([...services.entries()].map(([name, svc]) => [name, svc.port]));
}

export function getGroups(): ServiceGroup[] {
  return groups;
}

export function getGroup(groupId: string): ServiceGroup {
  const g = groups.find(group => group.id === groupId);
  if (!g) throw new Error(`Unknown group: ${groupId}`);
  return g;
}

export function getGroupServiceNames(groupId: string): string[] {
  return serviceDefs.filter(s => s.group === groupId).map(s => s.name);
}

export function getAlwaysOnGroupIds(): string[] {
  return groups.filter(g => g.alwaysOn).map(g => g.id);
}

export function resolveGroups(groupIds: string[]): string[] {
  const directNames = groupIds.flatMap(id => getGroupServiceNames(id));
  return topologicalSort(resolveTransitiveDeps(directNames));
}

/** Resolves transitive group-level dependencies (groupDependsOn), returning all group IDs needed. */
export function resolveGroupTransitiveDeps(groupIds: string[]): string[] {
  const result = new Set<string>();
  const stack = [...groupIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    const group = groups.find(g => g.id === id);
    if (!group) throw new Error(`Unknown group: ${id}`);
    result.add(id);
    for (const dep of group.groupDependsOn ?? []) {
      if (!result.has(dep)) stack.push(dep);
    }
  }
  return [...result];
}

export type { ServiceDef, ServiceType, ServiceGroup };
