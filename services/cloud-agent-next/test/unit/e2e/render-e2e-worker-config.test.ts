import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { buildE2eWorkerConfig } from '../../e2e/deploy/render-e2e-worker-config.mjs';

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
    expect(config.main).toBe('../src/index.ts');
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

  it('keeps each surviving class on its original production migration tag', () => {
    const { source, config } = render();

    const productionTagByClass = new Map<string, string>();
    for (const migration of source.migrations) {
      for (const className of migration.new_sqlite_classes) {
        productionTagByClass.set(className, migration.tag);
      }
    }

    for (const migration of config.migrations) {
      for (const className of migration.new_sqlite_classes) {
        expect(migration.tag).toBe(productionTagByClass.get(className));
      }
    }

    const productionTags = source.migrations.map((migration: { tag: string }) => migration.tag);
    const tags = config.migrations.map((migration: { tag: string }) => migration.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      expect(productionTags).toContain(tag);
    }
  });

  it('renders a subsequence of production migrations with removed classes stripped', () => {
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

    expect(config.migrations).toEqual(survivingProductionMigrations);

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
      ],
    };
    const config = buildE2eWorkerConfig(source, overrides);
    expect(config.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
      { tag: 'v2', new_classes: ['LegacyDo'] },
    ]);
  });

  it('drops a migration whose new_classes are all removed', () => {
    const source = {
      containers: [{ class_name: 'Sandbox' }, { class_name: 'SandboxSmall' }],
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] },
        { tag: 'v2', new_classes: ['Sandbox'] },
      ],
    };
    const config = buildE2eWorkerConfig(source, overrides);
    expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['CloudAgentSession'] }]);
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

  it('does not mutate the source config', () => {
    const source = readSourceConfig();
    const snapshot = structuredClone(source);
    buildE2eWorkerConfig(source, overrides);
    expect(source).toEqual(snapshot);
    expect(source.main).toBe('src/index.ts');
    expect(source.containers[0].image).toBe('./Dockerfile');
  });
});
