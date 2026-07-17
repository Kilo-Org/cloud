import { describe, expect, it } from 'vitest';

import {
  getDirectIngestUserBucket,
  parseDirectIngestConfig,
  selectDirectIngestUser,
  type DirectIngestConfig,
} from './direct-ingest-rollout';

function validInput() {
  return {
    DIRECT_INGEST_PERCENT: '25',
    DIRECT_INGEST_MAX_BYTES: '4194304',
    DIRECT_INGEST_USER_IDS: '',
  };
}

function config(overrides: Partial<DirectIngestConfig> = {}): DirectIngestConfig {
  return { percent: 25, maxBytes: 4_194_304, userIds: new Set(), ...overrides };
}

describe('parseDirectIngestConfig', () => {
  it.each([undefined, '', ' ', '-1', '1.5', '01', '101', 'Infinity', '25 '])(
    'fails closed for invalid percent %j',
    percent => {
      expect(parseDirectIngestConfig({ ...validInput(), DIRECT_INGEST_PERCENT: percent })).toEqual({
        ok: false,
        reason: 'invalid_percent',
      });
    }
  );

  it.each([undefined, '', ' ', '0', '-1', '1.5', '01', '4194305', 'Infinity', '9007199254740992'])(
    'fails closed for invalid max bytes %j',
    maxBytes => {
      expect(
        parseDirectIngestConfig({ ...validInput(), DIRECT_INGEST_MAX_BYTES: maxBytes })
      ).toEqual({ ok: false, reason: 'invalid_max_bytes' });
    }
  );

  it('accepts percent boundaries and the supported direct body cap', () => {
    expect(
      parseDirectIngestConfig({
        ...validInput(),
        DIRECT_INGEST_PERCENT: '0',
        DIRECT_INGEST_MAX_BYTES: '4194304',
      })
    ).toMatchObject({ ok: true, config: { percent: 0, maxBytes: 4194304 } });

    expect(
      parseDirectIngestConfig({ ...validInput(), DIRECT_INGEST_PERCENT: '100' })
    ).toMatchObject({ ok: true, config: { percent: 100 } });
  });

  it('trims comma-separated user IDs and removes empty and duplicate values', () => {
    const result = parseDirectIngestConfig({
      ...validInput(),
      DIRECT_INGEST_USER_IDS: ' user-a, user-b ,,user-a, ',
    });

    expect(result.ok && [...result.config.userIds]).toEqual(['user-a', 'user-b']);
  });

  it('fails closed when the user ID setting is missing', () => {
    expect(parseDirectIngestConfig({ ...validInput(), DIRECT_INGEST_USER_IDS: undefined })).toEqual(
      { ok: false, reason: 'invalid_user_ids' }
    );
  });
});

describe('selectDirectIngestUser', () => {
  it('selects no percentage users at zero percent', async () => {
    await expect(selectDirectIngestUser(config({ percent: 0 }), 'user-a')).resolves.toEqual({
      selected: false,
      reason: 'not_selected',
      bucket: null,
    });
  });

  it('selects every user at 100 percent', async () => {
    await expect(selectDirectIngestUser(config({ percent: 100 }), 'user-a')).resolves.toEqual({
      selected: true,
      reason: 'percentage',
      bucket: null,
    });
  });

  it('allows an allowlisted user at zero percent', async () => {
    await expect(
      selectDirectIngestUser(config({ percent: 0, userIds: new Set(['user-a']) }), 'user-a')
    ).resolves.toEqual({ selected: true, reason: 'allowlist', bucket: null });
  });

  it('deterministically selects from the SHA-256 user bucket', async () => {
    const bucket = 63;

    await expect(getDirectIngestUserBucket('stable-user')).resolves.toBe(63);
    await expect(getDirectIngestUserBucket('usr_test')).resolves.toBe(84);
    await expect(getDirectIngestUserBucket('rollout-user-a')).resolves.toBe(13);
    await expect(
      selectDirectIngestUser(config({ percent: bucket + 1 }), 'stable-user')
    ).resolves.toEqual({ selected: true, reason: 'percentage', bucket });
    await expect(
      selectDirectIngestUser(config({ percent: bucket }), 'stable-user')
    ).resolves.toEqual({ selected: false, reason: 'not_selected', bucket });
  });
});
