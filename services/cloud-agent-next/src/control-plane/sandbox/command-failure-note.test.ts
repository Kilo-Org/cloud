import { describe, expect, it } from 'vitest';
import { commandFailureNote, promptWithCommandFailureNote } from './command-failure-note.js';

const note = commandFailureNote([
  { kind: 'start', index: 1, commandText: 'serve', exitCode: 1, elapsedMs: 5 },
]);
const prompt = (context?: string) => ({
  messageId: 'm1',
  turn: { type: 'prompt' as const, prompt: 'hello' },
  agent: { mode: 'code', model: 'test/model' },
  ...(context === undefined ? {} : { context }),
});

describe('promptWithCommandFailureNote', () => {
  it('puts the note before the existing context', () => {
    expect(promptWithCommandFailureNote(prompt('server context'), note)?.context).toBe(
      `${note}\n\nserver context`
    );
  });

  it('reports no room instead of dropping the note', () => {
    expect(promptWithCommandFailureNote(prompt('x'.repeat(1_990)), note)).toBeNull();
  });
});
