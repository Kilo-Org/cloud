import { describe, expect, it } from '@jest/globals';
import { stripAnsi } from '@/lib/stripAnsi';

describe('stripAnsi', () => {
  it('removes ANSI escape sequences while preserving text', () => {
    expect(stripAnsi('\x1b[32mcompleted\x1b[0m\nnext line')).toBe('completed\nnext line');
  });

  it('returns unchanged text when no ANSI sequences are present', () => {
    expect(stripAnsi('plain output')).toBe('plain output');
  });
});
