import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import {
  FEED_CONFIG,
  MINT_CONFIG,
  parseWorkerConfig,
  repoRoot,
  utsConfigProblems,
  workerConfigPaths,
  workerConfigProblems,
  type WorkerConfig,
} from './worker-configs';

/**
 * Reads a config with Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses. It lives
 * in this test file because wrangler's published types re-export from `@cloudflare/workers-utils`,
 * which wrangler does not ship, so type-aware lint sees the function as `error` typed everywhere
 * but `*.test.ts` (as in services/sts/test/repo).
 */
const readWorkerConfig = (path: string) =>
  parseWorkerConfig(path, experimental_readRawConfig({ config: join(repoRoot, path) }).rawConfig);

const repoConfigs = () => workerConfigPaths(repoRoot).map(readWorkerConfig);
const configAt = (path: string) => readWorkerConfig(path);

const NO_TRACES = { observability: { enabled: true, traces: { enabled: false } } };

const consumer = (raw: Record<string, unknown>, path = 'services/consumer/wrangler.jsonc') =>
  parseWorkerConfig(path, { name: 'consumer', ...NO_TRACES, ...raw });

/** The repository's own UTS configs, with `edit` applied to the feed config. */
function withFeed(edit: (raw: Record<string, unknown>) => Record<string, unknown>): WorkerConfig[] {
  const feed = configAt(FEED_CONFIG);
  return [
    configAt(MINT_CONFIG),
    parseWorkerConfig(FEED_CONFIG, edit(structuredClone(feed.config))),
  ];
}

const mintBinding = (service: string, caller: string) => ({
  binding: 'UTS_MINT',
  service,
  props: { caller },
});

describe('repository Worker configs', () => {
  it('reach UTS only the way the rules allow', () => {
    expect(workerConfigProblems(repoConfigs())).toEqual([]);
  });

  it('keep the two UTS Workers as configured: names, eu jurisdiction, placement, no traces', () => {
    expect(utsConfigProblems(repoConfigs())).toEqual([]);
  });
});

describe('UTS Durable Object classes', () => {
  it('fail a config outside the mint Worker that names the signer class', () => {
    const problems = workerConfigProblems([
      consumer({ durable_objects: { bindings: [{ name: 'SIGNER', class_name: 'UtsSignerDO' }] } }),
    ]);
    expect(problems).toEqual([
      expect.stringContaining('names UTS Durable Object class UtsSignerDO'),
    ]);
  });

  it('fail a config that names the signer class in an env block or a preview', () => {
    const objects = {
      durable_objects: { bindings: [{ name: 'SIGNER', class_name: 'UtsSignerDO' }] },
    };
    expect(workerConfigProblems([consumer({ env: { staging: objects } })])).toHaveLength(1);
    expect(workerConfigProblems([consumer({ previews: objects })])).toHaveLength(1);
  });

  it('fail the feed Worker binding the signer class', () => {
    const problems = workerConfigProblems(
      withFeed(raw => ({
        ...raw,
        durable_objects: {
          bindings: [{ name: 'SIGNER', class_name: 'UtsSignerDO', script_name: 'uts' }],
        },
      }))
    );
    expect(problems).toEqual([expect.stringContaining('only services/uts/wrangler.jsonc')]);
  });

  it('fail any reference to a UTS script by name', () => {
    const references = [
      {
        durable_objects: {
          bindings: [{ name: 'X', class_name: 'Other', script_name: 'uts-staging' }],
        },
      },
      { workflows: [{ binding: 'W', name: 'w', class_name: 'W', script_name: 'uts' }] },
      { tail_consumers: [{ service: 'uts-feed' }] },
      {
        migrations: [
          { tag: 'v1', transferred_classes: [{ from: 'A', from_script: 'uts', to: 'B' }] },
        ],
      },
      { exports: { A: { transfer_from: 'uts' } } },
    ];
    for (const raw of references) {
      expect(workerConfigProblems([consumer(raw)])).toEqual([
        expect.stringContaining('UTS classes and handlers are internal'),
      ]);
    }
  });
});

