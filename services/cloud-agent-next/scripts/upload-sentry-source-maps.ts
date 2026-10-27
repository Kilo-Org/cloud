import { resolve } from 'node:path';
import {
  runSentryCli,
  sentryUploadConfigured,
  validateSentryArtifacts,
} from './sentry-source-maps.js';

if (sentryUploadConfigured({ SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN })) {
  for (const [source, shipped] of [
    ['wrapper/dist/sentry', 'wrapper/dist/runtime'],
    ...(process.argv.includes('--wrapper') ? [] : [['dist/worker', 'dist/worker']]),
  ]) {
    const directory = resolve(source);
    const artifacts = await validateSentryArtifacts(directory, resolve(shipped));
    for (const artifact of artifacts) {
      runSentryCli([
        'sourcemaps',
        'upload',
        '--org',
        'kilo-code',
        '--project',
        'kilo-cloud-agent',
        ...(artifact.release ? ['--release', artifact.release] : []),
        '--strict',
        '--validate',
        '--no-rewrite',
        '--wait-for',
        '120',
        resolve(directory, artifact.file),
        resolve(directory, `${artifact.file}.map`),
      ]);
    }
  }
}
