import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { rootRouter } from './root-router';
import {
  ADMIN_AREA_POLICIES,
  findPrivilegedInventoryEntry,
  internalElevationSites,
  privilegedGuardTiers,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_ROOT = path.join(REPO_ROOT, 'apps/web/src/app');

const BROAD_WILDCARDS = new Set(['organizations.*', 'codeIndexing.*']);

type ProcedureDef = {
  _def?: {
    type?: string;
    middlewares?: readonly unknown[];
  };
};

type DiscoveredRoute = {
  file: string;
  route: string;
  methods: string[];
  explicitAdminGuard: boolean;
  organizationContext: boolean;
};

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(entry.parentPath, entry.name);
    return entry.isDirectory() ? [] : [entryPath];
  });
}

function stripCommentsAndStrings(source: string): string {
  let output = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
        output += ' ';
        index += 1;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        output += '\n';
      }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      state = 'code';
      output += ' ';
    }
    index += 1;
  }

  return output;
}

function countIsAdminReads(source: string): number {
  return (stripCommentsAndStrings(source).match(/\.\s*is_admin\b/g) ?? []).length;
}

function routePathFromAppFile(file: string): string {
  const relative = path.relative(APP_ROOT, file);
  const segments = relative.split(path.sep);
  segments.pop();
  const withoutGroups = segments.filter(segment => !/^\(.+\)$/.test(segment));
  return `/${withoutGroups.join('/')}`;
}

function exportedMethods(source: string): string[] {
  const methods = new Set<string>();
  const exportLines = source.split('\n').filter(line => line.trimStart().startsWith('export '));
  for (const line of exportLines) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      if (new RegExp(`\\b${method}\\b`).test(line)) methods.add(method);
    }
  }
  return [...methods];
}

function accessKindsFor(methods: string[]): ('read' | 'write')[] {
  return methods.length === 0
    ? ['read', 'write']
    : [
        ...new Set(
          methods.map(method => (method === 'GET' || method === 'HEAD' ? 'read' : 'write'))
        ),
      ];
}

function discoverRESTRoutes(): DiscoveredRoute[] {
  return walkFiles(APP_ROOT)
    .filter(file => path.basename(file) === 'route.ts')
    .map(file => {
      const source = fs.readFileSync(file, 'utf8');
      return {
        file,
        route: routePathFromAppFile(file),
        methods: exportedMethods(source),
        explicitAdminGuard: source.includes('adminOnly: true'),
        organizationContext:
          source.includes('getAuthorizedOrgContext(') ||
          source.includes('ensureOrganizationAccess(') ||
          source.includes('ensureOrganizationAccessAndFetchOrg('),
      };
    });
}

function isPrivilegedRoute(discovered: DiscoveredRoute): boolean {
  return (
    discovered.route.startsWith('/admin/') ||
    discovered.explicitAdminGuard ||
    discovered.organizationContext
  );
}

function discoverServerComponents(): { file: string; route: string }[] {
  return walkFiles(APP_ROOT)
    .filter(file => /(page|layout)\.tsx$/.test(path.basename(file)))
    .map(file => ({ file, route: routePathFromAppFile(file) }))
    .filter(({ file, route }) => {
      const source = fs.readFileSync(file, 'utf8');
      return (
        (route.startsWith('/admin') || route.startsWith('/organizations')) &&
        (source.includes('adminOnly: true') || source.includes('getAuthorizedOrgContext('))
      );
    });
}

function workerAdminProcedureNames(worker: 'gastown' | 'wasteland'): string[] {
  const file = path.join(REPO_ROOT, `services/${worker}/src/trpc/router.ts`);
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/^\s*([A-Za-z0-9_]+):\s*adminProcedure\b/gm)].map(
    match => match[1] as string
  );
}

function workerAdminRoute(worker: 'gastown' | 'wasteland', name: string): string {
  return `${worker}.${name}`;
}

const procedures = rootRouter._def.procedures as Record<string, ProcedureDef>;
const discoveredProcedures = Object.entries(procedures).map(([procedurePath, def]) => ({
  path: procedurePath,
  type: def?._def?.type ?? 'query',
  tiers: privilegedGuardTiers(def?._def?.middlewares ?? []),
}));
const adminProcedures = discoveredProcedures.filter(procedure =>
  procedure.path.startsWith('admin.')
);
const privilegedProcedures = discoveredProcedures.filter(
  procedure => procedure.tiers.length > 0 || procedure.path.startsWith('admin.')
);

