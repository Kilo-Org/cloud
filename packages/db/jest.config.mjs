/**
 * The database-backed suites in this package — `schema.test.ts` and the
 * commit-switch repository test — connect to `POSTGRES_URL` and need a migrated
 * database to run against. The `workspace-tests` matrix that runs this package's
 * `test` script provides no database, so `test` covers the suites that need
 * none, including the migration-journal guard (which reads generated files
 * only) and the spend-alert schema guard.
 *
 * To run the database-backed suites, point `POSTGRES_URL` at a migrated database
 * and run `jest --testPathIgnorePatterns /node_modules/`.
 */
const databaseBackedSuites = [
  '<rootDir>/src/schema.test.ts',
  '<rootDir>/src/kiloclaw-commit-switch-qualification-repository.test.ts',
];

/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
          },
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', ...databaseBackedSuites],
};
