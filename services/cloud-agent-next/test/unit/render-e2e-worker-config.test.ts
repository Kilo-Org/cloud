import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildE2eWorkerConfig,
  buildLocalDevVarsContent,
  buildLocalE2eWorkerConfig,
  requireE2eInternalSecret,
  renderLocal,
} from '../e2e/deploy/render-e2e-worker-config.mjs';
import { LOCAL_E2E_INTERNAL_API_SECRET } from '../e2e/e2e-internal-secret';

const overrides = {
  workerUrl: 'https://cloud-agent-e2e-test.engineering-e11.workers.dev',
  kiloOpenRouterBase: 'https://fake-llm.engineering-e11.workers.dev/api/openrouter',
  e2eUserId: 'user-1',
};

const REMOVED_CONTAINER_CLASSES = [
  'Sandbox',
  'SandboxDIND',
  'SandboxCodeReview',
  'SandboxContainment',
  'SandboxSmallContainment',
  'SandboxCodeReviewContainment',
  // `SandboxContainers` is the newest production container class (migration
  // `v11`). The e2e render keeps only `SandboxSmall`, so it is removed here
  // alongside the older sandbox classes; the pinned list must gain it whenever
  // production adds a container class.
  'SandboxContainers',
];

const KEPT_DO_CLASSES = [
  'CloudAgentSession',
  'StreamTicketNonceDO',
  'UserKiloFacade',
  'SandboxControl',
  'SandboxSession',
];

