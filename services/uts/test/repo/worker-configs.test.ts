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
  entrypoint: 'SignerKeys',
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
  it('fail a config outside the mint Worker that names the signer, key-set shard or feed class', () => {
    for (const className of ['UtsSignerDO', 'UtsKeySetDO', 'UtsFeedDO']) {
      const problems = workerConfigProblems([
        consumer({ durable_objects: { bindings: [{ name: 'OBJECTS', class_name: className }] } }),
      ]);
      expect(problems).toEqual([
        expect.stringContaining(`names UTS Durable Object class ${className}`),
      ]);
    }
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

describe('the SignerKeys and FeedReads entrypoints', () => {
  it('fails any other config that binds the mint Worker, at any entrypoint', () => {
    for (const binding of [
      mintBinding('uts', 'consumer'),
      { binding: 'UTS', service: 'uts-staging' },
      mintBinding('uts-local', 'uts-feed-local'),
      { ...mintBinding('uts', 'consumer'), entrypoint: 'FeedReads' },
    ]) {
      expect(workerConfigProblems([consumer({ services: [binding] })])).toEqual([
        expect.stringContaining('only the feed Worker may'),
      ]);
    }
  });

  it('fails a feed config that does not bind SignerKeys and FeedReads once each', () => {
    const configs = repoConfigs().filter(worker => worker.path !== FEED_CONFIG);
    const feed = configAt(FEED_CONFIG);
    const signerKeysOnly = parseWorkerConfig(FEED_CONFIG, {
      ...feed.config,
      services: [mintBinding('uts', 'uts-feed')],
    });
    expect(utsConfigProblems([...configs, signerKeysOnly])).toEqual([
      expect.stringContaining('(top level): binds the mint Worker at SignerKeys; expected'),
    ]);
  });
});

describe('the FeedReader entrypoint', () => {
  const readerBinding = (service: string, caller: unknown) => ({
    binding: 'UTS_FEED',
    service,
    entrypoint: 'FeedReader',
    props: { caller },
  });

  it('lets another config bind the feed Worker at FeedReader under its own name', () => {
    expect(
      workerConfigProblems([consumer({ services: [readerBinding('uts-feed', 'consumer')] })])
    ).toEqual([]);
    expect(
      workerConfigProblems([
        consumer({
          env: {
            staging: {
              name: 'consumer-staging',
              services: [readerBinding('uts-feed-staging', 'consumer-staging')],
            },
          },
        }),
      ])
    ).toEqual([]);
  });

  it('fails a reader that poses as another caller, carries no props, or binds the default entrypoint', () => {
    const problemsOf = (binding: Record<string, unknown>) =>
      workerConfigProblems([consumer({ services: [binding] })]);
    expect(problemsOf(readerBinding('uts-feed', 'o11y'))).toEqual([
      expect.stringContaining('sets props.caller "o11y"'),
    ]);
    const { props: _props, ...propless } = readerBinding('uts-feed', 'consumer');
    expect(problemsOf(propless)).toEqual([expect.stringContaining('sets props.caller undefined')]);
    const { entrypoint: _entrypoint, ...atDefault } = readerBinding('uts-feed', 'consumer');
    expect(problemsOf(atDefault)).toEqual([
      expect.stringContaining('binds entrypoint (default); bind FeedReader'),
    ]);
    expect(problemsOf(readerBinding('uts-feed-canary', 'consumer'))).toEqual([
      expect.stringContaining('not a feed Worker deployment'),
    ]);
  });

  it('fails a reader in a preview and the mint Worker reading the feed this way', () => {
    expect(
      workerConfigProblems([
        consumer({ previews: { services: [readerBinding('uts-feed', 'consumer')] } }),
      ])
    ).toEqual([expect.stringContaining('a preview runs unreviewed code')]);
    const mint = configAt(MINT_CONFIG);
    const reading = parseWorkerConfig(MINT_CONFIG, {
      ...mint.config,
      services: [readerBinding('uts-feed', 'uts')],
    });
    expect(workerConfigProblems([reading])).toEqual([
      expect.stringContaining('binds the feed Worker; a UTS Worker does not'),
    ]);
  });
});

describe('feed Worker bindings of the mint Worker', () => {
  it('fails a feed block whose caller is not its own deployed name, or that carries no props', () => {
    const problems = workerConfigProblems(
      withFeed(raw => ({ ...raw, services: [mintBinding('uts', 'uts-feed-staging')] }))
    );
    expect(problems).toEqual([expect.stringContaining('sets props.caller "uts-feed-staging"')]);
    const { props: _props, ...withoutProps } = mintBinding('uts', 'uts-feed');
    const propless = workerConfigProblems(withFeed(raw => ({ ...raw, services: [withoutProps] })));
    expect(propless).toEqual([expect.stringContaining('sets props.caller undefined')]);
  });

  it('fails a feed block that binds another environment of the mint Worker', () => {
    const problems = workerConfigProblems(
      withFeed(raw => ({ ...raw, services: [mintBinding('uts-staging', 'uts-feed')] }))
    );
    expect(problems).toEqual([expect.stringContaining('this block must bind uts')]);
  });

  it('fails a feed binding at the default or another entrypoint, or through a preview', () => {
    const { entrypoint: _entrypoint, ...atDefault } = mintBinding('uts', 'uts-feed');
    for (const [binding, entrypoint] of [
      [atDefault, '(default)'],
      [{ ...atDefault, entrypoint: 'Admin' }, 'Admin'],
    ] as const) {
      const problems = workerConfigProblems(withFeed(raw => ({ ...raw, services: [binding] })));
      expect(problems).toEqual([expect.stringContaining(`binds entrypoint ${entrypoint}`)]);
    }
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
