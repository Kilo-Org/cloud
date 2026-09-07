import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import * as z from 'zod';
import { buildEnkryptCoverageReport, parseEnkryptScores } from '@/lib/model-stats/enkrypt-identity';
import { ENKRYPT_SCORE_EXAMPLES } from '@/tests/fixtures/enkrypt-scores';

const PUBLIC_CATALOG_URL = 'https://api.kilo.ai/api/gateway/models';
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const PublicCatalogSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

type CoverageInput = { evidence: 'examples' } | { evidence: 'fullinput'; path: string };

export function parseCoverageArguments(args: string[]): CoverageInput {
  if (args.length === 1 && args[0] === '--examples') {
    return { evidence: 'examples' };
  }
  if (
    args.length === 2 &&
    args[0] === '--input' &&
    args[1] &&
    !args[1].startsWith('-') &&
    extname(args[1]) === '.json'
  ) {
    return { evidence: 'fullinput', path: args[1] };
  }
  throw new Error('invalid_arguments');
}

async function readInput(path: string): Promise<unknown> {
  const stream = createReadStream(path, { end: MAX_JSON_BYTES });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BYTES) {
      throw new Error('input_size');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchPublicCatalog(): Promise<unknown> {
  const response = await fetch(PUBLIC_CATALOG_URL, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok || !response.body) {
    throw new Error('catalog_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('catalog_size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runEnkryptCoverage(
  args: string[],
  dependencies = { readInput, fetchPublicCatalog }
) {
  let category = 'arguments';
  let evidence: CoverageInput['evidence'] | undefined;
  try {
    const input = parseCoverageArguments(args);
    evidence = input.evidence;
    category = 'input_read_or_json';
    const value =
      input.evidence === 'examples'
        ? ENKRYPT_SCORE_EXAMPLES
        : await dependencies.readInput(input.path);
    category = 'response_validation';
    const parsed = parseEnkryptScores(value);
    category = 'catalog_fetch_or_json';
    const catalogValue = await dependencies.fetchPublicCatalog();
    category = 'catalog_validation';
    const catalog = PublicCatalogSchema.parse(catalogValue);
    const models = catalog.data.map(({ id }) => ({
      id,
      openrouterId: id,
      isActive: true,
      isStealth: false,
    }));
    category = 'report_construction';
    const report = buildEnkryptCoverageReport(parsed, models, evidence);
    return {
      output: { catalogUrl: PUBLIC_CATALOG_URL, ...report },
      exitCode: report.requiredGate.passed ? 0 : 1,
    };
  } catch {
    return {
      output: {
        error: { category },
        evidence: evidence ?? 'unspecified',
        ...(category === 'arguments' ? { usage: '--examples OR --input <sanitized.json>' } : {}),
      },
      exitCode: 1,
    };
  }
}

async function main() {
  const { output, exitCode } = await runEnkryptCoverage(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = exitCode;
}

if (require.main === module) {
  void main();
}
