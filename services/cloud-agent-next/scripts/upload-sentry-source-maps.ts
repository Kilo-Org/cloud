import { resolve } from 'node:path';
import {
  runSentryCli,
  sentryUploadConfigured,
  validateSentryArtifacts,
} from './sentry-source-maps.js';

if (
  sentryUploadConfigured({
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
  })
) {
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
