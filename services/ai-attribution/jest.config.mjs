/** @type {import('jest').Config} */
// TypeScript 7 is the native compiler and ships no compiler JS API. @swc/jest
// transpiles the tests without one; `tsgo --noEmit` remains the type check.
export default {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['/node_modules/(?!.*(?:jose|workers-tagged-logger))'],
  transform: {
    '^.+\\.[tj]s$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
            allowJs: true,
          },
          target: 'es2022',
        },
      },
    ],
  },
};
