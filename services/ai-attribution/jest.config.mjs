/** @type {import('jest').Config} */
// ts-jest compiles through the TypeScript compiler API, which typescript@7 no
// longer ships. @swc/jest transpiles the tests without it; `tsgo --noEmit`
// remains the type check.
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
