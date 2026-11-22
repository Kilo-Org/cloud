import { NativeSnapshotBlobCache } from './native-snapshot-blobs';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const third = 'c'.repeat(64);
// A four-character body in `ses_a` with a 64-character hash costs 4 * 2 + (5 + 64) * 2 = 146
// UTF-16 bytes: eight for the body text and 138 for its keys.
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
  // Two entries of 146 bytes fit in 300; a third would not.
  const cache = new NativeSnapshotBlobCache(300);
  cache.write('ses_a', hash, body);
  cache.write('ses_b', other, otherBody);
  // Reading `ses_a` makes `ses_b` the oldest entry.
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
  cache.write('ses_c', hash, thirdBody);
  expect(cache.read('ses_b', other, 3)).toBeUndefined();
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
  expect(cache.read('ses_c', hash, 3)).toEqual(thirdBody);
});

it('never retains a body larger than the whole budget, and does not evict fitting bodies for it', () => {
  // A fitting entry costs 146; the oversized one costs 80 * 2 + 138 = 298.
  const cache = new NativeSnapshotBlobCache(200);
  cache.write('ses_a', hash, body);
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
  // A body that cannot fit alone is rejected instead of evicting the bodies that do fit.
  cache.write('ses_a', other, { bytes: 40, base64: 'A'.repeat(80) });
  expect(cache.read('ses_a', other, 40)).toBeUndefined();
  expect(cache.read('ses_a', hash, 3)).toEqual(body);
});

it('retains nothing when the budget is below one entry’s cost', () => {
  // One byte short of the 146 bytes a single entry keeps, keys included.
  const cache = new NativeSnapshotBlobCache(145);
  cache.write('ses_a', hash, body);
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});

it('charges an empty body its keys, so a tiny budget cannot accumulate empty bodies', () => {
  // An empty body still costs (5 + 64) * 2 = 138 bytes, so two fit in 300 and a third evicts.
  const cache = new NativeSnapshotBlobCache(300);
  const empty = { bytes: 0, base64: '' };
  cache.write('ses_a', hash, empty);
  cache.write('ses_a', other, empty);
  // Reading each entry in insertion order leaves `hash` the oldest of the two.
  expect(cache.read('ses_a', hash, 0)).toEqual(empty);
  expect(cache.read('ses_a', other, 0)).toEqual(empty);
  cache.write('ses_a', third, empty);
  expect(cache.read('ses_a', hash, 0)).toBeUndefined();
  expect(cache.read('ses_a', other, 0)).toEqual(empty);
  expect(cache.read('ses_a', third, 0)).toEqual(empty);
});

it('drops a body whose advertised size disagrees with the settled one', () => {
  const cache = new NativeSnapshotBlobCache(1024);
  cache.write('ses_a', hash, body);
  expect(cache.read('ses_a', hash, 4)).toBeUndefined();
  // The disagreement drops the entry instead of leaving a body the caller cannot use.
  expect(cache.read('ses_a', hash, 3)).toBeUndefined();
});
