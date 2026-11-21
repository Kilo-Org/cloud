/* eslint-disable eslint-plugin-import/no-nodejs-modules -- this test reads the trigger screens from disk, the only place the navigation contract is observable without rendering */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The trigger screens' post-create and post-delete hand-offs swap the top
 * native-stack screen in one commit, and a literal `router.replace` there
 * crashes Android Fabric with an addViewAt insertion error (Sentry
 * KILO-APP-25). Every other session-route call site routes that move through
 * `useStackSafeReplace`; these hand-offs must too. The contract lives in the
 * source text: the screen imports the hook, and no `router.replace(` call
 * remains. The hook's own mechanics are covered by its mounted suite in the
 * navigation folder.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const CREATE_SCREEN = readFileSync(
  join(HERE, '../../components/cloud-triggers/trigger-create-screen.tsx'),
  'utf8'
);
const EDIT_PANEL = readFileSync(
  join(HERE, '../../components/cloud-triggers/trigger-edit-panel.tsx'),
  'utf8'
);

describe('trigger screen navigation contract', () => {
  it('create screen routes its hand-off through useStackSafeReplace', () => {
    expect(CREATE_SCREEN).toContain('useStackSafeReplace()');
    expect(CREATE_SCREEN).toContain('router.replace(triggerDetailHref(');
    // The plain expo-router `useRouter` hook is what serves the crash-capable
    // literal replace; the screen must take the stack-safe one instead.
    expect(CREATE_SCREEN).not.toContain('useRouter()');
  });

  it('edit panel routes its post-delete hand-off through useStackSafeReplace', () => {
    expect(EDIT_PANEL).toContain('useStackSafeReplace()');
    expect(EDIT_PANEL).toContain('router.replace(triggersListHref(');
    expect(EDIT_PANEL).not.toContain('useRouter()');
  });
});
