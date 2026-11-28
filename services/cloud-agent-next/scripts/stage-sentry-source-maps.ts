import { resolve } from 'node:path';
import { sentryCliBinary, stageSentryUploads } from './sentry-source-maps.js';

// Usage: tsx scripts/stage-sentry-source-maps.ts <output directory>
const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('Usage: stage-sentry-source-maps.ts <output directory>');
await stageSentryUploads(resolve('.'), resolve(outDir), sentryCliBinary());
