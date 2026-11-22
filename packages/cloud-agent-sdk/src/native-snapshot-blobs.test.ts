import { NativeSnapshotBlobCache } from './native-snapshot-blobs';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);

it('forgets only the closed session’s bodies', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', hash, { bytes: 3, base64: 'AQID' });
  cache.write('ses_b', hash, { bytes: 3, base64: 'BAUG' });
  cache.forgetSession('ses_a');
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
  // The same content hash in another session is a different entry, not shared state.
  expect(cache.read('ses_b', hash, 3)).toEqual({ bytes: 3, base64: 'BAUG' });
});

it('keeps one budget across every session, evicting the least recently read body', () => {
  const cache = new NativeSnapshotBlobCache(6);
  cache.write('ses_a', hash, { bytes: 3, base64: 'AQID' });
  cache.write('ses_b', other, { bytes: 3, base64: 'BAUG' });
  // Reading `ses_a` makes `ses_b` the oldest entry.
  expect(cache.read('ses_a', hash, 3)).toEqual({ bytes: 3, base64: 'AQID' });
  cache.write('ses_c', hash, { bytes: 3, base64: 'BwgJ' });
  expect(cache.read('ses_b', other, 3)).toBeUndefined();
  expect(cache.read('ses_a', hash, 3)).toEqual({ bytes: 3, base64: 'AQID' });
  expect(cache.read('ses_c', hash, 3)).toEqual({ bytes: 3, base64: 'BwgJ' });
});

it('never retains a body larger than the whole budget', () => {
  const cache = new NativeSnapshotBlobCache(2);
  cache.write('ses_a', hash, { bytes: 3, base64: 'AQID' });
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});

it('drops a body whose advertised size disagrees with the settled one', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', hash, { bytes: 3, base64: 'AQID' });
  expect(cache.read('ses_a', hash, 4)).toBeUndefined();
  // The disagreement drops the entry instead of leaving a body the caller cannot use.
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});
