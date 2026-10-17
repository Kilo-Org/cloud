import { describe, expect, it, vi } from 'vitest';

import { nativeBaseRecordKey, type BaseEvidence } from './runtime-ci-release.js';
import {
  NATIVE_CONTAINER_BINDING,
  NATIVE_CONTAINER_CLASS,
  admitTrustedNativeBase,
  assertAdmittedSource,
  assertExplicitNativeConfig,
  parseSealedCandidateRecord,
  personalArtifactStore,
  readSourceFacts,
  readToolchain,
  renderPersonalCandidateConfig,
  resolveBuildContext,
  sealCandidateRecord,
  selectPersonalTarget,
  verifySealedCandidate,
  type CandidateContext,
  type CommandRunner,
  type SealedCandidateRecord,
  type SourceFacts,
} from './runtime-personal-candidate.js';
import { sha256 } from './publish-runtime.js';
import { personalCheckoutPath } from './runtime-personal-candidate-cli.js';

const ACCOUNT = 'a'.repeat(32);
const SOURCE_SHA = 'b'.repeat(40);
const TREE_SHA = 'c'.repeat(40);
const BASE_SHA = 'd'.repeat(64);
const DESCRIPTOR_SHA = 'e'.repeat(64);
const ORIGIN = 'https://cloud-agent-next-norwhal-test.engineering-e11.workers.dev';
const MANAGED = `registry.cloudflare.com/${ACCOUNT}/kilo-native@sha256:${'f'.repeat(64)}`;

function baseEvidence(): BaseEvidence {
  return {
    format: 'kilo-native-base-v1',
    inputSha256: BASE_SHA,
    image: MANAGED,
    sourceSha: SOURCE_SHA,
    platform: 'linux/amd64',
    abi: 'kilo-runtime-base-v1',
  };
}

function committedConfig() {
  return {
    name: 'cloud-agent-next',
    account_id: ACCOUNT,
    main: 'src/index.ts',
    vars: {},
    r2_buckets: [
      { binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: 'kilocode-cloud-agent-releases' },
    ],
    containers: [
      { class_name: 'Sandbox', image: './Dockerfile' },
      {
        class_name: NATIVE_CONTAINER_CLASS,
        images: { app: { dockerfile: './Dockerfile.containers' } },
      },
    ],
    durable_objects: {
      bindings: [{ class_name: NATIVE_CONTAINER_CLASS, name: NATIVE_CONTAINER_BINDING }],
    },
    migrations: [{ tag: 'v11', new_sqlite_classes: [NATIVE_CONTAINER_CLASS] }],
    queues: {
      consumers: [{ queue: 'production-callbacks', dead_letter_queue: 'production-callbacks-dlq' }],
      producers: [{ binding: 'REPORT', queue: 'production-reports' }],
    },
  };
}

function operatorConfig() {
  return {
    name: 'cloud-agent-next-norwhal-test',
    account_id: ACCOUNT,
    main: '../src/index.ts',
    vars: { WORKER_URL: ORIGIN },
    queues: {
      consumers: [{ queue: 'personal-callbacks', dead_letter_queue: 'personal-callbacks-dlq' }],
      producers: [{ binding: 'REPORT', queue: 'personal-reports' }],
    },
    r2_buckets: [
      { binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: 'kilocode-cloud-agent-releases' },
    ],
    containers: [
      { class_name: 'Sandbox', image: '../Dockerfile' },
      {
        class_name: NATIVE_CONTAINER_CLASS,
        images: { app: { dockerfile: './Dockerfile.containers' } },
      },
    ],
    durable_objects: {
      bindings: [{ class_name: NATIVE_CONTAINER_CLASS, name: NATIVE_CONTAINER_BINDING }],
    },
    migrations: [{ tag: 'v11', new_sqlite_classes: [NATIVE_CONTAINER_CLASS] }],
  };
}

function mapStore(initial: Record<string, Uint8Array> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    store: {
      async putIfAbsent(key: string, bytes: Uint8Array) {
        if (data.has(key)) return false;
        data.set(key, bytes);
        return true;
      },
      async getBytes(key: string) {
        return data.get(key) ?? null;
      },
    },
    data,
  };
}