function readSourceConfig() {
  return parse(readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8'));
}

function render() {
  const source = readSourceConfig();
  return { source, config: buildE2eWorkerConfig(source, overrides) };
}

describe('buildE2eWorkerConfig', () => {
  it('rebases identity, main and schema', () => {
    const { config } = render();
    expect(config.main).toBe('../src/e2e-entry.ts');
    expect(config.name).toBe('cloud-agent-e2e-test');
    expect(config.workers_dev).toBe(true);
    expect(config.$schema).toBe('../node_modules/wrangler/config-schema.json');
  });

  it('keeps only SandboxSmall with a rebased image and a 20-instance cap', () => {
    const { config } = render();
    expect(config.containers).toHaveLength(1);
    expect(config.containers[0].class_name).toBe('SandboxSmall');
    expect(config.containers[0].image).toBe('../Dockerfile');
    expect(config.containers[0].instance_type).toEqual({
      vcpu: 2,
      memory_mib: 6144,
      disk_mb: 10000,
    });
    expect(config.containers[0].max_instances).toBe(20);
    expect(config.containers[0].ssh.enabled).toBe(true);
  });

  it('removes the other sandbox classes from containers, bindings and migrations', () => {
    const { config } = render();
    for (const className of REMOVED_CONTAINER_CLASSES) {
      expect(
        config.containers.some(
          (container: { class_name: string }) => container.class_name === className
        )
      ).toBe(false);
      expect(
        config.durable_objects.bindings.some(
          (binding: { class_name: string }) => binding.class_name === className
        )
      ).toBe(false);
      expect(
        config.migrations.some((migration: { new_sqlite_classes: string[] }) =>
          migration.new_sqlite_classes.includes(className)
        )
      ).toBe(false);
    }
  });

  it('keeps the non-container Durable Objects and their migrations', () => {
    const { config } = render();
    const bindingClasses = config.durable_objects.bindings.map(
      (binding: { class_name: string }) => binding.class_name
    );
    const migratedClasses = config.migrations.flatMap(
      (migration: { new_sqlite_classes: string[] }) => migration.new_sqlite_classes
    );
    for (const className of KEPT_DO_CLASSES) {
      expect(bindingClasses).toContain(className);
      expect(migratedClasses).toContain(className);
    }
  });

  it('keeps each surviving production class on its original production migration tag', () => {
    const { source, config } = render();

    const productionTagByClass = new Map<string, string>();
    for (const migration of source.migrations) {
      for (const className of migration.new_sqlite_classes) {
        productionTagByClass.set(className, migration.tag);
      }
    }

    const productionTags = source.migrations.map((migration: { tag: string }) => migration.tag);
    for (const migration of config.migrations) {
      for (const className of migration.new_sqlite_classes) {
        const productionTag = productionTagByClass.get(className);
        if (productionTag === undefined) continue;
        expect(migration.tag).toBe(productionTag);
      }
      if (!productionTags.includes(migration.tag)) {
        expect(migration.tag).toBe('v10-e2e');
      }
    }

    const tags = config.migrations.map((migration: { tag: string }) => migration.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      if (tag === 'v10-e2e') continue;
      expect(productionTags).toContain(tag);
    }
  });

  it('renders the surviving production migrations as a subsequence with the e2e tag', () => {
    const { source, config } = render();

    const removed = new Set(REMOVED_CONTAINER_CLASSES);
    const survivingProductionMigrations = source.migrations
      .map((migration: { tag: string; new_sqlite_classes: string[] }) => ({
        ...migration,
        new_sqlite_classes: migration.new_sqlite_classes.filter(
          (className: string) => !removed.has(className)
        ),
      }))
      .filter(
        (migration: { new_sqlite_classes: string[] }) => migration.new_sqlite_classes.length > 0
      );

    const renderedTags = config.migrations.map((migration: { tag: string }) => migration.tag);
    const v10Index = renderedTags.indexOf('v10');
    const e2eIndex = renderedTags.indexOf('v10-e2e');
    expect(v10Index).toBeGreaterThanOrEqual(0);
    expect(e2eIndex).toBe(v10Index + 1);

    expect(
      config.migrations.filter((migration: { tag: string }) => migration.tag !== 'v10-e2e')
    ).toEqual(survivingProductionMigrations);

    for (const migration of config.migrations as { new_sqlite_classes: string[] }[]) {
      expect(migration.new_sqlite_classes.length).toBeGreaterThan(0);
    }

    const bindingClasses = config.durable_objects.bindings.map(
      (binding: { class_name: string }) => binding.class_name
    );
    const migratedClasses = config.migrations.flatMap(
      (migration: { new_sqlite_classes: string[] }) => migration.new_sqlite_classes
    );
    expect([...migratedClasses].sort()).toEqual([...bindingClasses].sort());
  });

  it('keeps and filters non-SQLite new_classes migrations', () => {
    const source = {
      containers: [{ class_name: 'Sandbox' }, { class_name: 'SandboxSmall' }],
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
        { tag: 'v2', new_classes: ['LegacyDo', 'Sandbox'] },
        { tag: 'v10', new_sqlite_classes: ['SandboxSession'] },
      ],
    };
    const config = buildE2eWorkerConfig(source, overrides);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
      { tag: 'v2', new_classes: ['LegacyDo'] },
      { tag: 'v10', new_sqlite_classes: ['SandboxSession'] },
      { tag: 'v10-e2e', new_sqlite_classes: ['E2eCallbackSink'] },
    ]);
  });

  it('drops a migration whose new_classes are all removed', () => {
    const source = {
      containers: [{ class_name: 'Sandbox' }, { class_name: 'SandboxSmall' }],
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
        { tag: 'v2', new_classes: ['Sandbox'] },
        { tag: 'v10', new_sqlite_classes: ['SandboxSession'] },
      ],
    };
    const config = buildE2eWorkerConfig(source, overrides);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
      { tag: 'v10', new_sqlite_classes: ['SandboxSession'] },
      { tag: 'v10-e2e', new_sqlite_classes: ['E2eCallbackSink'] },
    ]);
  });

  it('binds the e2e callback sink and registers it directly after v10', () => {
    const { source, config } = render();
    expect(config.durable_objects.bindings).toContainEqual({
      class_name: 'E2eCallbackSink',
      name: 'E2E_CALLBACK_SINK',
    });

    const renderedV10 = config.migrations.find(
      (migration: { tag: string }) => migration.tag === 'v10'
    );
    const sourceV10 = source.migrations.find(
      (migration: { tag: string }) => migration.tag === 'v10'
    );
    expect(renderedV10).toEqual(sourceV10);

    const productionOrder = source.migrations
      .map((migration: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }) => {
        const filtered = { ...migration };
        if (migration.new_sqlite_classes) {
          filtered.new_sqlite_classes = migration.new_sqlite_classes.filter(
            (className: string) => !REMOVED_CONTAINER_CLASSES.includes(className)
          );
        }
        if (migration.new_classes) {
          filtered.new_classes = migration.new_classes.filter(
            (className: string) => !REMOVED_CONTAINER_CLASSES.includes(className)
          );
        }
        return filtered;
      })
      .filter(
        (migration: { new_sqlite_classes?: string[]; new_classes?: string[] }) =>
          (migration.new_sqlite_classes?.length ?? 0) + (migration.new_classes?.length ?? 0) > 0
      )
      .map((migration: { tag: string }) => migration.tag);
    const renderedOrder = config.migrations
      .map((migration: { tag: string }) => migration.tag)
      .filter((tag: string) => tag !== 'v10-e2e');
    expect(renderedOrder).toEqual(productionOrder);
  });

  it('refuses to append the e2e migration when the v10 anchor is missing', () => {
    const source = readSourceConfig();
    source.migrations = source.migrations.filter(
      (migration: { tag: string }) => migration.tag !== 'v10'
    );

    expect(() => buildE2eWorkerConfig(source, overrides)).toThrow(/v10/);
  });

  it('adds the strict-public fetch flag only to the rendered config', () => {
    const { source, config } = render();
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
    expect(source.compatibility_flags).not.toContain('global_fetch_strictly_public');
  });

  it('renders identical migrations and bindings on repeated calls', () => {
    const first = buildE2eWorkerConfig(readSourceConfig(), overrides);
    const second = buildE2eWorkerConfig(readSourceConfig(), overrides);
    expect(JSON.stringify(second.migrations)).toBe(JSON.stringify(first.migrations));
    expect(JSON.stringify(second.durable_objects.bindings)).toBe(
      JSON.stringify(first.durable_objects.bindings)
    );
  });

  it('removes the report queue and renames the callback queue on both sides', () => {
    const { config } = render();
    expect(
      config.queues.producers.some(
        (producer: { binding: string }) => producer.binding === 'CLOUD_AGENT_REPORT_QUEUE'
      )
    ).toBe(false);
    expect(
      config.queues.consumers.some(
        (consumer: { queue: string }) => consumer.queue === 'cloud-agent-next-report-queue'
      )
    ).toBe(false);
    expect(config.queues.producers).toHaveLength(1);
    expect(config.queues.producers[0].queue).toBe('cloud-agent-next-callback-queue-e2e-test');
    expect(config.queues.consumers).toHaveLength(1);
    expect(config.queues.consumers[0].queue).toBe('cloud-agent-next-callback-queue-e2e-test');
  });

  it('applies the e2e and helper vars while keeping inherited vars', () => {
    const { config } = render();
    expect(config.vars.WORKER_URL).toBe(overrides.workerUrl);
    expect(config.vars.KILOCODE_BACKEND_BASE_URL).toBe('https://api.kilo.ai');
    expect(config.vars.KILO_OPENROUTER_BASE).toBe(overrides.kiloOpenRouterBase);
    expect(config.vars.WS_ALLOWED_ORIGINS).toBe(
      'https://app.kilo.ai,https://api.kilo.ai,http://localhost:3000'
    );
    expect(config.vars.PER_SESSION_SANDBOX_ORG_IDS).toBe('*');
    expect(config.vars.TOOL_CGROUP_ORG_IDS).toBe('*');
    expect(config.vars.TOOL_CGROUP_MODE).toBe('enforce');
    expect(config.vars.TOOL_CGROUP_RESERVE_MB).toBe('1024');
    expect(config.vars.TOOL_CGROUP_CPU_WEIGHT).toBe('50');
    expect(config.vars.CONTROL_PLANE_IDS).toBe('user-1');
    expect(config.vars.WORKTREE_CREATION_ENABLED_IDS).toBe('user-1');
    expect(config.vars.CLOUD_AGENT_CONTAINER_BILLING_ENABLED).toBe('false');
    expect(config.vars.CLOUD_AGENT_CONTAINER_BILLING_USER_IDS).toBe('');
    expect(config.vars.CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS).toBe('');
    expect(config.vars.CREDENTIAL_CONTAINMENT_ENABLED).toBe('false');
    expect(config.vars.KILO_SESSION_INGEST_URL).toBe('https://ingest.kilosessions.ai');
  });

  it('fails the render when E2E_USER_ID is absent or empty', () => {
    for (const e2eUserId of [undefined, '', '   ']) {
      expect(() => buildE2eWorkerConfig(readSourceConfig(), { ...overrides, e2eUserId })).toThrow(
        /E2E_USER_ID/
      );
    }
  });

  it('renders no surface allowlist: the deployed secret is a Worker secret, not a var', () => {
    const { config } = render();
    expect(config.vars).not.toHaveProperty('E2E_SURFACE_USER_IDS');
    expect(JSON.stringify(config)).not.toContain('E2E_SURFACE_USER_IDS');
  });

  it('enrols every authenticated user only for an explicit *', () => {
    const config = buildE2eWorkerConfig(readSourceConfig(), { ...overrides, e2eUserId: ' * ' });
    expect(config.vars.CONTROL_PLANE_IDS).toBe('*');
    expect(config.vars.WORKTREE_CREATION_ENABLED_IDS).toBe('*');
  });

  it('adds the NEXTAUTH_SECRET binding and keeps existing bindings', () => {
    const { config } = render();
    const nextauth = config.secrets_store_secrets.find(
      (secret: { binding: string }) => secret.binding === 'NEXTAUTH_SECRET'
    );
    expect(nextauth).toEqual({
      binding: 'NEXTAUTH_SECRET',
      store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
      secret_name: 'NEXTAUTH_SECRET',
    });
    const internalApiSecret = config.secrets_store_secrets.find(
      (secret: { binding: string }) => secret.binding === 'INTERNAL_API_SECRET_PROD'
    );
    expect(internalApiSecret).toEqual({
      binding: 'INTERNAL_API_SECRET_PROD',
      store_id: '342a86d9e3a94da698e82d0c6e2a36f0',
      secret_name: 'INTERNAL_API_SECRET_PROD',
    });
  });

  it('pins the e2e KV namespace id and leaves no KV binding unpinned', () => {
    const { config } = render();
    expect(config.kv_namespaces).toEqual([
      { binding: 'SHARED_SANDBOX_OVERRIDES', id: '4d5f651fb14b4de682204eaa9fa60a7d' },
    ]);
    for (const kvNamespace of config.kv_namespaces as { id?: string }[]) {
      expect(kvNamespace.id).toBeTruthy();
    }
  });

  it('removes dev, env and routes while keeping triggers', () => {
    const { source, config } = render();
    expect('dev' in config).toBe(false);
    expect('env' in config).toBe(false);
    expect('routes' in config).toBe(false);
    expect(config.triggers).toEqual(source.triggers);
  });

  it('leaves the source top-level vars without KILO_OPENROUTER_BASE', () => {
    const source = readSourceConfig();
    expect(source.vars).not.toHaveProperty('KILO_OPENROUTER_BASE');
  });

  it('leaves the production source config free of the e2e callback sink and fetch flag', () => {
    const source = readSourceConfig();
    expect(JSON.stringify(source)).not.toContain('E2eCallbackSink');
    expect(JSON.stringify(source)).not.toContain('global_fetch_strictly_public');
    expect(source.main).toBe('src/index.ts');
  });

  it('does not mutate the source config', () => {
    const source = readSourceConfig();
    const snapshot = structuredClone(source);
    buildE2eWorkerConfig(source, overrides);
    expect(source).toEqual(snapshot);
    expect(source.main).toBe('src/index.ts');
    expect(source.containers[0].image).toBe('./Dockerfile');
  });
});

