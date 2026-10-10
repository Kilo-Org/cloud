import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One rendered native image: the shape the encoder reads and releases. */
type FakeImage = {
  width: number;
  height: number;
  release: ReturnType<typeof vi.fn>;
  saveAsync: ReturnType<typeof vi.fn>;
};

const manipulator = vi.hoisted(() => ({
  renders: [] as FakeImage[],
  resizes: [] as { width?: number; height?: number }[],
}));

function makeImage(width: number, height: number, base64: string | undefined): FakeImage {
  const image: FakeImage = {
    width,
    height,
    release: vi.fn(),
    saveAsync: vi.fn(async () => ({
      uri: 'file:///cache/out.jpg',
      width,
      height,
      base64,
    })),
  };
  manipulator.renders.push(image);
  return image;
}

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: () => {
      const context = {
        resize: (size: { width?: number; height?: number }) => {
          manipulator.resizes.push(size);
          return context;
        },
        renderAsync: async () => {
          const next = manipulator.renders.shift();
          if (!next) {
            throw new Error('no rendered image queued');
          }
          return next;
        },
      };
      return context;
    },
  },
}));

const { encodeLocalImage, LocalImageError } = await import('./local-image');

beforeEach(() => {
  manipulator.renders.length = 0;
  manipulator.resizes.length = 0;
});

describe('encodeLocalImage', () => {
  it('returns the bytes of an image already within the limit', async () => {
    const image = makeImage(800, 600, 'AAAA');

    expect(await encodeLocalImage('file:///cache/a.png')).toEqual({
      media: 'image/jpeg',
      data: 'AAAA',
    });
    expect(manipulator.resizes).toEqual([]);
    expect(image.release).toHaveBeenCalledOnce();
  });

  it('scales an oversized image down and releases both native images', async () => {
    const source = makeImage(4000, 3000, undefined);
    const scaled = makeImage(1568, 1176, 'BBBB');

    expect(await encodeLocalImage('file:///cache/b.png')).toEqual({
      media: 'image/jpeg',
      data: 'BBBB',
    });
    expect(manipulator.resizes).toEqual([{ width: 1568, height: 1176 }]);
    expect(source.release).toHaveBeenCalledOnce();
    expect(scaled.release).toHaveBeenCalledOnce();
  });

  it('releases the native image and refuses an image that cannot be read', async () => {
    const image = makeImage(100, 100, undefined);
    image.saveAsync.mockRejectedValue(new Error('decode failed'));

    await expect(encodeLocalImage('file:///cache/c.png')).rejects.toBeInstanceOf(LocalImageError);
    expect(image.release).toHaveBeenCalledOnce();
  });

  it('releases the native image and refuses an image that stays too large', async () => {
    const image = makeImage(200, 200, 'C'.repeat(6 * 1024 * 1024));

    const failure = await encodeLocalImage('file:///cache/d.png').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalImageError);
    expect((failure as LocalImageError).reason).toBe('tooLarge');
    expect(image.release).toHaveBeenCalledOnce();
  });
});