function runnerFrom(map: Record<string, string>): CommandRunner {
  return async (program, args) => {
    const key = `${program} ${args.join(' ')}`;
    if (!(key in map)) throw new Error(`unexpected command: ${key}`);
    return { stdout: map[key] };
  };
}

describe('personal artifact store', () => {
  it('refuses production authority and other prefixes but allows shared/personal writes', async () => {
    const writes: string[] = [];
    const base = {
      async putIfAbsent(key: string) {
        writes.push(key);
        return true;
      },
      async getBytes() {
        return null;
      },
    };
    const store = personalArtifactStore(base);
    for (const key of [
      'runtime-artifacts/v1/inputs/x.json',
      'runtime-artifacts/v1/bases/y.json',
      'runtime-artifacts/v1/other/z',
      'secrets/leak',
      'runtime-artifacts/v1/personal/../../inputs/bypass.json',
      'runtime-artifacts/v1/personal/%2e%2e/inputs/bypass.json',
    ]) {
      await expect(store.putIfAbsent(key, new Uint8Array(), 'application/json')).rejects.toThrow();
    }
    for (const key of [
      'runtime-artifacts/v1/objects/deadbeef',
      'runtime-artifacts/v1/releases/abc.json',
      'runtime-artifacts/v1/personal/candidates/abc.json',
    ]) {
      await expect(store.putIfAbsent(key, new Uint8Array(), 'application/json')).resolves.toBe(
        true
      );
    }
    expect(writes).toHaveLength(3);
    await expect(store.getBytes('runtime-artifacts/v1/bases/y.json')).resolves.toBeNull();
  });
});

describe('source facts (command path)', () => {
  it('places the admitted checkout outside the primary dependency-resolution tree', () => {
    const root = '/work/cloud';
    const checkout = personalCheckoutPath(root, 'feature/native');
    expect(checkout.startsWith(root + '/')).toBe(false);
    expect(checkout).toBe('/work/.cloud-agent-runtime-candidates/cloud/feature-native');
  });
  it('reads HEAD, tree, branch head and cleanliness from real git output', async () => {
    const runner = runnerFrom({
      'git rev-parse HEAD': `${SOURCE_SHA}\n`,
      'git rev-parse HEAD^{tree}': `${TREE_SHA}\n`,
      'git check-ref-format --branch feature/native': 'feature/native\n',
      'git rev-parse refs/heads/feature/native': `${SOURCE_SHA}\n`,
      'git status --porcelain': '',
    });
    const facts = await readSourceFacts(runner, '/co', 'feature/native');
    expect(facts).toEqual({
      commitSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      branch: 'feature/native',
      branchHeadSha: SOURCE_SHA,
      dirty: false,
    });
    expect(() => assertAdmittedSource(facts, SOURCE_SHA)).not.toThrow();
  });

  it('refuses a dirty checkout, a mainline branch, a tree mismatch and a HEAD mismatch', () => {
    const base: SourceFacts = {
      commitSha: SOURCE_SHA,
      treeSha: TREE_SHA,
      branch: 'feature/native',
      branchHeadSha: SOURCE_SHA,
      dirty: false,
    };
    expect(() => assertAdmittedSource({ ...base, dirty: true }, SOURCE_SHA)).toThrow(/dirty/);
    expect(() => assertAdmittedSource({ ...base, branch: 'main' }, SOURCE_SHA)).toThrow(/mainline/);
    for (const branch of ['main^0', 'HEAD~1', 'refs/heads/main'])
      expect(() => assertAdmittedSource({ ...base, branch }, SOURCE_SHA)).toThrow(/feature branch/);
    expect(() => assertAdmittedSource({ ...base, commitSha: '9'.repeat(40) }, SOURCE_SHA)).toThrow(
      /HEAD does not match/
    );
    expect(() =>
      assertAdmittedSource({ ...base, branchHeadSha: '9'.repeat(40) }, SOURCE_SHA)
    ).toThrow(/does not resolve/);
  });

  it('reads actual bun/pnpm versions and the lock hash', async () => {
    const runner = runnerFrom({ 'bun --version': '1.3.14\n', 'pnpm --version': '11.1.2\n' });
    const lock = new TextEncoder().encode('lock-contents');
    const toolchain = await readToolchain(runner, '/co', async absolute => {
      expect(absolute).toBe('/co/pnpm-lock.yaml');
      return lock;
    });
    expect(toolchain).toEqual({ bun: '1.3.14', pnpm: '11.1.2', lockSha256: sha256(lock) });
  });
});

