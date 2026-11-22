import { NativeSnapshotBlobCache } from './native-snapshot-blobs';

it('forgetSession drops only that session’s bodies', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', 'a'.repeat(64), { bytes: 3, base64: 'AQID' });
  cache.write('ses_b', 'a'.repeat(64), { bytes: 3, base64: 'BAUG' });
  cache.forgetSession('ses_a');
  expect(cache.read('ses_a', 'a'.repeat(64), 3)).toBeUndefined();
  expect(cache.read('ses_b', 'a'.repeat(64), 3)).toEqual({ bytes: 3, base64: 'BAUG' });
});
