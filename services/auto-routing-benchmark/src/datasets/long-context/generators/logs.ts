import { seededRandom, type LongContextScenario, type Random } from './common';

export function logsScenario(seed: number, frontier = false): LongContextScenario {
  const random = seededRandom(seed);
  const deployment = `release-${100 + random(900)}`;
  const requestId = `req-${10000 + random(90000)}`;
  const seconds = 3 + random(7);
  const extraSeconds = frontier ? 1 + random(4) : 0;
  const ceiling = frontier ? 4000 + random(4) * 1000 : 30000;
  const attempts = frontier ? 5 : 3;
  const backoffBase = 30 + random(41);
  const backoffCap = 180 + random(81);
  const timeoutMs = Math.min((seconds + extraSeconds) * 1000, ceiling);
  const actualTimeoutMs = Math.min(seconds + extraSeconds, ceiling);
  let elapsedMs = 0;
  const spans: string[] = [];

  for (let index = 0; index < attempts; index++) {
    const durationMs = actualTimeoutMs + 1 + random(4);
    elapsedMs += durationMs;
    const jitterMs = random(13);
    const backoffMs = Math.min(backoffCap, backoffBase * 2 ** index);
    if (index < attempts - 1) elapsedMs += backoffMs + jitterMs;
    spans.push(`LOG {"deployment":"${deployment}","requestId":"${requestId}","attempt":${index + 1},"event":"transport.timeout","durationMs":${durationMs},"configuredDeadlineMs":${actualTimeoutMs}}\n${index < attempts - 1 ? `LOG {"requestId":"${requestId}","attempt":${index + 1},"event":"retry.schedule","jitterMs":${jitterMs},"backoffPolicy":"capped-exponential"}` : `LOG {"requestId":"${requestId}","attempt":${index + 1},"event":"retry.exhausted"}`}`);
  }

  const sections = [
    `CONFIG deploy/active.json\n{"activeDeployment":"${deployment}","probeRequestId":"${requestId}","profile":"production"}\nEND CONFIG\nLOG {"deployment":"${deployment}-canary","requestId":"${requestId}-old","attempt":1,"event":"transport.success","durationMs":18}`,
    `CONFIG config/defaults.json\n{"timeoutSeconds":30,"maxAttempts":2,"backoffBaseMs":10,"backoffCapMs":500,"profile":"development"}\nEND CONFIG\nCONFIG config/profiles/production.json\n{"timeoutSeconds":${seconds + 5},"maxAttempts":${attempts},"backoffBaseMs":${backoffBase},"backoffCapMs":${backoffCap}}\nEND CONFIG`,
    ...spans.slice(0, 1),
    `DOCUMENT vendor/transport-v2.md\nTransport v2 requires deadlines in milliseconds. App configuration timeoutSeconds is measured in seconds and must be converted once at the transport boundary. maxAttempts includes the initial attempt. Retry delay after attempt n (one-based) is min(backoffCapMs, backoffBaseMs * 2^(n-1)) plus the recorded jitterMs. End-to-end elapsed time for this synchronous probe is the sum of attempt durationMs and scheduled retry delays. There is no unlogged queue time.\nEND DOCUMENT`,
    `CONFIG deploy/${deployment}.json\n{"profile":"production","timeoutSeconds":${seconds},"transportPolicy":"${frontier ? 'regional' : 'standard'}"}\nEND CONFIG\nFILE src/config/load.ts\nexport function load(defaults, profiles, deployment) {\n  return { ...defaults, ...profiles[deployment.profile], ...deployment };\n}\nEND FILE`,
    ...spans.slice(1, -1),
    ...(frontier ? [
      `CONFIG config/policies/regional.json\n{"regionAlias":"primary","timeoutAdjustmentKey":"release"}\nEND CONFIG\nCONFIG config/timeout-adjustments.json\n{"release":{"extraSeconds":${extraSeconds}},"preview":{"extraSeconds":20}}\nEND CONFIG`,
      `CONFIG config/regions/aliases.json\n{"primary":"compliant","legacy":"unrestricted"}\nEND CONFIG\nCONFIG config/regions/compliant.json\n{"ceilingMs":${ceiling},"transportAlias":"vendor-v2"}\nEND CONFIG`,
      `FILE src/http/policy.ts\nexport function resolvePolicy(config, policies, adjustments, aliases, regions) {\n  const policy = policies[config.transportPolicy];\n  const region = regions[aliases[policy.regionAlias]];\n  return { seconds: config.timeoutSeconds + adjustments[policy.timeoutAdjustmentKey].extraSeconds, ceilingMs: region.ceilingMs, transportAlias: region.transportAlias };\n}\nEND FILE`,
    ] : [
      `CONFIG config/policies/standard.json\n{"extraSeconds":0,"ceilingMs":${ceiling},"transportAlias":"vendor-v2"}\nEND CONFIG`,
    ]),
    `FILE src/http/config.ts\nexport function transportConfig(policy) {\n  return { deadlineMs: Math.min(Number(policy.seconds), policy.ceilingMs) };\n}\nEND FILE\nLOG {"deployment":"${deployment}","requestId":"${requestId}","event":"transport.selected","adapter":"vendor-v2","remoteExpectedLatencyMs":800}\nDOCUMENT operations/probe.md\nFor standard policy, seconds is the merged timeoutSeconds plus extraSeconds. For regional policy, use resolvePolicy. The ceiling is applied in milliseconds after conversion. The remote service is healthy; its expected 800ms latency is below all correctly converted deadlines in this fixture.\nEND DOCUMENT`,
    ...spans.slice(-1),
  ];

  return {
    sections,
    question: 'Analyze the active deployment\'s probe, using configuration precedence, policy resolution, transport v2 documentation and only the probeRequestId\'s logs. Return only a JSON object with keys "deployment", "timeoutMs", "attempts", "elapsedMs", "rootCause" in that order. timeoutMs is the deadline required by the documented units and policy (not the broken deadline); attempts is the number of attempts actually made; elapsedMs includes all actual attempt durations and retry delays. rootCause must be the exact string "src/http/config.ts:seconds-used-as-milliseconds" if that conversion is missing, otherwise "none".',
    answer: {
      deployment,
      timeoutMs,
      attempts,
      elapsedMs,
      rootCause: 'src/http/config.ts:seconds-used-as-milliseconds',
    },
  };
}

export function logsFiller(index: number, random: Random): string {
  const service = ['inventory', 'assets', 'analytics', 'webhooks', 'scheduler'][random(5)];
  const request = `background-${index}-${random(10000)}`;
  const duration = 10 + random(600);
  return `CONFIG services/${service}/shards/${index}.json\n{"service":"${service}","shard":${index},"workerCount":${2 + random(14)},"queueLimit":${100 + random(900)},"retentionHours":${24 + random(144)},"healthPath":"/ready","featureFlags":{"compactPayloads":true,"replay":false}}\nEND CONFIG\nLOG {"service":"${service}","requestId":"${request}","event":"queue.dequeue","queueDepth":${random(100)},"priority":"normal"}\nLOG {"service":"${service}","requestId":"${request}","event":"cache.lookup","key":"${service}:${index}","hit":${random(2) === 0},"durationMs":${random(8)}}\nLOG {"service":"${service}","requestId":"${request}","event":"http.complete","status":200,"durationMs":${duration},"bytes":${1000 + random(9000)}}\nLOG {"service":"${service}","requestId":"${request}","event":"queue.ack","attempt":1,"success":true}\nMETRIC {"service":"${service}","shard":${index},"cpuPercent":${random(70)},"memoryMiB":${30 + random(900)},"activeJobs":${random(20)}}\n`;
}
