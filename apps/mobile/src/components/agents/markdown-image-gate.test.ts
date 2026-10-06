import { type TFunction } from 'i18next';
import { marked } from 'marked';
import { describe, expect, it, vi } from 'vitest';

import { findMarkdownImages, gateMarkdownImages } from './markdown-image-gate';

// The trusted-image-host store reaches SecureStore, Sentry and the toast
// bridge on import; this suite only rewrites markdown.
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const t = ((key: string) => key) as unknown as TFunction;
const IMAGE = '![a](https://evil.example/x.png)';

function gate(value: string): string {
  return gateMarkdownImages(value, findMarkdownImages(value), t);
}

describe('gateMarkdownImages', () => {
  it('rewrites an image and leaves no fetchable copy', () => {
    const gated = gate(`before ${IMAGE} after`);
    expect(gated).not.toContain(IMAGE);
    expect(gated).toContain('kilo-image-load:');
  });

  it('leaves a copy inside a fenced code block alone', () => {
    const gated = gate(`${IMAGE}\n\n\`\`\`\n${IMAGE}\n\`\`\``);
    expect(gated.startsWith('[')).toBe(true);
    expect(gated).toContain(`\`\`\`\n${IMAGE}\n\`\`\``);
  });

  it('rewrites the real image when a fake fence hides it and a literal copy stands outside', () => {
    // `marked` rejects a backtick fence whose info string holds a backtick, so
    // the middle line is a real image and the closing ``` opens a code block.
    const value = `\`\`\`foo\`bar\n${IMAGE}\n\`\`\`\n\\${IMAGE}`;
    expect(findMarkdownImages(value)).toHaveLength(1);
    expect(findMarkdownImages(gate(value))).toEqual([]);
  });

  it('leaves an escaped copy alone and rewrites the real one', () => {
    const gated = gate(`\\${IMAGE} and ${IMAGE}`);
    expect(gated.startsWith(`\\${IMAGE} and [`)).toBe(true);
  });

  it('rewrites every copy without lexing per copy once the probe budget is spent', () => {
    const lexer = vi.spyOn(marked, 'lexer');
    const value = `${Array.from({ length: 50 }, () => IMAGE).join('\n\n')}\n\n\\${IMAGE}`;
    const images = findMarkdownImages(value);
    lexer.mockClear();
    const gated = gateMarkdownImages(value, images, t);
    expect(lexer).not.toHaveBeenCalled();
    expect(gated).not.toContain(IMAGE);
    lexer.mockRestore();
  });
});
