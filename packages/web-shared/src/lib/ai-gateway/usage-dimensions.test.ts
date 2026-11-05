import { describe, expect, test } from '@jest/globals';
import {
  EDITOR_NAME_VALUES,
  MODE_VALUES,
  OTHER_EDITOR_NAME,
  OTHER_MODE,
  normalizeEditorName,
  normalizeMode,
  normalizeSystemPromptPrefix,
} from '@kilocode/web-shared/lib/ai-gateway/usage-dimensions';

describe('normalizeEditorName', () => {
  test.each([
    ['Visual Studio Code 1.114.0', 'vscode'],
    ['Visual Studio Code', 'vscode'],
    ['Visual Studio Code - Insiders 1.114.0', 'vscode-insiders'],
    ['vscode', 'vscode'],
    ['Cursor 0.48.7', 'cursor'],
    ['Windsurf 1.10.6', 'windsurf'],
    ['Trae AI', 'trae'],
    ['Kilo CLI 5.2.1', 'kilo-cli'],
    ['IntelliJ IDEA 2024.1.4 IC-241.14494.240', 'intellij-idea'],
    ['IntelliJ IDEA', 'intellij-idea'],
    ['PyCharm 2024.1.4 PY-241.18034.62', 'pycharm'],
    ['WebStorm 2023.3.4 WS-233.14475.37', 'webstorm'],
    ['GoLand 2024.1', 'goland'],
    ['Rider 2024.1', 'rider'],
    ['CLion 2024.1', 'clion'],
    ['PhpStorm 2024.1', 'phpstorm'],
    ['RubyMine 2024.1', 'rubymine'],
    ['DataGrip 2024.1', 'datagrip'],
    ['DataSpell 2024.1', 'dataspell'],
    ['AppCode 2024.1', 'appcode'],
    ['RustRover 2024.1', 'rustrover'],
    ['jetbrains', 'jetbrains'],
  ])('maps %j to %j', (value, expected) => {
    expect(normalizeEditorName(value)).toBe(expected);
  });

  test.each([
    ['Android Studio Ladybug | 2024.2.1 AI-242.23339.11.2421.12700392'],
    ['Neovim'],
    ['some-random-editor-9f8a7b6c'],
    ['x'.repeat(500) + ' 1.0.0'],
  ])('maps the unknown editor %j to the other bucket', value => {
    expect(normalizeEditorName(value)).toBe(OTHER_EDITOR_NAME);
  });

  test('returns null for missing and blank values', () => {
    expect(normalizeEditorName(null)).toBeNull();
    expect(normalizeEditorName('')).toBeNull();
    expect(normalizeEditorName('   ')).toBeNull();
  });

  test('ignores case and surrounding whitespace', () => {
    expect(normalizeEditorName('  VISUAL STUDIO CODE 1.114.0 ')).toBe('vscode');
  });

  test('every mapped value is a declared editor family or the other bucket', () => {
    const declared = new Set<string>([...EDITOR_NAME_VALUES, OTHER_EDITOR_NAME]);
    for (const value of ['Visual Studio Code 1.1.0', 'Cursor 0.1', 'Neovim', 'Kilo CLI 1.0']) {
      expect(declared).toContain(normalizeEditorName(value));
    }
  });
});

describe('normalizeMode', () => {
  test.each([
    ['build', 'build'],
    ['plan', 'plan'],
    ['code', 'code'],
    ['architect', 'architect'],
    ['general', 'general'],
    ['explore', 'explore'],
    ['BUILD', 'build'],
    ['  Plan  ', 'plan'],
  ])('maps %j to %j', (value, expected) => {
    expect(normalizeMode(value)).toBe(expected);
  });

  test.each([['my-custom-agent'], ['agent-9f8a7b6c'], ["' OR 1=1 --"]])(
    'maps the unknown mode %j to the other bucket',
    value => {
      expect(normalizeMode(value)).toBe(OTHER_MODE);
    }
  );

  test('returns null for missing and blank values', () => {
    expect(normalizeMode(null)).toBeNull();
    expect(normalizeMode('')).toBeNull();
    expect(normalizeMode('   ')).toBeNull();
  });

  test('every built-in mode maps to itself', () => {
    for (const mode of MODE_VALUES) {
      expect(normalizeMode(mode)).toBe(mode);
    }
  });
});

describe('normalizeSystemPromptPrefix', () => {
  test('maps the same prompt text to the same key', () => {
    const prompt = 'You are Kilo Code, a knowledgeable technical assistant.';
    expect(normalizeSystemPromptPrefix(prompt)).toBe(normalizeSystemPromptPrefix(prompt));
  });

  test('maps different prompt text to different keys', () => {
    expect(normalizeSystemPromptPrefix('You are a helpful assistant')).not.toBe(
      normalizeSystemPromptPrefix('You are an unhelpful assistant')
    );
  });

  test('returns a fixed-size key', () => {
    const key = normalizeSystemPromptPrefix('You are Kilo Code, a helpful assistant.');
    expect(key).toMatch(/^sp-[0-9a-f]{4}$/);
    expect(key).not.toContain('Kilo');
  });

  test('keeps the same key size for long prompts', () => {
    const longKey = normalizeSystemPromptPrefix('a'.repeat(100));
    expect(longKey).toHaveLength(7);
    expect(longKey).toMatch(/^sp-[0-9a-f]{4}$/);
  });

  test('keys stay within the declared bucket count', () => {
    const keys = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      const key = normalizeSystemPromptPrefix(`prompt-${index}-${Math.random()}`);
      expect(key).toMatch(/^sp-[0-9a-f]{4}$/);
      if (key) keys.add(key);
    }
    // 4 hex characters: at most 65536 distinct keys, whatever the input.
    expect(keys.size).toBeLessThanOrEqual(65536);
  });

  test('returns null for missing and blank values', () => {
    expect(normalizeSystemPromptPrefix(null)).toBeNull();
    expect(normalizeSystemPromptPrefix('')).toBeNull();
    expect(normalizeSystemPromptPrefix('   ')).toBeNull();
  });
});
