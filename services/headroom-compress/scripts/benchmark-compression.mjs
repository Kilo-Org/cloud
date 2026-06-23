#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'https://headroom.kiloapps.io';
const DEFAULT_MODEL = 'kilo/anthropic/claude-sonnet-4.6';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(scriptDir, '..');

const builtInCases = {
  logs: {
    description: 'Repeated application logs with error traces and JSON context.',
    messages: [
      {
        role: 'user',
        content: buildLogPayload(),
      },
    ],
    config: { compress_user_messages: true, protect_recent: 0, target_ratio: 0.35 },
  },
  json: {
    description: 'Large repetitive JSON API payload.',
    messages: [
      {
        role: 'user',
        content: JSON.stringify(buildJsonPayload(), null, 2),
      },
    ],
    config: { compress_user_messages: true, protect_recent: 0, target_ratio: 0.35 },
  },
  prose: {
    description: 'Long redundant prose notes.',
    messages: [
      {
        role: 'user',
        content: buildProsePayload(),
      },
    ],
    config: { compress_user_messages: true, protect_recent: 0, target_ratio: 0.4 },
  },
};

async function main() {
  loadLocalDevVars();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }
  if (args.listCases) {
    printCases();
    return;
  }

  const benchmarkCase = loadBenchmarkCase(args);
  const url = trimTrailingSlash(args.url ?? process.env.HEADROOM_COMPRESS_URL ?? DEFAULT_URL);
  const token = args.token ?? process.env.HEADROOM_BEARER_TOKEN;
  if (!token) {
    throw new Error('Missing bearer token. Set HEADROOM_BEARER_TOKEN or create .dev.vars.');
  }

  const model = args.model ?? benchmarkCase.model ?? DEFAULT_MODEL;
  const repeat = args.repeat ?? 1;
  const minSavedTokens = args.minSavedTokens ?? 1;
  const minSavingsRatio = args.minSavingsRatio ?? 0.01;
  const requestBody = {
    model,
    messages: benchmarkCase.messages,
    config: benchmarkCase.config ?? { compress_user_messages: true, protect_recent: 0 },
    ...(benchmarkCase.token_budget ? { token_budget: benchmarkCase.token_budget } : {}),
  };

  const results = [];
  for (let index = 0; index < repeat; index += 1) {
    results.push(await runOnce({ url, token, body: requestBody, index }));
  }

  const summary = summarizeResults(results, {
    url,
    model,
    caseName: benchmarkCase.name,
    minSavedTokens,
    minSavingsRatio,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  if (args.output) {
    writeFileSync(resolve(args.output), JSON.stringify(summary, null, 2) + '\n');
  }

  if (!summary.passed) {
    process.exitCode = 1;
  }
}

function loadBenchmarkCase(args) {
  if (args.fixture) {
    const fixturePath = resolve(args.fixture);
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const fixture = Array.isArray(parsed) ? { messages: parsed } : parsed;
    if (!Array.isArray(fixture.messages)) {
      throw new Error('Fixture must be a messages array or an object with messages array.');
    }
    return {
      name: args.caseName ?? fixturePath,
      description: 'Custom fixture',
      ...fixture,
    };
  }

  const caseName = args.caseName ?? 'logs';
  const selected = builtInCases[caseName];
  if (!selected) {
    throw new Error(`Unknown case "${caseName}". Use --list-cases.`);
  }
  return { name: caseName, ...selected };
}

async function runOnce({ url, token, body, index }) {
  const startedAt = performance.now();
  const response = await fetch(`${url}/v1/compress`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-request-id': `headroom-benchmark-${Date.now()}-${index}`,
    },
    body: JSON.stringify(body),
  });
  const durationMs = performance.now() - startedAt;
  const text = await response.text();
  const parsed = parseJsonBody(text);

  if (!response.ok) {
    throw new Error(`Compression request failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const tokensBefore = numberField(parsed, 'tokens_before');
  const tokensAfter = numberField(parsed, 'tokens_after');
  const tokensSaved = numberField(parsed, 'tokens_saved');
  const savingsRatio = tokensBefore > 0 ? tokensSaved / tokensBefore : 0;
  const originalBytes = Buffer.byteLength(JSON.stringify(body.messages));
  const compressedBytes = Buffer.byteLength(JSON.stringify(parsed.messages ?? []));

  return {
    index,
    status: response.status,
    durationMs: Math.round(durationMs),
    requestId: response.headers.get('x-request-id'),
    tokensBefore,
    tokensAfter,
    tokensSaved,
    compressionRatio: numberField(parsed, 'compression_ratio'),
    savingsRatio,
    originalBytes,
    compressedBytes,
    byteSavingsRatio: originalBytes > 0 ? (originalBytes - compressedBytes) / originalBytes : 0,
    transformsApplied: Array.isArray(parsed.transforms_applied) ? parsed.transforms_applied : [],
    transformsSummary: parsed.transforms_summary ?? {},
    ccrHashCount: Array.isArray(parsed.ccr_hashes) ? parsed.ccr_hashes.length : 0,
  };
}

function summarizeResults(results, config) {
  const totals = results.reduce(
    (acc, result) => {
      acc.durationMs += result.durationMs;
      acc.tokensBefore += result.tokensBefore;
      acc.tokensAfter += result.tokensAfter;
      acc.tokensSaved += result.tokensSaved;
      acc.originalBytes += result.originalBytes;
      acc.compressedBytes += result.compressedBytes;
      return acc;
    },
    {
      durationMs: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      originalBytes: 0,
      compressedBytes: 0,
    }
  );
  const average = {
    durationMs: Math.round(totals.durationMs / results.length),
    tokensBefore: Math.round(totals.tokensBefore / results.length),
    tokensAfter: Math.round(totals.tokensAfter / results.length),
    tokensSaved: Math.round(totals.tokensSaved / results.length),
    savingsRatio: totals.tokensBefore > 0 ? totals.tokensSaved / totals.tokensBefore : 0,
    byteSavingsRatio:
      totals.originalBytes > 0
        ? (totals.originalBytes - totals.compressedBytes) / totals.originalBytes
        : 0,
  };
  const passed =
    results.every(result => result.tokensSaved >= config.minSavedTokens) &&
    results.every(result => result.savingsRatio >= config.minSavingsRatio);

  return {
    passed,
    url: config.url,
    model: config.model,
    caseName: config.caseName,
    thresholds: {
      minSavedTokens: config.minSavedTokens,
      minSavingsRatio: config.minSavingsRatio,
    },
    average,
    totals,
    results,
  };
}

function printSummary(summary) {
  console.log(`Headroom compression benchmark`);
  console.log(`url: ${summary.url}`);
  console.log(`model: ${summary.model}`);
  console.log(`case: ${summary.caseName}`);
  console.log(`passed: ${summary.passed ? 'yes' : 'no'}`);
  console.log('');
  console.log(
    [
      'run',
      'status',
      'ms',
      'tokens_before',
      'tokens_after',
      'tokens_saved',
      'savings',
      'byte_savings',
      'transforms',
    ].join('\t')
  );
  for (const result of summary.results) {
    console.log(
      [
        result.index + 1,
        result.status,
        result.durationMs,
        result.tokensBefore,
        result.tokensAfter,
        result.tokensSaved,
        formatPercent(result.savingsRatio),
        formatPercent(result.byteSavingsRatio),
        result.transformsApplied.join(',') || 'none',
      ].join('\t')
    );
  }
  console.log('');
  console.log(
    `avg: ${summary.average.durationMs}ms, saved ${summary.average.tokensSaved}/${summary.average.tokensBefore} tokens (${formatPercent(
      summary.average.savingsRatio
    )})`
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--list-cases':
        args.listCases = true;
        break;
      case '--url':
        args.url = requireValue(argv, ++index, arg);
        break;
      case '--token':
        args.token = requireValue(argv, ++index, arg);
        break;
      case '--model':
        args.model = requireValue(argv, ++index, arg);
        break;
      case '--case':
        args.caseName = requireValue(argv, ++index, arg);
        break;
      case '--fixture':
        args.fixture = requireValue(argv, ++index, arg);
        break;
      case '--repeat':
        args.repeat = positiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case '--min-saved-tokens':
        args.minSavedTokens = nonNegativeNumber(requireValue(argv, ++index, arg), arg);
        break;
      case '--min-savings-ratio':
        args.minSavingsRatio = nonNegativeNumber(requireValue(argv, ++index, arg), arg);
        break;
      case '--json':
        args.json = true;
        break;
      case '--output':
        args.output = requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: pnpm run benchmark:compression -- [options]

Options:
  --url <url>                  Worker URL. Default: ${DEFAULT_URL}
  --model <model>              Model id. Default: ${DEFAULT_MODEL}
  --case <name>                Built-in case. Default: logs
  --fixture <path>             JSON messages array or { messages, config, token_budget }
  --repeat <n>                 Number of runs. Default: 1
  --min-saved-tokens <n>       Per-run minimum saved tokens. Default: 1
  --min-savings-ratio <n>      Per-run minimum saved/token_before ratio. Default: 0.01
  --json                       Print JSON report
  --output <path>              Write JSON report
  --list-cases                 List built-in cases
`);
}

