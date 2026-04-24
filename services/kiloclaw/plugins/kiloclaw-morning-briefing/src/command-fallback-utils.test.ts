import { describe, expect, it } from 'vitest';
import { extractBriefingArgsFromText } from './command-fallback-utils';

describe('command-fallback-utils', () => {
  it('extracts subcommand args from a plain slash command', () => {
    expect(extractBriefingArgsFromText('/briefing enable')).toBe('enable');
  });

  it('extracts args from control-ui wrapped inbound metadata text', () => {
    const wrapped = [
      'Sender (untrusted metadata):',
      '```json',
      '{"label":"openclaw-control-ui"}',
      '```',
      '',
      '[Thu 2026-04-23 19:49 CDT] /briefing yesterday',
    ].join('\n');

    expect(extractBriefingArgsFromText(wrapped)).toBe('yesterday');
  });

  it('returns empty args for bare /briefing', () => {
    expect(extractBriefingArgsFromText('/briefing')).toBe('');
  });

  it('returns null when no briefing command exists', () => {
    expect(extractBriefingArgsFromText('hello there')).toBeNull();
  });
});
