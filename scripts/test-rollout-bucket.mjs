#!/usr/bin/env node
/**
 * Probe the kiloclaw rollout bucketing end-to-end.
 *
 * Reads KILOCLAW_API_URL + KILOCLAW_INTERNAL_API_SECRET from .env.local,
 * finds a synthetic instanceId that falls below the candidate's percent,
 * and hits GET /versions/latest twice — once with that in-cohort UUID and
 * once with a random (likely out-of-cohort) UUID. Prints both responses.
 *
 * Usage:
 *   CANDIDATE_TAG=dev-1775864188 PERCENT=20 node scripts/test-rollout-bucket.mjs
 *
 * Defaults pick a sensible CANDIDATE_TAG and PERCENT if not provided.
 */
import { readFileSync } from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
import { resolve } from 'node:path';

const CANDIDATE_TAG = process.env.CANDIDATE_TAG ?? 'dev-1775864188';
const PERCENT = Number.parseInt(process.env.PERCENT ?? '20', 10);

function loadEnvFromFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const envPath = resolve(process.cwd(), '.env.local');
const env = { ...loadEnvFromFile(envPath), ...process.env };
const baseUrl = env.KILOCLAW_API_URL ?? 'http://localhost:8795';
const secret = env.KILOCLAW_INTERNAL_API_SECRET;
if (!secret) {
  console.error('KILOCLAW_INTERNAL_API_SECRET not found in .env.local or env');
  process.exit(1);
}

async function bucketFor(imageTag, instanceId) {
  const data = new TextEncoder().encode(`${imageTag}:instance:${instanceId}`);
  const hash = await webcrypto.subtle.digest('SHA-256', data);
  return new DataView(hash).getUint32(0) % 100;
}

async function probe(instanceId) {
  const url = `${baseUrl}/api/platform/versions/latest?instanceId=${instanceId}&currentImageTag=dev-old`;
  const res = await fetch(url, { headers: { 'x-internal-api-key': secret } });
  if (!res.ok) return `ERROR ${res.status}: ${await res.text()}`;
  const body = await res.json();
  return body.imageTag;
}

async function findInCohort(maxAttempts = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    const id = randomUUID();
    const b = await bucketFor(CANDIDATE_TAG, id);
    if (b < PERCENT) return { id, bucket: b };
  }
  return null;
}

const inMatch = await findInCohort();
if (!inMatch) {
  console.error(`Failed to find an IN-cohort UUID in 500 tries (percent=${PERCENT})`);
  process.exit(1);
}
const outId = randomUUID();
const outBucket = await bucketFor(CANDIDATE_TAG, outId);

console.log('');
console.log(`Candidate tag : ${CANDIDATE_TAG}`);
console.log(`Percent       : ${PERCENT}%`);
console.log('');
console.log(`IN-cohort     : ${inMatch.id}  (bucket=${inMatch.bucket})`);
console.log(
  `Random       : ${outId}  (bucket=${outBucket}, ${outBucket < PERCENT ? 'IN' : 'OUT'})`
);
console.log('');
console.log(`IN probe  → ${await probe(inMatch.id)}`);
console.log(`Random probe → ${await probe(outId)}`);
