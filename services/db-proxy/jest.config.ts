import type { Config } from 'jest';

// ts-jest compiles through the TypeScript compiler API, which typescript@7 no
// longer ships. @swc/jest transpiles the tests without it; `tsgo --noEmit`
// remains the type check.
const config: Config = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleFileExtensions: ['ts', 'js'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
          },
          target: 'es2022',
        },
        module: {
          type: 'es6',
        },
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(agents)/)'],
};

export default config;