describe('local e2e worker config', () => {
  function renderLocalConfig() {
    return {
      config: buildLocalE2eWorkerConfig(readSourceConfig()),
    };
  }

  it('points main at the e2e entrypoint and keeps the dev environment', () => {
    const { config } = renderLocalConfig();
    expect(config.main).toBe('../src/e2e-entry.ts');
    expect(config.$schema).toBe('../node_modules/wrangler/config-schema.json');
    expect(config.env?.dev).toBeDefined();
    expect(config.env.dev.vars).toBeDefined();
  });

  it('renders no surface allowlist into the top level or the preserved env.dev vars', () => {
    const { config } = renderLocalConfig();
    expect(JSON.stringify(config)).not.toContain('E2E_SURFACE_USER_IDS');
  });

  it('binds the callback sink in both the top level and env.dev, and migrates it after v10', () => {
    const { config } = renderLocalConfig();
    const expectedBinding = { class_name: 'E2eCallbackSink', name: 'E2E_CALLBACK_SINK' };
    expect(config.durable_objects.bindings).toContainEqual(expectedBinding);
    expect(config.env.dev.durable_objects.bindings).toContainEqual(expectedBinding);

    const renderedTags = config.migrations.map((migration: { tag: string }) => migration.tag);
    expect(renderedTags.indexOf('v10-e2e')).toBe(renderedTags.indexOf('v10') + 1);
    expect(config.migrations).toContainEqual({
      new_sqlite_classes: ['E2eCallbackSink'],
      tag: 'v10-e2e',
    });
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
  });

  it('drops routes so the local Worker origin is the request host, not the production route', () => {
    const { config } = renderLocalConfig();
    expect('routes' in config).toBe(false);
  });

  it('resolves every relative container image from both the top level and env.dev', () => {
    const { config } = renderLocalConfig();
    const images = [
      ...(config.containers ?? []).map(entry => entry.image),
      ...(config.env?.dev?.containers ?? []).map(entry => entry.image),
    ];
    const relative = images.filter((image: unknown): image is string =>
      typeof image === 'string' ? image.startsWith('./') || image.startsWith('../') : false
    );
    expect(relative.length).toBeGreaterThan(0);
    for (const image of relative) {
      expect(existsSync(resolve(process.cwd(), '.wrangler', image)), image).toBe(true);
    }
    // The entrypoint and schema are relative too; both must resolve.
    expect(existsSync(resolve(process.cwd(), '.wrangler', config.main))).toBe(true);
    expect(existsSync(resolve(process.cwd(), '.wrangler', config.$schema))).toBe(true);
  });

  it('does not mutate the source config', () => {
    const source = readSourceConfig();
    const snapshot = structuredClone(source);
    buildLocalE2eWorkerConfig(source);
    expect(source).toEqual(snapshot);
    expect(source.main).toBe('src/index.ts');
    expect(source.containers[0].image).toBe('./Dockerfile');
  });
});

