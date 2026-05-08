import {
  hashDataLayerUserData,
  normalizeEmailForSha256,
  normalizeNameForSha256,
  sha256Hex,
} from '@/lib/data-layer-hashing';

const TEST_EMAIL_SHA256 = '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b';
const TEST_NAME_SHA256 = '177f85df57ad121d5aaac8076a4a0554a673182fe06cf65ee7d9f7d0961f947d';

describe('data layer hashing', () => {
  it('normalizes email before hashing', () => {
    expect(normalizeEmailForSha256(' Test@Example.COM ')).toBe('test@example.com');
  });

  it('normalizes name before hashing', () => {
    expect(normalizeNameForSha256(' Ada Lovelace ')).toBe('ada lovelace');
  });

  it('hashes values as sha256 hex', async () => {
    await expect(sha256Hex('test@example.com')).resolves.toBe(TEST_EMAIL_SHA256);
  });

  it('builds hashed dataLayer user fields without raw values', async () => {
    await expect(
      hashDataLayerUserData({ email: ' Test@Example.COM ', name: ' Ada Lovelace ' })
    ).resolves.toEqual({
      user_data_format: 'sha256',
      email: TEST_EMAIL_SHA256,
      email_sha256: TEST_EMAIL_SHA256,
      name: TEST_NAME_SHA256,
      name_sha256: TEST_NAME_SHA256,
    });
  });

  it('omits blank optional names', async () => {
    await expect(
      hashDataLayerUserData({ email: 'test@example.com', name: '   ' })
    ).resolves.toEqual({
      user_data_format: 'sha256',
      email: TEST_EMAIL_SHA256,
      email_sha256: TEST_EMAIL_SHA256,
    });
  });

  it('returns null when email is blank', async () => {
    await expect(hashDataLayerUserData({ email: '   ', name: 'Ada Lovelace' })).resolves.toBeNull();
  });
});
