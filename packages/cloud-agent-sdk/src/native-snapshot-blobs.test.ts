import { NativeSnapshotBlobCache } from './native-snapshot-blobs';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
// Each test body is four base64 characters, which retain eight UTF-16 bytes.
const body = { bytes: 3, base64: 'AQID' };
const otherBody = { bytes: 3, base64: 'BAUG' };
const thirdBody = { bytes: 3, base64: 'BwgJ' };

it('forgets only the closed session’s bodies', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', hash, body);
  cache.write('ses_b', hash, otherBody);
  cache.forgetSession('ses_a');
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
  // The same content hash in another session is a different entry, not shared state.
  expect(cache.read('ses_b', hash, 3)).toEqual(otherBody);
});

it('keeps one budget across every session, evicting the least recently read body', () => {
  // Two bodies of eight retained bytes each.
  const cache = new NativeSnapshotBlobCache(16);
  cache.write('ses_a', hash, body);
  cache.write('ses_b', other, otherBody);
  // Reading `ses_a` makes `ses_b` the oldest entry.
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
  cache.write('ses_c', hash, thirdBody);
  expect(cache.read('ses_b', other, 3)).toBeUndefined();
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
  expect(cache.read('ses_c', hash, 3)).toEqual(thirdBody);
});

it('never retains a body larger than the whole budget', () => {
  // One byte short of a whole body.
  const cache = new NativeSnapshotBlobCache(7);
  cache.write('ses_a', hash, body);
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});

it('drops a body whose advertised size disagrees with the settled one', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', hash, body);
  expect(cache.read('ses_a', hash, 4)).toBeUndefined();
  // The disagreement drops the entry instead of leaving a body the caller cannot use.
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});