const VALID_SECRET = 'e2e-internal-secret-0123456789';

describe('requireE2eInternalSecret', () => {
  it('accepts a value that satisfies the deployment rules', () => {
    expect(requireE2eInternalSecret(VALID_SECRET)).toBe(VALID_SECRET);
  });

  it('rejects empty and short values', () => {
    for (const raw of [undefined, '']) {
      expect(() => requireE2eInternalSecret(raw)).toThrow(/required/);
    }
    expect(() => requireE2eInternalSecret('short-secret')).toThrow(/at least 16/);
  });

  it('rejects whitespace-bearing values, padded or internal', () => {
    expect(() => requireE2eInternalSecret(`${VALID_SECRET}\n`)).toThrow(/whitespace/);
    expect(() => requireE2eInternalSecret('e2e internal secret')).toThrow(/whitespace/);
  });

  it('rejects characters outside the dotenv-safe alphabet', () => {
    expect(() => requireE2eInternalSecret('e2e-internal-secret+#!')).toThrow(/match/);
  });

  it('rejects the default literal pinned by e2e-internal-secret.ts', () => {
    expect(() => requireE2eInternalSecret(LOCAL_E2E_INTERNAL_API_SECRET)).toThrow(
      /development default/
    );
  });
});

describe('buildLocalDevVarsContent', () => {
  it('upserts the secret and preserves every other line', () => {
    const existing =
      'NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=stale-value-000000\nPRIVATE_KEY=line1\nline2\n';
    expect(buildLocalDevVarsContent(existing, VALID_SECRET)).toBe(
      `NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=${VALID_SECRET}\nPRIVATE_KEY=line1\nline2\n`
    );
  });

  it('appends the secret when the file has none and handles empty content', () => {
    expect(buildLocalDevVarsContent('NEXTAUTH_SECRET=abc\n', VALID_SECRET)).toBe(
      `NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=${VALID_SECRET}\n`
    );
    expect(buildLocalDevVarsContent('', VALID_SECRET)).toBe(
      `INTERNAL_API_SECRET=${VALID_SECRET}\n`
    );
  });
});

