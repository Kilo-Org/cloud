/* eslint-disable typescript-eslint/consistent-type-definitions, vitest/no-conditional-expect, vitest/no-conditional-in-test -- AGENTS.md prefers type over interface, and the assertions walk each declared command */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import extensionConfig from '../../../wxt.config';

/*
 * Chrome refuses to load an extension whose command has no `description`, and
 * then no service worker ever starts: every E2E waits for a worker that never
 * arrives. This guards the generated manifest against that regression.
 */
const commandSchema = z.object({
  description: z.string().min(1),
  suggested_key: z.object({ default: z.string() }).optional(),
});

const manifestSchema = z.object({
  commands: z.record(z.string(), commandSchema).optional(),
  optional_permissions: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});

const manifestFunctionSchema = z.custom<(...args: unknown[]) => unknown>(
  value => typeof value === 'function'
);

const readManifest = (browser: 'chrome' | 'firefox') => {
  const manifestFunction = manifestFunctionSchema.parse(extensionConfig.manifest);

  return manifestSchema.parse(manifestFunction({ browser }));
};

const SHORTCUT_PATTERN =
  /^(Ctrl|Alt|Command|MacCtrl)(\+(Shift|Alt|Ctrl|Command|MacCtrl))*\+[A-Z0-9]$/u;

describe('extension manifest', () => {
  it('gives every command a description and a valid shortcut', () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const manifest = readManifest(browser);
      const commands = Object.values(manifest.commands ?? {});

      expect(commands.length).toBeGreaterThan(0);
      expect(commands.length).toBeLessThanOrEqual(4);

      for (const command of commands) {
        expect(command.description.length).toBeGreaterThan(0);

        if (command.suggested_key !== undefined) {
          expect(command.suggested_key.default).toMatch(SHORTCUT_PATTERN);
        }
      }
    }
  });

  it('declares the permissions the local agent transport needs', () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const manifest = readManifest(browser);

      expect(manifest.permissions).toContain('alarms');
      expect(manifest.optional_permissions).toContain('nativeMessaging');
    }
  });
});
