import { readCachedPage } from './cached-page-read';

describe('readCachedPage', () => {
  it('applies a synchronous page and returns null', () => {
    const apply = jest.fn();
    const page = { messages: [] };

    expect(readCachedPage(() => page, apply)).toBeNull();
    expect(apply).toHaveBeenCalledWith(page);
  });

  it('treats a synchronous apply failure as a cache miss', () => {
    const apply = jest.fn(() => {
      throw new Error('unreadable cache');
    });

    expect(() => readCachedPage(() => ({ messages: [] }), apply)).not.toThrow();
  });

  it('applies an asynchronous page and swallows apply failures', async () => {
    const applied = jest.fn();
    const page = { messages: [] };
    const read = readCachedPage(() => Promise.resolve(page), applied);

    await expect(read).resolves.toBeUndefined();
    expect(applied).toHaveBeenCalledWith(page);

    const throwing = readCachedPage(
      () => Promise.resolve(page),
      () => {
        throw new Error('unreadable cache');
      }
    );
    await expect(throwing).resolves.toBeUndefined();
  });
});