describe('renderLocal', () => {
  const fixtureDirs: string[] = [];

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeLocalFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-render-'));
    fixtureDirs.push(dir);
    mkdirSync(join(dir, '.wrangler'), { recursive: true });
    copyFileSync(join(process.cwd(), 'wrangler.jsonc'), join(dir, 'wrangler.jsonc'));
    return {
      dir,
      paths: {
        packageDir: dir,
        sourceConfigPath: join(dir, 'wrangler.jsonc'),
        targetConfigPath: join(dir, '.wrangler', 'wrangler.e2e-local.jsonc'),
        packageDevVarsPath: join(dir, '.dev.vars'),
        localDevVarsPath: join(dir, '.wrangler', '.dev.vars'),
      },
    };
  }

  it('writes the rendered config and the secret into .wrangler/.dev.vars', () => {
    const { paths } = makeLocalFixture();
    writeFileSync(
      paths.packageDevVarsPath,
      'NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=stale-value-000000\n'
    );

    renderLocal({
      internalApiSecret: VALID_SECRET,
      paths,
      log: () => {},
    });

    expect(existsSync(paths.targetConfigPath)).toBe(true);
    expect(readFileSync(paths.localDevVarsPath, 'utf8')).toBe(
      `NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=${VALID_SECRET}\n`
    );
    expect(readFileSync(paths.targetConfigPath, 'utf8')).not.toContain('E2E_SURFACE_USER_IDS');
  });

  it('validates the secret before writing anything', () => {
    const { paths } = makeLocalFixture();
    writeFileSync(paths.packageDevVarsPath, 'NEXTAUTH_SECRET=abc\n');

    expect(() => renderLocal({ internalApiSecret: 'short', paths, log: () => {} })).toThrow(
      /at least 16/
    );

    expect(existsSync(paths.targetConfigPath)).toBe(false);
    expect(existsSync(paths.localDevVarsPath)).toBe(false);
    expect(readFileSync(paths.packageDevVarsPath, 'utf8')).toBe('NEXTAUTH_SECRET=abc\n');
  });

  it('refuses a conflicting .dev.vars.dev beside the generated file without touching generated output', () => {
    const { paths } = makeLocalFixture();
    writeFileSync(paths.packageDevVarsPath, 'NEXTAUTH_SECRET=abc\n');
    // The selected config is `.wrangler/wrangler.e2e-local.jsonc`, so Wrangler
    // resolves `.dev.vars.dev` beside it and it shadows the generated file.
    const conflicting = `${paths.localDevVarsPath}.dev`;
    writeFileSync(conflicting, 'INTERNAL_API_SECRET=shadowing-value-000\n');
    // Pre-create the generated outputs so refusal is proven non-destructive,
    // not merely "nothing was created".
    writeFileSync(paths.targetConfigPath, '{"sentinel":"config"}\n');
    writeFileSync(paths.localDevVarsPath, 'SENTINEL_DEV_VARS=1\n');

    expect(() =>
      renderLocal({
        internalApiSecret: VALID_SECRET,
        paths,
        log: () => {},
      })
    ).toThrow(/\.dev\.vars\.dev/);

    expect(readFileSync(paths.targetConfigPath, 'utf8')).toBe('{"sentinel":"config"}\n');
    expect(readFileSync(paths.localDevVarsPath, 'utf8')).toBe('SENTINEL_DEV_VARS=1\n');
    expect(readFileSync(conflicting, 'utf8')).toBe('INTERNAL_API_SECRET=shadowing-value-000\n');
  });

  it('does not treat a package-root .dev.vars.dev as a conflict for a config under .wrangler/', () => {
    const { dir, paths } = makeLocalFixture();
    writeFileSync(paths.packageDevVarsPath, 'NEXTAUTH_SECRET=abc\n');
    // Not the file Wrangler loads for `.wrangler/wrangler.e2e-local.jsonc`.
    writeFileSync(join(dir, '.dev.vars.dev'), 'INTERNAL_API_SECRET=package-root-value-00\n');

    renderLocal({ internalApiSecret: VALID_SECRET, paths, log: () => {} });

    expect(existsSync(paths.targetConfigPath)).toBe(true);
    expect(readFileSync(paths.localDevVarsPath, 'utf8')).toBe(
      `NEXTAUTH_SECRET=abc\nINTERNAL_API_SECRET=${VALID_SECRET}\n`
    );
  });
});