function printCases() {
  for (const [name, value] of Object.entries(builtInCases)) {
    console.log(`${name}\t${value.description}`);
  }
}

function loadLocalDevVars() {
  if (process.env.HEADROOM_BEARER_TOKEN) return;
  const devVarsPath = resolve(serviceDir, '.dev.vars');
  if (!existsSync(devVarsPath)) return;

  const lines = readFileSync(devVarsPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = unquote(value);
    }
  }
}

function buildLogPayload() {
  const lines = [];
  for (let index = 0; index < 160; index += 1) {
    const requestId = `req-${String(index % 12).padStart(3, '0')}`;
    const tenant = `tenant-${index % 5}`;
    const endpoint = ['/api/search', '/api/export', '/api/sync'][index % 3];
    const level = index % 13 === 0 ? 'ERROR' : index % 7 === 0 ? 'WARN' : 'INFO';
    lines.push(
      [
        `2026-06-23T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
        level,
        `request_id=${requestId}`,
        `tenant=${tenant}`,
        `endpoint=${endpoint}`,
        `duration_ms=${180 + (index % 40)}`,
        'cache=miss',
        'region=iad',
        'message="retrieved 25 documents and normalized ranking features"',
      ].join(' ')
    );
    if (level === 'ERROR') {
      lines.push(
        `Traceback: Error: upstream timeout while fetching shard ${index % 4}`,
        '  at fetchShard (/app/search.ts:42:11)',
        '  at rankDocuments (/app/rank.ts:88:7)',
        `context=${JSON.stringify({ requestId, tenant, endpoint, retryable: true })}`
      );
    }
  }
  return lines.join('\n');
}

function buildJsonPayload() {
  return {
    query: 'benchmark compression regression fixture',
    generated_at: '2026-06-23T09:00:00.000Z',
    results: Array.from({ length: 120 }, (_, index) => ({
      id: `doc_${String(index).padStart(4, '0')}`,
      source: ['docs', 'tickets', 'logs'][index % 3],
      title: `Repeated benchmark result ${index % 10}`,
      score: Number((0.91 - (index % 20) * 0.01).toFixed(3)),
      tags: ['compression', 'benchmark', `bucket-${index % 8}`],
      summary:
        'This record repeats enough structure and wording for Headroom to remove redundancy while preserving ranking signals.',
      metadata: {
        tenant: `tenant-${index % 5}`,
        shard: index % 6,
        permissions: ['read', 'export'],
        pii: false,
      },
    })),
  };
}

function buildProsePayload() {
  const paragraph =
    'The benchmark corpus describes the same incident repeatedly with minor wording changes. The important facts are request id, tenant, endpoint, latency, retry state, and final outcome. Compression should preserve those facts while removing redundant framing sentences.';
  return Array.from({ length: 90 }, (_, index) => {
    return `Note ${index + 1}: ${paragraph} Tenant tenant-${index % 5} saw endpoint ${
      ['/api/search', '/api/export', '/api/sync'][index % 3]
    } complete with retry state ${index % 4 === 0 ? 'retryable' : 'not_retryable'}.`;
  }).join('\n\n');
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 500)}`);
  }
}

function numberField(value, field) {
  const fieldValue = value?.[field];
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
    throw new Error(`Response missing numeric ${field}.`);
  }
  return fieldValue;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeNumber(value, flag) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number.`);
  }
  return parsed;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
