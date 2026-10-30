import assert from 'node:assert/strict';
import test from 'node:test';

import type { Exec } from './capture';
import { inkBox, readRgba } from './pixels';

test('readRgba sizes with ffprobe and decodes with ffmpeg', () => {
  const calls: string[][] = [];
  const exec: Exec = (file, args) => {
    calls.push([file, ...args]);
    return file === 'ffprobe' ? Buffer.from('2x1\n') : Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  };
  const image = readRgba('/tmp/shot.png', exec);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual([...image.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(calls[1], [
    'ffmpeg',
    '-v',
    'error',
    '-i',
    '/tmp/shot.png',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  assert.equal(calls[0].at(-1), '/tmp/shot.png');
});

test('readRgba rejects truncated frames', () => {
  const exec: Exec = file => (file === 'ffprobe' ? Buffer.from('2x2') : Buffer.alloc(4));
  assert.throws(() => readRgba('/tmp/shot.png', exec), /4 bytes for a 2x2 image/);
});

test('inkBox finds ink against the ring background and ignores rounded corners', () => {
  const width = 20;
  const data = new Uint8Array(width * width * 4).fill(255);
  const paint = (x: number, y: number, value: number) =>
    data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
  for (let y = 8; y < 12; y++) for (let x = 6; x < 10; x++) paint(x, y, 0);
  paint(1, 1, 0);
  const result = inkBox({ width, height: width, data }, [0, 0, 20, 20], 1, 3);
  assert.deepEqual(result?.bounds, [1, 1, 18, 18]);
  assert.deepEqual(result?.box, [6, 8, 4, 4]);
  assert.equal(result?.background, 0xffffff);
  assert.equal(
    inkBox({ width, height: width, data: new Uint8Array(width * width * 4) }, [0, 0, 20, 20], 1),
    undefined
  );
});
