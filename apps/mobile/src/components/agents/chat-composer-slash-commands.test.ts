import { describe, expect, it } from 'vitest';

import {
  getSlashCommandCandidate,
  getSlashCommandSuggestions,
  prepareChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';

const commands = [
  { name: 'compact', description: 'Compact context', hints: [] },
  { name: 'review', description: 'Review changes', hints: ['$ARGUMENTS'] },
  { name: 'rename', description: 'Rename a symbol', hints: ['$ARGUMENTS'] },
];

describe('getSlashCommandCandidate', () => {
  it('keeps input that can still match a command name', () => {
    expect(getSlashCommandCandidate('/')).toBe('/');
    expect(getSlashCommandCandidate('/re')).toBe('/re');
  });

  it('collapses prose and argument text to null', () => {
    expect(getSlashCommandCandidate('hello')).toBeNull();
    expect(getSlashCommandCandidate('/review main')).toBeNull();
    expect(getSlashCommandCandidate('')).toBeNull();
  });
});

describe('getSlashCommandSuggestions', () => {
  it('filters the current catalog by the command-name prefix', () => {
    expect(getSlashCommandSuggestions('/re', commands)).toEqual([commands[1], commands[2]]);
  });

  it('closes after command arguments begin or when input is not slash-prefixed', () => {
    expect(getSlashCommandSuggestions('/review main', commands)).toEqual([]);
    expect(getSlashCommandSuggestions('review', commands)).toEqual([]);
  });
});

describe('prepareChatComposerSubmission', () => {
  it('parses a recognized slash command and preserves its argument text', () => {
    expect(prepareChatComposerSubmission('  /review   main  branch  ', commands, false)).toEqual({
      type: 'command',
      command: 'review',
      arguments: 'main  branch',
    });
  });

  it('keeps unknown slash-prefixed input as a prompt', () => {
    expect(prepareChatComposerSubmission(' /unknown keep this ', commands, true)).toEqual({
      type: 'prompt',
      prompt: '/unknown keep this',
    });
  });

  it('rejects attachments only for recognized commands', () => {
    expect(prepareChatComposerSubmission('/compact', commands, true)).toEqual({
      type: 'attachment-error',
    });
    expect(prepareChatComposerSubmission('/not-a-command', commands, true)).toEqual({
      type: 'prompt',
      prompt: '/not-a-command',
    });
  });
});
