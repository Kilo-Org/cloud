// Synthetic Pages packages for the tests of both builds that read the pin
// (`services/pages` and `services/pages-output`). No test downloads a release.
import { gzipSync } from 'node:zlib';

/** A gzipped ustar archive of `members`: [path, contents, typeflag?, size field?]. */
export function archiveOf(members) {
  const blocks = [];
  for (const [name, contents, type = '0', sizeField] of members) {
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write((sizeField ?? bytes.length.toString(8).padStart(11, '0')) + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(' ', 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** The members of a well-formed package, in archive order. */
export const goodMembers = [
  ['build-receipt.json', '{}'],
  ['output/worker.js', 'export default { fetch() {} }'],
  ['output/wrangler.json', '{}'],
  ['public/chunks/editor.js', 'x'],
  ['public/index.html', '<!doctype html>'],
  ['worker/automerge.wasm', 'w'],
  ['worker/index.js', 'export default {}'],
  ['wrangler.json', '{}'],
];
