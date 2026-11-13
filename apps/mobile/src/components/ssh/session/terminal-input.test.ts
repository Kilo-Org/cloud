import { describe, expect, it, vi } from 'vitest';

import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';

import { blurShell, startupCommandForShell } from './terminal-input';

describe('startupCommandForShell', () => {
  const command = "tmux new -A -s 'kilo'\n";

  it('waits for the native shell view to lay out, not merely its ref', () => {
    expect(startupCommandForShell('shell-1', null, command)).toBeNull();
    expect(startupCommandForShell('shell-1', 'shell-1', command)).toBe(command);
  });

  it('waits for a reconnected shell rather than trusting the old view', () => {
    expect(startupCommandForShell('shell-2', 'shell-1', command)).toBeNull();
    expect(startupCommandForShell('shell-2', 'shell-2', command)).toBe(command);
  });

  it('does not send after consumption, rehydration, or shell removal', () => {
    expect(startupCommandForShell('shell-1', 'shell-1', null)).toBeNull();
    expect(startupCommandForShell(null, null, command)).toBeNull();
    expect(startupCommandForShell(null, 'shell-1', command)).toBeNull();
  });
});

describe('blurShell', () => {
  it('blurs the native terminal that owns the keyboard', async () => {
    const blur = vi.fn().mockResolvedValue(undefined);
    await blurShell({ blur } as TerminalViewHandle);
    expect(blur).toHaveBeenCalledOnce();
  });

  it('tolerates a terminal that was removed during dismissal', async () => {
    const blur = vi.fn().mockRejectedValue(new Error('view removed'));
    await expect(blurShell(null)).resolves.toBeUndefined();
    await expect(blurShell({ blur } as TerminalViewHandle)).resolves.toBeUndefined();
  });
});