describe('personal target validation', () => {
  const options = { origin: ORIGIN };

  it('accepts an explicit personal config and reads account/bucket/lineage from committed source', () => {
    const target = selectPersonalTarget(
      JSON.stringify(operatorConfig()),
      JSON.stringify(committedConfig()),
      options
    );
    expect(target.workerName).toBe('cloud-agent-next-norwhal-test');
    expect(target.accountId).toBe(ACCOUNT);
    expect(target.bucket).toBe('kilocode-cloud-agent-releases');
    expect(target.bindingName).toBe(NATIVE_CONTAINER_BINDING);
    expect(target.className).toBe(NATIVE_CONTAINER_CLASS);
    expect(target.origin).toBe(ORIGIN);
  });

  const reject = (mutate: (config: Record<string, unknown>) => void, pattern: RegExp) => {
    const config = operatorConfig();
    mutate(config as Record<string, unknown>);
    expect(() =>
      selectPersonalTarget(JSON.stringify(config), JSON.stringify(committedConfig()), options)
    ).toThrow(pattern);
  };

  it('rejects production/e2e names, route declarations, account and bucket drift', () => {
    reject(config => (config.name = 'cloud-agent-next-production'), /personal test name/);
    reject(config => (config.name = 'cloud-agent-next-e2e-test'), /personal test name/);
    reject(config => (config.routes = [{ pattern: 'example.com/*' }]), /routes/);
    reject(config => (config.account_id = '9'.repeat(32)), /committed source account/);
    reject(
      config => ((config.r2_buckets as { bucket_name: string }[])[0].bucket_name = 'other-bucket'),
      /release bucket/
    );
  });

  it('rejects a missing/redirected native binding, an origin mismatch, and migration drift', () => {
    reject(
      config =>
        (config.durable_objects = {
          bindings: [
            {
              class_name: NATIVE_CONTAINER_CLASS,
              name: NATIVE_CONTAINER_BINDING,
              script_name: 'other',
            },
          ],
        }),
      /redirect/
    );
    reject(
      config =>
        (config.durable_objects = {
          bindings: [{ class_name: NATIVE_CONTAINER_CLASS, name: 'WRONG_BINDING' }],
        }),
      new RegExp(NATIVE_CONTAINER_BINDING)
    );
    reject(
      config => ((config.vars as Record<string, string>).WORKER_URL = 'https://evil.example/'),
      /WORKER_URL/
    );
    reject(config => (config.migrations = [{ tag: 'v99' }]), /migration lineage/);
  });
});

it('rejects production queues and redirects on any Durable Object binding', () => {
  for (const queues of [
    { consumers: [{ queue: 'production-callbacks' }] },
    { producers: [{ binding: 'REPORT', queue: 'production-reports' }] },
    {
      consumers: [{ queue: 'personal-callbacks', dead_letter_queue: 'production-callbacks-dlq' }],
    },
    { consumers: [{ queue: 'production-callbacks-dlq' }] },
    { producers: [{ binding: 'REPORT', queue: 'production-callbacks-dlq' }] },
  ]) {
    expect(() =>
      selectPersonalTarget(
        JSON.stringify({ ...operatorConfig(), queues }),
        JSON.stringify(committedConfig()),
        { origin: ORIGIN }
      )
    ).toThrow(/production queues/);
  }
  const operator = operatorConfig();
  const redirected = {
    ...operator,
    durable_objects: {
      bindings: [
        ...operator.durable_objects.bindings,
        { name: 'FOREIGN', class_name: 'SandboxSession', script_name: 'cloud-agent-next' },
      ],
    },
  };
  expect(() =>
    selectPersonalTarget(JSON.stringify(redirected), JSON.stringify(committedConfig()), {
      origin: ORIGIN,
    })
  ).toThrow(/redirect/);
});