describe('the internal signer-keys route', () => {
  it('fails any other config that binds the mint Worker, at any entrypoint', () => {
    for (const binding of [
      mintBinding('uts', 'consumer'),
      { binding: 'UTS', service: 'uts-staging', entrypoint: 'SignerKeys' },
      mintBinding('uts-local', 'uts-feed-local'),
    ]) {
      expect(workerConfigProblems([consumer({ services: [binding] })])).toEqual([
        expect.stringContaining('only the feed Worker may'),
      ]);
    }
  });

  it('lets another config bind the feed Worker', () => {
    expect(
      workerConfigProblems([consumer({ services: [{ binding: 'FEED', service: 'uts-feed' }] })])
    ).toEqual([]);
  });

  it('fails a feed block whose caller is not its own deployed name', () => {
    const problems = workerConfigProblems(
      withFeed(raw => ({ ...raw, services: [mintBinding('uts', 'uts-feed-staging')] }))
    );
    expect(problems).toEqual([expect.stringContaining('sets props.caller "uts-feed-staging"')]);
  });

  it('fails a feed block that binds another environment of the mint Worker', () => {
    const problems = workerConfigProblems(
      withFeed(raw => ({ ...raw, services: [mintBinding('uts-staging', 'uts-feed')] }))
    );
    expect(problems).toEqual([expect.stringContaining('this block must bind uts')]);
  });

  it('fails a feed binding at a named entrypoint or through a preview', () => {
    const named = workerConfigProblems(
      withFeed(raw => ({
        ...raw,
        services: [{ ...mintBinding('uts', 'uts-feed'), entrypoint: 'SignerKeys' }],
      }))
    );
    expect(named).toEqual([expect.stringContaining('binds entrypoint SignerKeys')]);
    const preview = workerConfigProblems(
      withFeed(raw => ({ ...raw, previews: { services: [mintBinding('uts', 'uts-feed')] } }))
    );
    expect(preview).toEqual([expect.stringContaining('a preview runs unreviewed code')]);
  });
});

describe('UTS names and hostnames', () => {
  it('fail another config that deploys under a UTS name', () => {
    expect(workerConfigProblems([consumer({ name: 'uts-staging' })])).toEqual([
      expect.stringContaining('only the UTS configs deploy UTS names'),
    ]);
    expect(workerConfigProblems([consumer({ name: 'uts', env: {} })])).toHaveLength(1);
  });

  it('fail another config that routes a UTS hostname', () => {
    for (const pattern of ['uts.kiloapps.io', 'uts-feed-staging.kiloapps.io/*', '*.kiloapps.io']) {
      expect(
        workerConfigProblems([consumer({ routes: [{ pattern, zone_name: 'kiloapps.io' }] })]).length
      ).toBeGreaterThan(0);
    }
  });
});

describe('the UTS configs themselves', () => {
  const mintWith = (edit: (raw: Record<string, unknown>) => Record<string, unknown>) => {
    const configs = repoConfigs().filter(worker => worker.path !== MINT_CONFIG);
    return [
      ...configs,
      parseWorkerConfig(MINT_CONFIG, edit(structuredClone(configAt(MINT_CONFIG).config))),
    ];
  };

  it('fail traces enabled in any block', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({ ...raw, observability: { enabled: true, traces: { enabled: true } } }))
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.every(problem => problem.includes('traces.enabled resolves to true'))).toBe(
      true
    );
  });

  it('fail a deployed mint block without the eu jurisdiction or the Frankfurt placement', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({
        ...raw,
        vars: { UTS_ENVIRONMENT: 'production', DO_JURISDICTION: 'none' },
        placement: { mode: 'smart' },
      }))
    );
    expect(problems).toEqual([
      expect.stringContaining('(top level): DO_JURISDICTION must be eu'),
      expect.stringContaining('(top level): placement.region resolves to undefined'),
    ]);
  });

  it('fail a deployed mint block that runs the development entry', () => {
    const problems = utsConfigProblems(mintWith(raw => ({ ...raw, main: 'src/dev-index.ts' })));
    expect(problems).toEqual([
      expect.stringContaining('(top level): main resolves to src/dev-index.ts'),
      expect.stringContaining('(env.staging): main resolves to src/dev-index.ts'),
    ]);
  });

  it('fail a mint config whose deployments drift from the deployment list', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({ ...raw, vars: { UTS_ENVIRONMENT: 'staging', DO_JURISDICTION: 'eu' } }))
    );
    expect(problems).toEqual([
      expect.stringContaining('deploys uts-local=development, uts-staging=staging, uts=staging'),
    ]);
  });

  it('fail placement on the feed Worker', () => {
    const configs = repoConfigs().filter(worker => worker.path !== FEED_CONFIG);
    const feed = configAt(FEED_CONFIG);
    const placed = parseWorkerConfig(FEED_CONFIG, {
      ...feed.config,
      placement: { region: 'aws:eu-central-1' },
    });
    expect(utsConfigProblems([...configs, placed])).toHaveLength(3);
  });
});