describe('privileged inventory covers discovered tRPC procedures', () => {
  test('every mounted admin area has a checked-in policy', () => {
    const areas = new Set(
      adminProcedures
        .filter(procedure => procedure.path.split('.').length > 2)
        .map(procedure => procedure.path.split('.')[1] as string)
    );
    const missing = [...areas].filter(area => !(area in ADMIN_AREA_POLICIES));
    expect(missing).toEqual([]);
  });

  test('every admin procedure carries the admin guard and a read/write entry', () => {
    const missing: string[] = [];
    const unguarded: string[] = [];

    for (const procedure of adminProcedures) {
      const access = procedure.type === 'mutation' ? 'write' : 'read';
      const entry = findPrivilegedInventoryEntry({
        surface: 'trpc',
        route: procedure.path,
        access,
      });
      if (!entry) missing.push(procedure.path);
      if (!procedure.tiers.includes('admin')) unguarded.push(procedure.path);
    }

    expect(missing).toEqual([]);
    expect(unguarded).toEqual([]);
  });

  test('every guarded procedure outside admin.* has an explicit entry', () => {
    const problems: string[] = [];

    for (const procedure of privilegedProcedures) {
      const access = procedure.type === 'mutation' ? 'write' : 'read';
      const entry = findPrivilegedInventoryEntry({
        surface: 'trpc',
        route: procedure.path,
        access,
      });
      if (!entry) {
        problems.push(`${procedure.path} (no entry)`);
        continue;
      }
      if (!procedure.path.startsWith('admin.') && BROAD_WILDCARDS.has(entry.route)) {
        problems.push(`${procedure.path} (swallowed by ${entry.route})`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('specialized guard middlewares are recognized on real procedures', () => {
    const tiers = new Set(privilegedProcedures.flatMap(procedure => procedure.tiers));

    expect(tiers).toEqual(
      new Set([
        'admin',
        'superadmin',
        'credit_manager',
        'session_viewer',
        'api_request_log_exporter',
      ])
    );
  });

  test('the guarded procedure list is reviewed as a snapshot', () => {
    const covered = privilegedProcedures
      .map(procedure => {
        const access = procedure.type === 'mutation' ? 'write' : 'read';
        const entry = findPrivilegedInventoryEntry({
          surface: 'trpc',
          route: procedure.path,
          access,
        });
        return `${procedure.path} ${procedure.type} [${[...procedure.tiers].sort().join(',')}] -> ${entry?.id ?? 'NONE'}`;
      })
      .sort();

    expect(covered).toMatchSnapshot('guarded-trpc-procedures');
  });

  test('known non-admin elevation procedures are classified', () => {
    const routes = [
      'cliSessionsV2.list',
      'cliSessionsV2.search',
      'codeIndexing.search',
      'securityAgent.getAuditReport',
      'organizations.securityAgent.getAuditReport',
    ];

    for (const route of routes) {
      expect(
        findPrivilegedInventoryEntry({ surface: 'trpc', route, access: 'read' })
      ).toBeDefined();
    }
  });
});

describe('privileged inventory covers discovered route handlers', () => {
  test('every /admin/api route is classified for each exported method', () => {
    const problems: string[] = [];

    for (const discovered of discoverRESTRoutes()) {
      if (!discovered.route.startsWith('/admin/api/')) continue;
      for (const access of accessKindsFor(discovered.methods)) {
        if (
          !findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          })
        ) {
          problems.push(`${discovered.route} ${access}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test('every route handler with an explicit admin or org-context guard is classified', () => {
    const problems: string[] = [];

    for (const discovered of discoverRESTRoutes()) {
      if (!isPrivilegedRoute(discovered)) continue;
      for (const access of accessKindsFor(discovered.methods)) {
        if (
          !findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          })
        ) {
          problems.push(
            `${discovered.route} ${access} (${path.relative(REPO_ROOT, discovered.file)})`
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test('the privileged route-to-entry mapping is reviewed as a snapshot', () => {
    const mapping = discoverRESTRoutes()
      .filter(isPrivilegedRoute)
      .flatMap(discovered =>
        accessKindsFor(discovered.methods).map(access => {
          const entry = findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          });
          return `${discovered.route} ${access} -> ${entry?.id ?? 'NONE'}`;
        })
      )
      .sort();

    expect(mapping).toMatchSnapshot('privileged-rest-routes');
  });

  test('wildcards stop at path-segment boundaries', () => {
    expect(
      findPrivilegedInventoryEntry({ surface: 'rest', route: '/organizationsX', access: 'read' })
    ).toBeUndefined();
    expect(
      findPrivilegedInventoryEntry({
        surface: 'rest',
        route: '/api/organizations/00000000-0000-0000-0000-000000000000/user-tokens',
        access: 'write',
      })?.id
    ).toBe('rest.organizationTokens');
  });

  test('admin and organization server components are classified', () => {
    const missing: string[] = [];

    for (const component of discoverServerComponents()) {
      if (
        !findPrivilegedInventoryEntry({
          surface: 'server-component',
          route: component.route,
          access: 'read',
        })
      ) {
        missing.push(component.route);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('privileged inventory covers Worker admin gates', () => {
  test.each(['gastown', 'wasteland'] as const)('%s admin procedures are classified', worker => {
    const names = workerAdminProcedureNames(worker);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(
        findPrivilegedInventoryEntry({ surface: 'worker', route: workerAdminRoute(worker, name) })
      ).toBeDefined();
    }
  });

  test('the Worker admin procedure list is reviewed as a snapshot', () => {
    const mapping = (['gastown', 'wasteland'] as const)
      .flatMap(worker =>
        workerAdminProcedureNames(worker).map(name => {
          const route = workerAdminRoute(worker, name);
          const entry = findPrivilegedInventoryEntry({ surface: 'worker', route });
          return `${route} -> ${entry?.id ?? 'NONE'}`;
        })
      )
      .sort();

    expect(mapping).toMatchSnapshot('worker-admin-procedures');
  });

  test('the discovered token-mint entry points are classified', () => {
    const tokenRoutes = discoverRESTRoutes()
      .filter(route => /^\/api\/(gastown|wasteland)\/token$/.test(route.route))
      .map(route => route.route)
      .sort();

    expect(tokenRoutes).toEqual(['/api/gastown/token', '/api/wasteland/token']);
    for (const route of tokenRoutes) {
      expect(
        findPrivilegedInventoryEntry({ surface: 'rest', route, access: 'write' })
      ).toBeDefined();
    }
  });
});

describe('privileged inventory covers branch-level admin reads', () => {
  const roots = [
    'packages/web-shared/src',
    'apps/web/src/lib',
    'apps/web/src/routers',
    'apps/web/src/app',
    'apps/web/src/components',
  ];
  const excluded = new Set([
    'packages/web-shared/src/lib/admin/admin-access-log.ts',
    'packages/web-shared/src/lib/admin/privileged-access.ts',
    'packages/web-shared/src/lib/admin/privileged-inventory.ts',
  ]);

  function serverFiles(): string[] {
    const files = new Set<string>();
    for (const root of roots) {
      for (const file of walkFiles(path.join(REPO_ROOT, root))) {
        if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
        if (file.startsWith(path.join(REPO_ROOT, 'packages/web-shared/src/tests/'))) continue;
        if (file.endsWith('.ts')) {
          const relative = path.relative(REPO_ROOT, file);
          if (!excluded.has(relative)) files.add(relative);
        } else if (
          file.endsWith('.tsx') &&
          !fs.readFileSync(file, 'utf8').includes("'use client'")
        ) {
          files.add(path.relative(REPO_ROOT, file));
        }
      }
    }
    return [...files].sort();
  }

  function isAdminReadsIn(relativeFile: string): number {
    return countIsAdminReads(fs.readFileSync(path.join(REPO_ROOT, relativeFile), 'utf8'));
  }

  test('does not let a comment marker inside a string hide a real read', () => {
    const source = [
      'const url = "https://github.com/example/repo"; const flag = user.is_admin;',
      'const quoted = "ctx.user.is_admin";',
      '// user.is_admin in a line comment',
      '/* tenant.is_admin in a block comment */',
      'const record = { is_admin: false };',
      'const value = ctx.user.is_admin;',
    ].join('\n');

    expect(countIsAdminReads(source)).toBe(2);
  });

  test('every is_admin read is classified with a reviewed occurrence count', () => {
    const counts = new Map(internalElevationSites.map(site => [site.file, site.occurrences]));
    const problems: string[] = [];

    for (const file of serverFiles()) {
      const actual = isAdminReadsIn(file);
      if (actual === 0) continue;
      const expected = counts.get(file);
      if (expected === undefined) {
        problems.push(`${file}: unclassified (${actual} occurrences)`);
      } else if (expected !== actual) {
        problems.push(`${file}: expected ${expected} occurrences, found ${actual}`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every checked-in branch-level site still exists at its reviewed count', () => {
    const stale: string[] = [];

    for (const site of internalElevationSites) {
      const absolute = path.join(REPO_ROOT, site.file);
      if (!fs.existsSync(absolute) || isAdminReadsIn(site.file) !== site.occurrences) {
        stale.push(site.file);
      }
    }

    expect(stale).toEqual([]);
  });
});