describe('candidate config rendering', () => {
  function target() {
    return selectPersonalTarget(
      JSON.stringify(operatorConfig()),
      JSON.stringify(committedConfig()),
      { origin: ORIGIN }
    );
  }

  it('renders the admitted image without replacing operator-prepared bindings or paths', () => {
    const operator = {
      ...operatorConfig(),
      services: [{ binding: 'CALLBACK', service: 'personal-callback' }],
    };
    const config = renderPersonalCandidateConfig(operator, {
      descriptor: '{"d":1}',
      target: target(),
      image: MANAGED,
    });
    expect(config.env).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.main).toBe('../src/index.ts');
    const containers = config.containers as Record<string, unknown>[];
    const native = containers.find(entry => entry.class_name === NATIVE_CONTAINER_CLASS);
    expect(native).toBeDefined();
    if (!native) throw new Error('native entry missing');
    const images = native.images as Record<string, { image?: string; dockerfile?: string }>;
    expect(images.app.image).toBe(MANAGED);
    expect(images.app.dockerfile).toBeUndefined();
    const sdk = containers.find(entry => entry.class_name === 'Sandbox');
    expect(sdk?.image).toBe('../Dockerfile');
    expect(config.services).toEqual(operator.services);
    expect(config.vars).toMatchObject({ WORKER_URL: ORIGIN });
    expect(() =>
      assertExplicitNativeConfig(config, { descriptor: '{"d":1}', target: target() })
    ).not.toThrow();
  });

  it('rejects a dockerfile-bearing sealed managed candidate and a competing image', () => {
    const config = renderPersonalCandidateConfig(operatorConfig(), {
      descriptor: '{"d":1}',
      target: target(),
      image: MANAGED,
    });
    const withDockerfile = structuredClone(config) as Record<string, unknown>;
    const native = (withDockerfile.containers as Record<string, unknown>[]).find(
      entry => entry.class_name === NATIVE_CONTAINER_CLASS
    );
    (native as { images: Record<string, unknown> }).images = {
      app: { dockerfile: '../Dockerfile.containers.runtime-free' },
    };
    expect(() =>
      assertExplicitNativeConfig(withDockerfile, { descriptor: '{"d":1}', target: target() })
    ).toThrow(/admitted base image/);
  });

  it('refuses to restore production settings while rendering a personal target', () => {
    expect(() =>
      renderPersonalCandidateConfig(committedConfig(), {
        descriptor: '{"d":1}',
        target: target(),
        image: MANAGED,
      })
    ).toThrow(/operator-prepared target/);
  });
});

describe('build context', () => {
  it('binds resolved paths and refuses a relocated or escaping context', async () => {
    const config = renderPersonalCandidateConfig(operatorConfig(), {
      descriptor: '{"d":1}',
      target: selectPersonalTarget(
        JSON.stringify(operatorConfig()),
        JSON.stringify(committedConfig()),
        {
          origin: ORIGIN,
        }
      ),
      image: MANAGED,
    });
    const read = async (absolute: string) => new TextEncoder().encode(`bytes:${absolute}`);
    const admitted = '/co/services/cloud-agent-next';
    const left = await resolveBuildContext(
      `${admitted}/.wrangler/wrangler.personal-candidate.jsonc`,
      config,
      {
        read,
        admittedRoot: admitted,
      }
    );
    expect(left.main.path).toBe(`${admitted}/src/index.ts`);
    expect(left.cwd).toBe(admitted);

    await expect(
      resolveBuildContext('/other/.wrangler/wrangler.personal-candidate.jsonc', config, {
        read,
        admittedRoot: admitted,
      })
    ).rejects.toThrow(/admitted src\/index.ts/);
  });
});

