import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import { UTS_MINT_DEPLOYMENTS } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { experimental_readRawConfig } from 'wrangler';
import {
  FEED_CONFIG,
  FEED_MAX_LOG_SAMPLING_RATE,
  FEED_TEST_CONFIG,
  JOSE_UNHANDLED_REJECTION_DATE,
  JOSE_UNHANDLED_REJECTION_FLAG,
  MINT_CONFIG,
  MINT_DEV_CONFIG,
  MINT_TEST_CONFIG,
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

  it('deploy the mint Worker under exactly the names @kilocode/uts-contracts exports', () => {
    expect(UTS_MINT_DEPLOYMENTS).toEqual({
      production: 'uts',
      staging: 'uts-staging',
      development: 'uts-local',
    });
    const mint = z
      .object({ name: z.string(), env: z.object({ staging: z.object({ name: z.string() }) }) })
      .parse(configAt(MINT_CONFIG).config);
    const dev = z.object({ name: z.string() }).parse(configAt(MINT_DEV_CONFIG).config);
    expect([mint.name, mint.env.staging.name, dev.name]).toEqual([
      UTS_MINT_DEPLOYMENTS.production,
      UTS_MINT_DEPLOYMENTS.staging,
      UTS_MINT_DEPLOYMENTS.development,
    ]);
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

  it('lets Kilo MCP read the feed as kilo-mcp, and its dev deployment only as kilo-mcp-dev', () => {
    const kiloMcp = (devCaller: string) =>
      consumer(
        {
          name: 'kilo-mcp',
          services: [readerBinding('uts-feed', 'kilo-mcp')],
          env: {
            dev: {
              name: 'kilo-mcp-dev',
              services: [readerBinding('uts-feed', devCaller)],
            },
          },
        },
        'services/kilo-mcp/wrangler.jsonc'
      );
    expect(workerConfigProblems([kiloMcp('kilo-mcp-dev')])).toEqual([]);
    expect(workerConfigProblems([kiloMcp('kilo-mcp')])).toEqual([
      expect.stringContaining('sets props.caller "kilo-mcp"'),
    ]);
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
  const configWith = (
    path: string,
    edit: (raw: Record<string, unknown>) => Record<string, unknown>
  ) => [
    ...repoConfigs().filter(worker => worker.path !== path),
    parseWorkerConfig(path, edit(structuredClone(configAt(path).config))),
  ];
  const mintWith = (edit: (raw: Record<string, unknown>) => Record<string, unknown>) =>
    configWith(MINT_CONFIG, edit);

  it('fail traces enabled in any block', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({
        ...raw,
        observability: { enabled: true, traces: { enabled: true }, redact_query_string: true },
      }))
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.every(problem => problem.includes('traces.enabled resolves to true'))).toBe(
      true
    );
  });

  it('fail a mint block whose logs keep query strings, where a callback carries its code', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({
        ...raw,
        observability: { enabled: true, traces: { enabled: false } },
      }))
    );
    expect(problems).toEqual([
      `${MINT_CONFIG} (top level): observability.redact_query_string resolves to undefined; it must be true`,
      `${MINT_CONFIG} (env.staging): observability.redact_query_string resolves to undefined; it must be true`,
    ]);
    const staging = utsConfigProblems(
      mintWith(raw => {
        const env = z.record(z.string(), z.record(z.string(), z.unknown())).parse(raw.env);
        return {
          ...raw,
          env: {
            ...env,
            staging: {
              ...env.staging,
              observability: {
                enabled: true,
                traces: { enabled: false },
                redact_query_string: false,
              },
            },
          },
        };
      })
    );
    expect(staging).toEqual([
      `${MINT_CONFIG} (env.staging): observability.redact_query_string resolves to false; it must be true`,
    ]);
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
    expect(problems).toEqual([expect.stringContaining('deploys uts-staging=staging, uts=staging')]);
  });

  it('fail the development entry in any config but the development config', () => {
    const local = {
      name: 'uts-local',
      main: 'src/dev-index.ts',
      vars: { UTS_ENVIRONMENT: 'development', DO_JURISDICTION: 'none' },
    };
    const withLocal = mintWith(raw => ({
      ...raw,
      env: { staging: configAt(MINT_CONFIG).config.env?.staging, local },
    }));
    expect(workerConfigProblems(withLocal)).toEqual([
      expect.stringContaining(
        '(env.local) runs services/uts/src/dev-index.ts; only services/uts/wrangler.dev.jsonc may'
      ),
    ]);
    expect(utsConfigProblems(withLocal)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'deploys uts-local=development, uts-staging=staging, uts=production'
        ),
        expect.stringContaining('(env.local): main resolves to src/dev-index.ts'),
      ])
    );
    const other = consumer({ main: 'src/dev-index.ts' }, 'services/uts/wrangler.other.jsonc');
    expect(workerConfigProblems([other])).toEqual([
      expect.stringContaining('runs services/uts/src/dev-index.ts'),
    ]);
  });

  it('fail a development config that could deploy, route, or run another entry', () => {
    const devWith = (edit: (raw: Record<string, unknown>) => Record<string, unknown>) =>
      utsConfigProblems(configWith(MINT_DEV_CONFIG, edit));
    expect(devWith(({ build: _build, ...raw }) => raw)).toEqual([
      expect.stringContaining('build.command must be the command that fails'),
    ]);
    expect(devWith(raw => ({ ...raw, workers_dev: true }))).toEqual([
      expect.stringContaining('workers_dev must be false'),
    ]);
    expect(devWith(raw => ({ ...raw, routes: [{ pattern: 'dev.example.com/*' }] }))).toEqual([
      expect.stringContaining('the development config has no routes'),
    ]);
    expect(devWith(raw => ({ ...raw, main: 'src/index.ts' }))).toEqual([
      expect.stringContaining('main is src/index.ts; expected src/dev-index.ts'),
    ]);
    expect(
      devWith(raw => ({
        ...raw,
        env: { staging: { name: 'uts-staging', vars: { UTS_ENVIRONMENT: 'staging' } } },
      }))
    ).toEqual([expect.stringContaining('deploys uts-local=development, uts-staging=staging')]);
  });

  it('lets Wrangler bundle the deployed config, and refuse to deploy or upload the development config', () => {
    const outdir = mkdtempSync(join(tmpdir(), 'uts-dry-run-'));
    const wrangler = (args: string[]) =>
      spawnSync(join(repoRoot, 'services/uts/node_modules/.bin/wrangler'), args, {
        cwd: join(repoRoot, 'services/uts'),
        encoding: 'utf8',
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_COMMAND: '' },
      });
    try {
      const deployed = wrangler(['deploy', '--dry-run', '--outdir', outdir]);
      expect(deployed.status, deployed.stderr).toBe(0);
      for (const command of [['deploy'], ['versions', 'upload']]) {
        const refused = wrangler([
          ...command,
          '--dry-run',
          '-c',
          'wrangler.dev.jsonc',
          '--outdir',
          outdir,
        ]);
        expect(refused.status).not.toBe(0);
        expect(`${refused.stdout}${refused.stderr}`).toContain(
          'wrangler.dev.jsonc runs only under wrangler dev; deploy wrangler.jsonc'
        );
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fail a mint block that produces to any queue but its own UTS audit queue', () => {
    const problems = utsConfigProblems(
      mintWith(raw => ({
        ...raw,
        queues: { producers: [{ binding: 'AUDIT_QUEUE', queue: 'kilo-audit' }] },
      }))
    );
    expect(problems).toEqual([
      expect.stringContaining(
        '(top level): produces to AUDIT_QUEUE=kilo-audit; expected AUDIT_QUEUE=kilo-audit-uts'
      ),
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

  it('fail a UTS test config that deploys under any name but its own', () => {
    for (const [path, edit] of [
      [MINT_TEST_CONFIG, { name: 'uts' }],
      [FEED_TEST_CONFIG, { env: { staging: { name: 'uts-staging' } } }],
    ] as const) {
      const configs = repoConfigs().filter(worker => worker.path !== path);
      const renamed = parseWorkerConfig(path, { ...configAt(path).config, ...edit });
      expect(utsConfigProblems([...configs, renamed])).toEqual([
        expect.stringContaining(`${path} deploys`),
      ]);
    }
  });

  // jose's `verifyCompact` returns a promise it does not await, so a caught verification failure
  // reaches workerd as a briefly unhandled rejection; workerd stops reporting it from the
  // compatibility date that makes `unhandled_rejection_after_microtask_checkpoint` the default and
  // refuses an explicit listing there (panva/jose#892). The flag therefore goes with a date before
  // that one, so a config behaves the same before and after it.
  const withFlag = (raw: Record<string, unknown>, date: string) => ({
    ...raw,
    compatibility_date: date,
    compatibility_flags: [
      ...((raw.compatibility_flags ?? []) as string[]),
      JOSE_UNHANDLED_REJECTION_FLAG,
    ],
  });

  // The feed Worker verifies STS tokens with jose for its HTTPS feed (src/https-auth.ts), so its
  // configs follow the same rule.
  const JOSE_BLOCKS: ReadonlyMap<string, readonly string[]> = new Map([
    [MINT_CONFIG, ['(top level)', '(env.staging)']],
    [MINT_DEV_CONFIG, ['(top level)']],
    [MINT_TEST_CONFIG, ['(top level)']],
    [FEED_CONFIG, ['(top level)', '(env.staging)', '(env.local)']],
    [FEED_TEST_CONFIG, ['(top level)']],
  ]);

  it('fail a jose-verifying config that drops below the fix without listing the flag', () => {
    for (const [path, blocks] of JOSE_BLOCKS) {
      const problems = utsConfigProblems(
        configWith(path, raw => ({ ...raw, compatibility_date: '2025-06-01' }))
      );
      expect(problems.map(problem => problem.split(':')[0])).toEqual(
        blocks.map(block => `${path} ${block}`)
      );
      expect(
        problems.every(problem => problem.includes(`must list ${JOSE_UNHANDLED_REJECTION_FLAG}`))
      ).toBe(true);
    }
  });

  it('accept a jose-verifying config before the fix that lists the flag', () => {
    for (const path of JOSE_BLOCKS.keys()) {
      const problems = utsConfigProblems(configWith(path, raw => withFlag(raw, '2025-06-01')));
      expect(problems).toEqual([]);
    }
  });

  it('fail a jose-verifying config that lists the flag where workerd makes it the default', () => {
    for (const [path, blocks] of JOSE_BLOCKS) {
      const problems = utsConfigProblems(
        configWith(path, raw => withFlag(raw, JOSE_UNHANDLED_REJECTION_DATE))
      );
      expect(problems.map(problem => problem.split(':')[0])).toEqual(
        blocks.map(block => `${path} ${block}`)
      );
      expect(problems.every(problem => problem.includes('drop it'))).toBe(true);
    }
  });

  it('fail a jose-verifying config that leaves the compatibility date out', () => {
    for (const path of JOSE_BLOCKS.keys()) {
      const problems = utsConfigProblems(
        configWith(path, ({ compatibility_date: _date, ...raw }) => raw)
      );
      expect(problems.length).toBeGreaterThan(0);
      expect(
        problems.every(problem => problem.includes('compatibility_date resolves to undefined'))
      ).toBe(true);
    }
  });

  it('leave the HTTPS feed off in staging and production, and on only in the local block', () => {
    const feed = configAt(FEED_CONFIG).config;
    const varsOf = (vars: Record<string, unknown> | undefined) => ({
      enabled: vars?.FEED_HTTPS_ENABLED,
      sts: vars?.STS_URL,
    });
    expect(varsOf(feed.vars)).toEqual({ enabled: undefined, sts: undefined });
    expect(varsOf(feed.env?.staging?.vars)).toEqual({ enabled: undefined, sts: undefined });
    expect(varsOf(feed.env?.local?.vars)).toEqual({
      enabled: 'true',
      sts: STS_ISSUERS.development,
    });
  });

  it('fail a feed switch that is not exactly true, and an STS issuer of another environment', () => {
    const edited = (top: Record<string, unknown>, staging: Record<string, unknown>) =>
      configWith(FEED_CONFIG, raw => {
        const env = z.record(z.string(), z.record(z.string(), z.unknown())).parse(raw.env);
        const stagingVars = z.record(z.string(), z.unknown()).parse(env.staging?.vars);
        return {
          ...raw,
          vars: { ...z.record(z.string(), z.unknown()).parse(raw.vars), ...top },
          env: { ...env, staging: { ...env.staging, vars: { ...stagingVars, ...staging } } },
        };
      });
    expect(utsConfigProblems(edited({ FEED_HTTPS_ENABLED: 'yes' }, {}))).toEqual([
      expect.stringContaining(`${FEED_CONFIG} (top level): FEED_HTTPS_ENABLED`),
    ]);
    expect(
      utsConfigProblems(
        edited(
          { FEED_HTTPS_ENABLED: 'true', STS_URL: STS_ISSUERS.staging },
          { FEED_HTTPS_ENABLED: 'true', STS_URL: STS_ISSUERS.staging }
        )
      )
    ).toEqual([expect.stringContaining(`${FEED_CONFIG} (top level): STS_URL`)]);
    expect(
      utsConfigProblems(
        edited(
          { FEED_HTTPS_ENABLED: 'true', STS_URL: STS_ISSUERS.production },
          { STS_URL: 'http://localhost:8825' }
        )
      )
    ).toEqual([expect.stringContaining(`${FEED_CONFIG} (env.staging): STS_URL`)]);
  });

  it('keep the feed logs at a 5 percent head sample in every block, and fail a larger or missing one', () => {
    expect(configAt(FEED_CONFIG).config.observability?.logs?.head_sampling_rate).toBe(
      FEED_MAX_LOG_SAMPLING_RATE
    );
    const withObservability = (observability: Record<string, unknown>) =>
      configWith(FEED_CONFIG, raw => ({ ...raw, observability }));
    const blocks = ['(top level)', '(env.staging)', '(env.local)'];
    expect(
      utsConfigProblems(
        withObservability({ enabled: true, logs: { enabled: true }, traces: { enabled: false } })
      )
    ).toEqual(
      blocks.map(
        where =>
          `${FEED_CONFIG} ${where}: observability.logs.head_sampling_rate resolves to 1; the feed Worker keeps at most 0.05 of its invocation logs`
      )
    );
    expect(
      utsConfigProblems(
        withObservability({
          enabled: true,
          head_sampling_rate: 0.01,
          logs: { enabled: true, head_sampling_rate: 0.1 },
          traces: { enabled: false },
        })
      )
    ).toEqual(
      blocks.map(where =>
        expect.stringContaining(
          `${FEED_CONFIG} ${where}: observability.logs.head_sampling_rate resolves to 0.1`
        )
      )
    );
    expect(
      utsConfigProblems(
        withObservability({ enabled: true, head_sampling_rate: 0.01, traces: { enabled: false } })
      )
    ).toEqual([]);
  });
});
