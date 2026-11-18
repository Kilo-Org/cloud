import packageJson from '../package.json';
import { isDefaultSessionTitle } from './index';

// Every value re-exported from the package entry point must be backed by a
// `dependencies` entry: `devDependencies` disappear from production installs
// (`pnpm install --prod`, `pnpm deploy`, bundled builds), which leaves the
// runtime import unresolvable for consumers. Type-only re-exports are erased
// at build time and may stay in `devDependencies`.
describe('index runtime re-exports', () => {
  it('backs isDefaultSessionTitle with a production dependency', () => {
    expect(typeof isDefaultSessionTitle).toBe('function');
    expect(packageJson.dependencies).toHaveProperty('@kilocode/session-ingest-contracts');
    expect(packageJson.devDependencies).not.toHaveProperty('@kilocode/session-ingest-contracts');
  });
});
