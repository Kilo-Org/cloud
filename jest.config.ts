/* eslint-disable n/no-process-env */
import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
            decorators: true,
            //we're doing this to be bug-for-bug compatible with SWC, because that's what Vercel uses
            //And the whole point of testing is to be able to avoid bugs from hitting prod.
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
        },
      },
    ],
  },
  moduleNameMapper: {
    '^@/lib/integrations/platforms/github/adapter$':
      '<rootDir>/src/tests/setup/__mocks__/lib/integrations/platforms/github/adapter.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^server-only$': '<rootDir>/src/tests/setup/__mocks__/server-only.js',
  },
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: [
    '<rootDir>/cloud-agent/',
    '<rootDir>/cloud-agent-next/',
    '<rootDir>/cloudflare-webhook-agent-ingest/',
    '<rootDir>/cloudflare-session-ingest/',
  ],
  transformIgnorePatterns: [
    'node_modules/.pnpm/(?!(@octokit|universal-user-agent|before-after-hook|bottleneck))',
  ],

  // Parallel execution configuration
  maxWorkers: process.env.JEST_MAX_WORKERS ? process.env.JEST_MAX_WORKERS : '50%',

  globalSetup: '<rootDir>/src/tests/setup/globalSetup.ts',
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup/workerSetup.ts'],

  silent: process.env.JEST_SILENT === 'true',
};

export default config;
