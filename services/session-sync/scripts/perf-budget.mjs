import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const quantity = z.number().finite().nonnegative();
const stage = z.strictObject({
  name: z.string(),
  registrations: quantity,
  streamingSources: quantity,
  sourceTrafficMode: z.literal('all-streaming-sources'),
  watched: quantity,
  viewerConnections: quantity,
  sdkViewers: quantity,
  eventHz: quantity,
  seeds: quantity,
  checkpoints: quantity,
  finalCheckpoints: quantity,
  receiptRetries: quantity,
  reconciliationReads: quantity,
  ticketRequests: quantity,
  exchanges: quantity,
  socketUpgrades: quantity,
  incomingWebSocketMessages: quantity,
  workerCPUms: quantity,
  sqlRowsRead: quantity,
  sqlRowsWritten: quantity,
  expectedActiveActorSeconds: quantity,
  pessimisticActiveActorSeconds: quantity,
  r2ClassA: quantity,
  r2ClassB: quantity,
  logpushEvents: quantity,
  analyticsPoints: quantity,
});
const schema = z.strictObject({
  version: z.literal(1),
  stages: z.array(stage).min(1),
  vmInstances: z.number().int().positive(),
  vmHourlyUSD: quantity,
  vmHoursEach: quantity,
  qualificationVMUSD: quantity,
  vmDiskAndEgressUSD: quantity,
  r2StorageUSD: quantity,
  sqlStorageUSD: quantity,
  analyticsUSD: quantity,
  downstreamLogsUSD: quantity,
  delayedBillingReserveUSD: quantity.min(10),
  alreadySpentUSD: quantity,
  hardLimitUSD: z.number().finite().min(50).max(100).default(50),
  workerStoredLogsEnabled: z.literal(false),
  absoluteResourceDeadlineSeconds: z.number().positive().max(900),
});
const rounded = (quantity, unit, rate) => (quantity ? Math.ceil(quantity / unit) * rate : 0);
export function forecast(input) {
  const plan = schema.parse(input);
  const total = key => plan.stages.reduce((sum, row) => sum + row[key], 0);
  const httpRequests = [
    'registrations',
    'seeds',
    'checkpoints',
    'finalCheckpoints',
    'receiptRetries',
    'reconciliationReads',
    'ticketRequests',
    'exchanges',
    'socketUpgrades',
  ].reduce((sum, field) => sum + total(field), 0);
  const doRequestUnits = httpRequests * 3 + total('incomingWebSocketMessages') / 20;
  const fixed = {
    workerRequests: (httpRequests / 1e6) * 0.3,
    workerCPU: (total('workerCPUms') / 1e6) * 0.02,
    doRequests: rounded(doRequestUnits, 1e6, 0.15),
    sqlReads: (total('sqlRowsRead') / 1e6) * 0.001,
    sqlWrites: total('sqlRowsWritten') / 1e6,
    r2ClassA: rounded(total('r2ClassA'), 1e6, 4.5),
    r2ClassB: rounded(total('r2ClassB'), 1e6, 0.36),
    r2Storage: plan.r2StorageUSD,
    sqlStorage: plan.sqlStorageUSD,
    logpush: (total('logpushEvents') / 1e6) * 0.05,
    analytics: plan.analyticsUSD,
    downstreamLogs: plan.downstreamLogsUSD,
  };
  const base = Object.values(fixed).reduce((sum, value) => sum + value, 0);
  const expectedGBs = total('expectedActiveActorSeconds') * 0.128;
  const pessimisticGBs = total('pessimisticActiveActorSeconds') * 0.128;
  assert(pessimisticGBs >= expectedGBs);
  const durationExpectedUSD = rounded(expectedGBs, 1e6, 12.5);
  const durationPessimisticUSD = rounded(pessimisticGBs, 1e6, 12.5);
  const vmUSD =
    plan.vmInstances * plan.vmHourlyUSD * plan.vmHoursEach +
    plan.qualificationVMUSD +
    plan.vmDiskAndEgressUSD;
  const expectedCFUSD = base + durationExpectedUSD;
  const pessimisticCFUSD = base + durationPessimisticUSD;
  const committedCeilingUSD =
    pessimisticCFUSD + vmUSD + plan.alreadySpentUSD + plan.delayedBillingReserveUSD;
  const cloudflareTargetUSD =
    plan.hardLimitUSD - plan.alreadySpentUSD - plan.delayedBillingReserveUSD - 5;
  return {
    version: 1,
    grossNoIncludedAllowances: true,
    invoiceGuarantee: false,
    httpRequests,
    doRequestUnits,
    fixed,
    expectedGBs,
    pessimisticGBs,
    durationExpectedUSD,
    durationPessimisticUSD,
    expectedCFUSD,
    pessimisticCFUSD,
    vmUSD,
    alreadySpentUSD: plan.alreadySpentUSD,
    reserveUSD: plan.delayedBillingReserveUSD,
    committedCeilingUSD,
    hardLimitUSD: plan.hardLimitUSD,
    targets: {
      cloudflareUSD: cloudflareTargetUSD,
      vmUSD: 5,
      delayedReserveUSD: plan.delayedBillingReserveUSD,
    },
    passed:
      committedCeilingUSD <= plan.hardLimitUSD &&
      pessimisticCFUSD <= cloudflareTargetUSD &&
      vmUSD <= 5,
    absoluteResourceDeadlineSeconds: plan.absoluteResourceDeadlineSeconds,
    workloadBounds: plan.stages.map(row => ({
      name: row.name,
      sessions: row.registrations,
      streamingSources: row.streamingSources,
      sourceTrafficMode: row.sourceTrafficMode,
      watched: row.watched,
      viewerConnections: row.viewerConnections,
      sdkViewers: row.sdkViewers,
      eventHz: row.eventHz,
      checkpoints: row.checkpoints,
      finalCheckpoints: row.finalCheckpoints,
      incomingWebSocketMessages: row.incomingWebSocketMessages,
      ticketRequests: row.ticketRequests,
    })),
    assumptions: [
      'DO duration rounds upward to one-million GB-s billing units; no idle-residency charge is assumed for hibernation-eligible actors.',
      'Pessimistic activity inputs must be supported by measured phase maxima plus hard lifetime bounds; expected duty is not a spend guard.',
      'DO request model reserves three RPC/request units per HTTP request plus incoming WebSockets at 20:1; verify RPC fanout against the integrated source.',
      'R2 A/B units are rounded conservatively, including log delivery. AE and downstream ingestion are explicit reserves.',
      'All startup, seed, retries, final reconciliation, alarms, teardown tails, generator VM lifetime, storage and egress belong to this new allocation.',
      'Delayed analytics cannot enforce an exact invoice ceiling. Parent GO also requires request quotas and independent absolute teardown.',
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = forecast(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
