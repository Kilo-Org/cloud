import { seededRandom, type LongContextScenario, type Random } from './common';

export function repoScenario(seed: number, frontier = false): LongContextScenario {
  const random = seededRandom(seed);
  const tenant = `tenant-${100 + random(900)}`;
  const version = 2 + random(7);
  const root = `src/pipelines/v${version}`;
  const input = 20 + random(41);
  const hops = frontier ? 6 : 3;
  const faultyHop = random(hops);
  const modulus = frontier ? 10007 : 997;
  const offset = 11 + random(31);
  let actual = input;
  let corrected = input;
  const stages: string[] = [];

  for (let index = 0; index < hops; index++) {
    const multiplier = 2 + random(3);
    const adjustment = 3 + random(19);
    actual = actual * multiplier + (index === faultyHop ? -adjustment : adjustment);
    corrected = corrected * multiplier + adjustment;
    const dependency =
      index === 0 ? '' : `import { stage${index - 1} } from './stage-${index - 1}';\n`;
    const argument = index === 0 ? 'input' : `stage${index - 1}(input)`;
    stages.push(
      `FILE ${root}/stage-${index}.ts\n${dependency}export function stage${index}(input: number): number {\n  return ${argument} * ${multiplier} ${index === faultyHop ? '-' : '+'} ${adjustment};\n}\nEND FILE`
    );
  }

  const sections = [
    `FILE src/cli.ts\nimport { route } from './router';\nexport const invocation = { tenant: '${tenant}', units: ${input}, channel: 'stable' };\nexport const result = route(invocation);\nEND FILE`,
    `FILE docs/ledger-transform.md\nThe ledger transform contract applies to stable pipelines: each stage first multiplies the previous stage's value, then ADDS its configured positive adjustment. The only permitted subtraction is the final settlement offset. Generated legacy pipelines are not selected for stable traffic.\nEND FILE`,
    ...stages.filter((_, index) => index % 2 === 1).reverse(),
    `FILE src/router.ts\nimport { settle } from './settlement';\nimport { stage${hops - 1} as active } from './pipelines/v${version}/stage-${hops - 1}';\nimport { legacy } from './pipelines/legacy';\nconst tenants = { '${tenant}': active };\nexport function route(request: { tenant: keyof typeof tenants; units: number; channel: string }) {\n  const pipeline = request.channel === 'stable' ? tenants[request.tenant] : legacy;\n  return settle(pipeline(request.units));\n}\nEND FILE`,
    `FILE src/pipelines/legacy.ts\nexport function legacy(input: number) { return input * 9 - 40; }\nEND FILE\nFILE src/settlement.ts\nimport { settlementConfig } from './settings/settlement';\nexport function settle(value: number) {\n  return (value % settlementConfig.modulus) - settlementConfig.offset;\n}\nEND FILE`,
    ...stages.filter((_, index) => index % 2 === 0),
    `FILE src/settings/settlement.ts\nexport const settlementConfig = { modulus: ${modulus}, offset: ${offset} };\nEND FILE`,
  ];

  return {
    sections,
    question:
      'Trace the invocation in src/cli.ts through the selected pipeline and settlement. Compare its current output with the ledger-transform contract. Return only a JSON object with keys "entrypoint", "actual", "corrected", "faultyFile" in that order. entrypoint is the invocation file; actual is its current numeric result; corrected is its numeric result after repairing the one contract-violating stage; faultyFile is the full path of that stage.',
    answer: {
      entrypoint: 'src/cli.ts',
      actual: (actual % modulus) - offset,
      corrected: (corrected % modulus) - offset,
      faultyFile: `${root}/stage-${faultyHop}.ts`,
    },
  };
}

export function repoFiller(index: number, random: Random): string {
  const area = ['catalog', 'search', 'inventory', 'notifications', 'analytics'][random(5)];
  const ttl = 30 + random(300);
  const batch = 5 + random(45);
  const prefix = `${area}-${index}`;
  return `FILE src/modules/${area}/worker-${index}.ts\nimport { createHash } from 'node:crypto';\ntype RecordRow = { id: string; updatedAt: number; enabled: boolean; tags: string[] };\nconst config = { ttlSeconds: ${ttl}, batchSize: ${batch}, namespace: '${prefix}' };\nexport function selectRows(rows: readonly RecordRow[], now: number): RecordRow[] {\n  return rows.filter(row => row.enabled && now - row.updatedAt < config.ttlSeconds * 1000)\n    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, config.batchSize);\n}\nexport function cacheKey(row: RecordRow): string {\n  return config.namespace + ':' + createHash('sha256').update(row.id).digest('hex');\n}\nexport async function publish(rows: readonly RecordRow[], send: (key: string, tags: string[]) => Promise<void>) {\n  for (const row of rows) await send(cacheKey(row), row.tags.filter(tag => tag.length > 0));\n}\nEND FILE\nFILE tests/${area}/worker-${index}.test.ts\nimport { selectRows } from '../../src/modules/${area}/worker-${index}';\nconst now = ${100000 + random(100000)};\nconst rows = [{ id: '${prefix}', updatedAt: now - 1000, enabled: true, tags: ['active'] }];\nexpect(selectRows(rows, now).map(row => row.id)).toEqual(['${prefix}']);\nexpect(selectRows(rows, now + ${ttl + 1}000)).toEqual([]);\nEND FILE\n`;
}
