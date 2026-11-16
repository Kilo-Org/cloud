/**
 * Records every diagnostic the code-review library emits, so a test can assert
 * the record a failure produced.
 */
export const diagnostics: unknown[][] = [];

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: (...args: unknown[]) => {
    diagnostics.push(args);
  },
  warnExceptInTest: () => {},
  errorExceptInTest: () => {},
  sentryLogger: () => () => {},
}));
