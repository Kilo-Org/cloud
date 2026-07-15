import { describe, expect, it } from 'vitest';

import { readSourceFile } from '../../../test-utils/read-source';

const source = readSourceFile('app/(app)/agent-chat/new/local.tsx');

describe('local session create route (renderer-free)', () => {
  it('imports only the screen from its canonical path', () => {
    expect(source).toMatch(
      /import\s*\{\s*LocalSessionConfigScreen\s*\}\s*from\s*['"]@\/components\/agents\/local-session-config-screen['"]/
    );
  });

  it('declares exactly one named default export and returns the screen verbatim', () => {
    expect(source).toMatch(/export\s+default\s+function\s+NewSessionLocalRoute\s*\(\s*\)\s*\{/);
    expect(source).toMatch(/return\s*<LocalSessionConfigScreen\s*\/>/);
  });

  it('contains no submission, recovery, or hook code (route stays thin)', () => {
    expect(source).not.toMatch(/useLocalSessionCreate/);
    expect(source).not.toMatch(/recovery/);
    expect(source).not.toMatch(/onSubmit|onRetry|onCheckAgain/);
  });

  it('is a small file (route must stay thin)', () => {
    expect(source.split('\n').length).toBeLessThan(20);
  });
});
