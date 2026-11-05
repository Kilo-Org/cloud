import { resolve } from 'node:path';
import {
  runSentryCli,
  sentryUploadConfigured,
  validateSentryArtifacts,
} from './sentry-source-maps.js';

if (sentryUploadConfigured({ SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN })) {
  const directory = resolve('dist/worker');
  const artifacts = await validateSentryArtifacts(directory);
  for (const artifact of artifacts) {
    runSentryCli([
      'sourcemaps',
      'upload',
      '--org',
      'kilo-code',
      '--project',
      'kilo-cloud-agent',
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