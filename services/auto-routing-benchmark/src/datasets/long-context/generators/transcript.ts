import { seededRandom, type LongContextScenario, type Random } from './common';

export function transcriptScenario(seed: number, frontier = false): LongContextScenario {
  const random = seededRandom(seed);
  const project = `export-${1000 + random(9000)}`;
  const artifact = `${project}-reconciled.ndjson`;
  const base = 9 + random(12);
  const extra = 2 + random(7);
  const scale = frontier ? 2 + random(3) : 1;
  const divisor = frontier ? 2 : 1;
  const cap = 17 + random(19);
  const region = ['eu-central', 'us-west', 'ap-south'][random(3)];
  const partitionCount = frontier ? 5 : 3;
  let acceptedRows = 0;
  const partitions: string[] = [];

  for (let index = 0; index < partitionCount; index++) {
    const ready = 40 + random(61);
    const archivedReady = 2 + random(12);
    const retrySafe = 10 + random(31);
    const archivedRetrySafe = 1 + random(8);
    const unsafe = 4 + random(20);
    acceptedRows += ready - archivedReady + retrySafe - archivedRetrySafe;
    partitions.push(
      `TOOL CALL database.query {"project":"${project}","partition":${index},"snapshot":"final"}\nTOOL RESULT {"partition":${index},"counts":{"ready":${ready},"retry_safe":${retrySafe},"retry_unsafe":${unsafe},"blocked":${3 + random(14)}},"archivedSubsets":{"ready":${archivedReady},"retry_safe":${archivedRetrySafe}}}\nASSISTANT: Partition ${index} is recorded; archivedSubsets are included in the status counts, not extra rows.`
    );
  }

  const sections = [
    `USER: Prepare the ${project} export. Initial plan: write ${project}-draft.csv in us-east, batch size 10. Include archived records for now.\nASSISTANT: I will inspect the connector contract, project overrides and counts before implementing.\nTOOL CALL web.fetch {"url":"https://docs.example.invalid/connector/v1/export"}\nTOOL RESULT Connector v1 archived manual: accepted statuses are ready and retry_safe; CSV is supported; archived records may be included.`,
    `TOOL CALL read_file {"path":"projects/${project}/export.json"}\nTOOL RESULT {"baseBatch":${base},"artifact":"${project}-draft.csv","region":"us-east"}\nUSER: Correction: the release is NDJSON, not CSV. Name the final artifact ${artifact}. Resolve the deployment region through alias primary, and compute the batch from baseBatch plus extraBatch in connector overrides. The original hardcoded batch size is obsolete.`,
    ...partitions.slice(0, 1),
    `TOOL CALL read_file {"path":"connectors/${project}/overrides.json"}\nTOOL RESULT {"extraBatch":${extra},"aliases":{"primary":"secondary","legacy":"us-east"}}\nTOOL CALL web.fetch {"url":"https://docs.example.invalid/connector/v2/export"}\nTOOL RESULT Connector v2 supersedes v1 for NDJSON: only ready and retry_safe are accepted. retry_unsafe and blocked must never be exported. Archived records are forbidden even when their status is otherwise accepted. Each nonempty batch creates one page, and the last page may be partial.`,
    ...partitions.slice(1, -1),
    `USER: Keep the corrected filename. The v2 contract governs this release, so exclude archived rows; ignore my earlier archive instruction.\nTOOL CALL read_file {"path":"deployments/aliases.json"}\nTOOL RESULT {"secondary":"${frontier ? 'release-lane' : region}","old-primary":"us-east"}\nASSISTANT: The first archive instruction and v1 policy no longer apply.`,
    ...(frontier
      ? [
          `USER: Apply the release-lane multiplier to the configured base-plus-extra batch before dividing by the release divisor and flooring. Then cap the result by the resolved region's batch ceiling. Do not change the artifact name.\nTOOL CALL read_file {"path":"deployments/release-lane.json"}\nTOOL RESULT {"destinationAlias":"production","batchMultiplier":${scale},"batchDivisor":${divisor}}`,
          `TOOL CALL read_file {"path":"deployments/production.json"}\nTOOL RESULT {"regionAlias":"compliant"}\nUSER: A draft proposal suggested rolling back to us-east and CSV. That proposal was rejected; preserve the corrected output format and resolve the alias chain.`,
          `TOOL CALL read_file {"path":"deployments/compliant.json"}\nTOOL RESULT {"region":"${region}","batchCeiling":${cap},"archivedPolicy":"exclude"}`,
        ]
      : []),
    ...partitions.slice(-1),
    `ASSISTANT: All ${partitionCount} partitions are disjoint and their final snapshots are complete. No database writes have occurred.\nUSER: Produce the final implementation fixture from the corrected instructions and connector v2, not the discarded draft.`,
  ];
  const batchSize = frontier
    ? Math.min(cap, Math.floor(((base + extra) * scale) / divisor))
    : base + extra;

  return {
    sections,
    question: `Reconcile the evolving instructions, connector documentation, alias/config reads and all ${partitionCount} disjoint partition snapshots for ${project}. Return only a JSON object with keys "artifact", "region", "batchSize", "acceptedRows", "pages" in that order. pages is the number of nonempty output batches required by the final plan.`,
    answer: {
      artifact,
      region,
      batchSize,
      acceptedRows,
      pages: Math.ceil(acceptedRows / batchSize),
    },
  };
}

export function transcriptFiller(index: number, random: Random): string {
  const workerName = ['search-index', 'email-preview', 'cache-warmer', 'catalog-sync'][random(4)];
  const count = 20 + random(200);
  const elapsed = 10 + random(400);
  return `SESSION SIDE TASK ${index}: ${workerName} maintenance\nUSER: Inspect the ${workerName} worker's cancellation handling. Do not modify the export project.\nASSISTANT: Reading the worker and its test fixture before choosing a change.\nTOOL CALL read_file {"path":"workers/${workerName}/job-${index}.ts"}\nTOOL RESULT\nexport async function processBatch(items, signal) {\n  const completed = [];\n  for (const item of items) {\n    if (signal.aborted) break;\n    const value = await inspect(item);\n    if (value.active) completed.push(value.id);\n  }\n  return completed;\n}\nASSISTANT: The abort check occurs before every item. The ${workerName} fixture's expected count must use active records, not all input records.\nTOOL CALL terminal.run {"command":"node scripts/check-${workerName}.mjs --fixture fixture-${index}"}\nTOOL RESULT exit=0 {"inputRows":${count},"activeRows":${count - 3},"durationMs":${elapsed},"cancelled":false}\nUSER: For this maintenance task only, retain the existing API and add the cancellation case.\nASSISTANT: The maintenance result is isolated from the export requirements and deployment aliases.\nEND SIDE TASK ${index}\n`;
}
