import { describe, expect, test } from '@jest/globals';
import {
  customRouterEntryKey,
  type CustomRouterEntry,
  type CustomRouterServingPin,
} from '@kilocode/auto-routing-contracts';
import { decideServingPins } from '@/lib/auto-routing-pool-pin-decision';

const ALIAS = '~vendor/latest';
const OLD_TARGET = 'vendor/old';
const NEW_TARGET = 'vendor/new';
const CONFIRMED_EARLY = '2026-11-20T10:00:00.000Z';
const CONFIRMED_LATE = '2026-11-20T11:00:00.000Z';
const PINNED_AT = '2026-11-20T12:00:00.000Z';

function pin(model: string, confirmedAt: string, requestId = 'req-1'): CustomRouterServingPin {
  return { model, pinnedAt: PINNED_AT, requestId, confirmedAt };
}

function decide(options: {
  pool?: CustomRouterEntry[];
  aliases?: { model: string; target: string }[];
  confirmedAt?: string;
  poolChanged?: boolean;
}) {
  return decideServingPins({
    entries: options.pool ?? [gateway(ALIAS, pin(OLD_TARGET, CONFIRMED_EARLY))],
    aliases: options.aliases ?? [{ model: ALIAS, target: NEW_TARGET }],
    poolUnchanged: !options.poolChanged,
    requestId: 'req-late',
    confirmedAt: options.confirmedAt ?? CONFIRMED_LATE,
    pinnedAt: PINNED_AT,
  });
}

function gateway(model: string, servingPin?: CustomRouterServingPin): CustomRouterEntry {
  return { kind: 'gateway', model, ...(servingPin ? { servingPin } : {}) };
}

/** Only a gateway entry can carry a pin; the union member must be narrowed before reading one. */
function servingPinOf(entry: CustomRouterEntry | undefined): CustomRouterServingPin | undefined {
  return entry?.kind === 'gateway' ? entry.servingPin : undefined;
}

describe('decideServingPins', () => {
  test('re-pins a moved alias with the applicable later confirmation, keeping the old pin until then', () => {
    const outcome = decide({});

    expect(outcome.applied).toEqual([{ model: ALIAS, target: NEW_TARGET, pinnedAt: PINNED_AT }]);
    expect(outcome.skipped).toEqual([]);
    expect(servingPinOf(outcome.entries[0])).toMatchObject({
      model: NEW_TARGET,
      confirmedAt: CONFIRMED_LATE,
      requestId: 'req-late',
    });
  });

  test('never lets a late callback from an older confirmation overwrite a newer pin', () => {
    const outcome = decide({
      pool: [gateway(ALIAS, pin(NEW_TARGET, CONFIRMED_LATE, 'req-new'))],
      aliases: [{ model: ALIAS, target: OLD_TARGET }],
      confirmedAt: CONFIRMED_EARLY,
    });

    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ model: ALIAS, reason: 'superseded' }]);
    expect(servingPinOf(outcome.entries[0])?.model).toBe(NEW_TARGET);
  });

  test('pins nothing once the pool definition changed, and never runs the new target', () => {
    const outcome = decide({ poolChanged: true });

    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ model: ALIAS, reason: 'pool_changed' }]);
    expect(servingPinOf(outcome.entries[0])?.model).toBe(OLD_TARGET);
  });

  test('cannot pin an alias the edited pool removed or replaced', () => {
    const outcome = decide({
      pool: [gateway('openai/gpt-5')],
      aliases: [{ model: ALIAS, target: NEW_TARGET }],
    });

    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ model: ALIAS, reason: 'entry_missing' }]);
    expect(outcome.entries.map(entry => customRouterEntryKey(entry))).toEqual([
      'gateway:openai/gpt-5',
    ]);
  });

  test('is idempotent on a replay and leaves a linked entry to its platform measurement', () => {
    const replay = decideServingPins({
      entries: [gateway(ALIAS, pin(NEW_TARGET, CONFIRMED_LATE, 'req-late'))],
      aliases: [{ model: ALIAS, target: NEW_TARGET }],
      poolUnchanged: true,
      requestId: 'req-late',
      confirmedAt: CONFIRMED_LATE,
      pinnedAt: PINNED_AT,
    });
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toEqual([{ model: ALIAS, reason: 'unchanged' }]);

    const linked = decide({
      pool: [{ kind: 'gateway', model: ALIAS, measuredAs: 'vendor/old' }],
    });
    expect(linked.applied).toEqual([]);
    expect(linked.skipped).toEqual([{ model: ALIAS, reason: 'link_applies' }]);
    expect(servingPinOf(linked.entries[0])).toBeUndefined();
  });

  test('keeps every unpinned entry of a changed pool exactly as it was', () => {
    const other = gateway('openai/gpt-5');
    const outcome = decideServingPins({
      entries: [other, gateway(ALIAS, pin(OLD_TARGET, CONFIRMED_EARLY))],
      aliases: [{ model: ALIAS, target: NEW_TARGET }],
      poolUnchanged: true,
      requestId: 'req-late',
      confirmedAt: CONFIRMED_LATE,
      pinnedAt: PINNED_AT,
    });

    expect(outcome.entries[0]).toBe(other);
  });
});
