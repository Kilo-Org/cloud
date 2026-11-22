// Adapted from imuratalpay/ui-diff (MIT) at
// 3075b4c8bbbf1a352404829f84f64c26cba291e5, skills/ui-diff/src/font.ts.
// The 5x7 bitmap font keeps composite labels readable without a canvas or a font file.
// See LICENSE-UI-DIFF in this directory.
import type { PNG } from 'pngjs';

const GLYPHS: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '####.|....#|....#|.###.|....#|....#|####.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  '/': '.....|....#|...#.|..#..|.#...|#....|.....',
  '=': '.....|.....|#####|.....|#####|.....|.....',
  '(': '...#.|..#..|.#...|.#...|.#...|..#..|...#.',
  ')': '.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  _: '.....|.....|.....|.....|.....|.....|#####',
};

const PARSED = new Map<string, boolean[][]>();
for (const [character, rows] of Object.entries(GLYPHS)) {
  PARSED.set(
    character,
    rows.split('|').map(row => [...row].map(cell => cell === '#'))
  );
}

const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

export function measureText(text: string, scale: number): number {
  return text.length === 0 ? 0 : text.length * (GLYPH_WIDTH + 1) * scale - scale;
}

export function drawText(
  png: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: [number, number, number, number]
): void {
  let cursor = x;
  for (const raw of text) {
    const glyph = PARSED.get(raw.toUpperCase()) ?? PARSED.get('?');
    if (!glyph) continue;
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (!glyph[gy][gx]) continue;
        for (let dy = 0; dy < scale; dy++) {
          const py = y + gy * scale + dy;
          if (py < 0 || py >= png.height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const px = cursor + gx * scale + dx;
            if (px < 0 || px >= png.width) continue;
            const i = (py * png.width + px) * 4;
            png.data[i] = color[0];
            png.data[i + 1] = color[1];
            png.data[i + 2] = color[2];
            png.data[i + 3] = color[3];
          }
        }
      }
    }
    cursor += (GLYPH_WIDTH + 1) * scale;
  }
}

/** Shortens text with a trailing ellipsis so it fits `maxWidth` at `scale`. */
export function fitText(text: string, scale: number, maxWidth: number): string {
  if (measureText(text, scale) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measureText(`${out}...`, scale) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}
