import { describe, expect, it } from 'vitest';

import {
  chatFlagValueOf,
  flagApplication,
  flagPersisted,
  flagPicked,
  flagRefused,
} from './chat-flag';
import { saved } from './chat-flag.test-helpers';

/**
 * The four transitions of one chat flag.
 *
 * The switch, the sheet and the registry all act through them, so every phase is
 * pinned with what each transition does to it — including the phases it must
 * leave alone, because a step that landed late must never undo a newer tap.
 * What each phase draws is pinned in `chat-flag.test.ts`.
 */

describe('the transitions of a chat flag', () => {
  it('picks over a saved choice and keeps what a refusal falls back to', () => {
    expect(flagPicked(saved(false, 'behind'), true)).toEqual({
      kind: 'picking',
      next: true,
      was: { choice: false, application: 'behind' },
    });
  });

  it('picks over a tap that is still running without losing the choice behind it', () => {
    const first = flagPicked(saved(true), false);
    const second = flagPicked(first, true);

    expect(second).toEqual({
      kind: 'picking',
      next: true,
      was: { choice: true, application: 'current' },
    });
  });

  it('picks over a refusal, which is how tapping again retries it', () => {
    const refused = flagRefused(flagPicked(saved(true), false));

    expect(flagPicked(refused, true)).toEqual({
      kind: 'picking',
      next: true,
      was: { choice: true, application: 'current' },
    });
  });

  it('saves the choice a write landed, and says the move has not run yet', () => {
    expect(flagPersisted(flagPicked(saved(null), false), false)).toEqual({
      kind: 'saved',
      choice: false,
      application: 'moving',
    });
  });

  it('puts the choice on disk back when the write is refused', () => {
    expect(flagRefused(flagPicked(saved(true), false))).toEqual({
      kind: 'refused',
      was: { choice: true, application: 'current' },
    });
  });

  it('applies an outcome only to a saved choice', () => {
    expect(flagApplication(saved(true, 'moving'), 'behind')).toEqual(saved(true, 'behind'));
    expect(flagApplication(saved(true), 'current')).toEqual(saved(true, 'current'));
  });

  it('leaves a phase a newer tap moved past alone', () => {
    /* Every late step below belongs to the tap before it. None of them may put
       the flag back into a phase that tap left. */
    expect(flagPersisted({ kind: 'reading' }, true)).toEqual({ kind: 'reading' });
    expect(
      flagPersisted({ kind: 'refused', was: { choice: false, application: 'current' } }, true)
    ).toEqual({ kind: 'refused', was: { choice: false, application: 'current' } });
    expect(flagRefused({ kind: 'saved', choice: true, application: 'moving' })).toEqual(
      saved(true, 'moving')
    );
    expect(flagRefused({ kind: 'unread' })).toEqual({ kind: 'unread' });
    expect(
      flagApplication(
        { kind: 'picking', next: true, was: { choice: false, application: 'current' } },
        'behind'
      )
    ).toEqual({ kind: 'picking', next: true, was: { choice: false, application: 'current' } });
    expect(flagApplication({ kind: 'reading' }, 'behind')).toEqual({ kind: 'reading' });
  });

  it('picks before anything was read, and a refusal then goes back to the fallback', () => {
    const picked = flagPicked({ kind: 'reading' }, false);

    expect(chatFlagValueOf(picked, true)).toBe(false);
    expect(chatFlagValueOf(flagRefused(picked), true)).toBe(true);
  });
});
