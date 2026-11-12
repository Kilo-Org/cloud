import { describe, expect, test } from 'vitest';
import {
  instructionNameForPath,
  instructionNameSchema,
  MAX_IMPORT_INSTRUCTION_NAME_LENGTH,
  slugifyInstructionName,
} from './instructions';

function isValidName(name: string): boolean {
  return instructionNameSchema.safeParse(name).success;
}

describe('slugifyInstructionName', () => {
  test('keeps the plain slug for an ASCII path', () => {
    expect(slugifyInstructionName('agents')).toBe('agents');
    expect(slugifyInstructionName('team/style')).toBe('team-style');
    expect(slugifyInstructionName('AGENTS.MD')).toBe('agents');
    expect(slugifyInstructionName('my_notes')).toBe('my-notes');
  });

  test('derives a stable non-empty name for a filename with no ASCII letters', () => {
    const name = slugifyInstructionName('使用说明');
    expect(name).toMatch(/^instruction-[0-9a-f]{8}$/);
    expect(slugifyInstructionName('使用说明.md')).toBe(name);
    expect(slugifyInstructionName('使用说明')).toBe(name);
    expect(isValidName(name)).toBe(true);
  });

  test('folds an accent to ASCII and keeps the name distinct from its ASCII fold', () => {
    const accented = slugifyInstructionName('café-notes');
    expect(accented.slice(0, -9)).toBe('cafe-notes');
    expect(accented).not.toBe(slugifyInstructionName('caf-notes'));
    expect(accented).not.toBe(slugifyInstructionName('cafe-notes'));
    expect(slugifyInstructionName('café-notes.MD')).toBe(accented);
    expect(isValidName(accented)).toBe(true);
  });

  test('derives a distinct valid name for every distinct lossy path', () => {
    const paths = [
      '使用说明',
      '使用指南',
      'Ω-notes',
      '团队/风格',
      '!!!',
      'a\u0301',
      'café-notes',
      'café-note',
    ];
    const names = paths.map(path => slugifyInstructionName(path));
    expect(new Set(names).size).toBe(paths.length);
    for (const name of names) expect(isValidName(name)).toBe(true);
  });

  test('truncates an over-long path to the name budget and keeps long siblings apart', () => {
    const long = 'a'.repeat(160);
    const name = slugifyInstructionName(long);
    expect(name).toHaveLength(MAX_IMPORT_INSTRUCTION_NAME_LENGTH);
    expect(name.slice(0, 91)).toBe('a'.repeat(91));
    expect(name).not.toBe(slugifyInstructionName(`${long}b`));
    expect(isValidName(name)).toBe(true);
  });
});

describe('instructionNameForPath', () => {
  test('drops the instructions directory prefix so both archive routes agree', () => {
    expect(instructionNameForPath('instructions/使用说明.md')).toBe(
      slugifyInstructionName('使用说明')
    );
    expect(instructionNameForPath('instructions/team/style.md')).toBe('team-style');
  });
});