describe('trusted native base', () => {
  it('refuses a missing record, a wrong account, and an absent verifier; admits with a verifier', async () => {
    const { store } = mapStore();
    const verify = vi.fn(async () => undefined);
    await expect(
      admitTrustedNativeBase({ store, baseSha256: BASE_SHA, accountId: ACCOUNT, verify })
    ).rejects.toThrow(/no trusted native base evidence/);

    const evidence = baseEvidence();
    const bytes = new TextEncoder().encode(JSON.stringify(evidence));
    const present = mapStore({ [nativeBaseRecordKey(BASE_SHA)]: bytes });
    await expect(
      admitTrustedNativeBase({
        store: present.store,
        baseSha256: BASE_SHA,
        accountId: '9'.repeat(32),
        verify,
      })
    ).rejects.toThrow(/different account/);
    await expect(
      admitTrustedNativeBase({ store: present.store, baseSha256: BASE_SHA, accountId: ACCOUNT })
    ).rejects.toThrow(/verifier is required/);
    await expect(
      admitTrustedNativeBase({
        store: present.store,
        baseSha256: BASE_SHA,
        accountId: ACCOUNT,
        verify,
      })
    ).resolves.toEqual(evidence);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('seal verification', () => {
  function context(overrides: Partial<CandidateContext> = {}): CandidateContext {
    return {
      inputs: {
        runtimeSha256: '8'.repeat(64),
        baseSha256: BASE_SHA,
        cliVersion: '7.8.9',
        wrapperSdkVersion: '7.8.9',
      },
      source: {
        commitSha: SOURCE_SHA,
        treeSha: TREE_SHA,
        branch: 'feature/native',
        branchHeadSha: SOURCE_SHA,
        dirty: false,
        expectedSha: SOURCE_SHA,
      },
      toolchain: { bun: '1.3.14', pnpm: '11.1.2', lockSha256: '1'.repeat(64) },
      descriptorSha256: DESCRIPTOR_SHA,
      artifacts: { cliSha256: '2'.repeat(64), controlSha256: '3'.repeat(64) },
      bundleSha256: '4'.repeat(64),
      base: baseEvidence(),
      target: {
        workerName: 'cloud-agent-next-norwhal-test',
        accountId: ACCOUNT,
        bucket: 'kilocode-cloud-agent-releases',
        className: NATIVE_CONTAINER_CLASS,
        bindingName: NATIVE_CONTAINER_BINDING,
        origin: ORIGIN,
        migrationsSha256: '5'.repeat(64),
        preparedConfigSha256: '8'.repeat(64),
      },
      configPath: '/co/.wrangler/wrangler.personal-candidate.jsonc',
      configSha256: '6'.repeat(64),
      buildContext: {
        main: { path: '/co/src/index.ts', sha256: '7'.repeat(64) },
        dockerfile: null,
        cwd: '/co/.wrangler',
      },
      ...overrides,
    };
  }

  function sealed(current: CandidateContext): SealedCandidateRecord {
    return sealCandidateRecord({
      format: 'kilo-runtime-personal-candidate-v1',
      source: { sha: SOURCE_SHA, tree: TREE_SHA, branch: 'feature/native' },
      inputs: {
        runtimeSha256: '8'.repeat(64),
        baseSha256: BASE_SHA,
        cliVersion: '7.8.9',
        wrapperSdkVersion: '7.8.9',
      },
      toolchain: current.toolchain,
      descriptorSha256: current.descriptorSha256,
      artifacts: current.artifacts,
      bundle: { sha256: current.bundleSha256 },
      base: current.base,
      target: current.target,
      config: {
        path: current.configPath,
        sha256: current.configSha256,
        buildContext: current.buildContext,
      },
      status: 'VERIFIED',
    }).record;
  }

  it('accepts a matching context and fails each drift', () => {
    const current = context();
    const record = sealed(current);
    expect(() => verifySealedCandidate(record, current)).not.toThrow();
    expect(parseSealedCandidateRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);

    expect(() =>
      verifySealedCandidate(
        record,
        context({ source: { ...current.source, treeSha: '9'.repeat(40) } })
      )
    ).toThrow(/source tree/);
    expect(() =>
      verifySealedCandidate(record, context({ toolchain: { ...current.toolchain, bun: '0' } }))
    ).toThrow(/toolchain/);
    expect(() => verifySealedCandidate(record, context({ bundleSha256: '9'.repeat(64) }))).toThrow(
      /bundle/
    );
    expect(() => verifySealedCandidate(record, context({ configSha256: '9'.repeat(64) }))).toThrow(
      /config bytes/
    );
    expect(() =>
      verifySealedCandidate(
        record,
        context({
          configPath: '/moved/.wrangler/wrangler.personal-candidate.jsonc',
          buildContext: {
            main: { path: '/moved/src/index.ts', sha256: '7'.repeat(64) },
            dockerfile: null,
            cwd: '/moved/.wrangler',
          },
        })
      )
    ).toThrow(/relocated/);
  });
});
