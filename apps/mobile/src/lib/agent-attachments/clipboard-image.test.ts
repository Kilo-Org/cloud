import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodedBase64ByteLength,
  hasClipboardImage,
  hasClipboardUrl,
  parseClipboardImageData,
  readClipboardImageFile,
} from './clipboard-image';

type FileInstance = {
  exists: boolean;
  uri: string;
  write: ReturnType<typeof vi.fn>;
  filename: string;
};

const fileInstances: FileInstance[] = [];

const expoFileSystemMock = vi.hoisted(() => {
  const directoryCreate = vi.fn();
  const Directory = vi.fn(function DirectoryMock(_base: unknown, name: string) {
    return {
      name,
      create: directoryCreate,
    };
  });
  const File = vi.fn(function FileMock(directory: { name?: string }, filename: string) {
    const instance = {
      exists: false,
      uri: `file:///cache/clipboard-images/${filename}`,
      write: vi.fn(),
      filename,
      directory,
    };
    fileInstances.push(instance);
    return instance;
  });
  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    directoryCreate,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

const clipboardMock = vi.hoisted(() => ({
  hasImageAsync: vi.fn(),
  hasUrlAsync: vi.fn(),
  getImageAsync: vi.fn(),
}));

vi.mock('expo-clipboard', () => ({
  hasImageAsync: clipboardMock.hasImageAsync,
  hasUrlAsync: clipboardMock.hasUrlAsync,
  getImageAsync: clipboardMock.getImageAsync,
}));

vi.mock('expo-crypto', () => ({
  randomUUID: vi.fn(() => 'uuid-1'),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fileInstances.length = 0;
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('parseClipboardImageData', () => {
  it('parses a PNG data URI and returns the base64 payload with extension png', () => {
    const result = parseClipboardImageData('data:image/png;base64,iVBORw0KGgo=');
    expect(result).toEqual({
      base64: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      extension: 'png',
    });
  });

  it('parses a JPEG data URI and returns extension jpg', () => {
    const result = parseClipboardImageData('data:image/jpeg;base64,/9j/4AAQ');
    expect(result).toEqual({
      base64: '/9j/4AAQ',
      mimeType: 'image/jpeg',
      extension: 'jpg',
    });
  });

  it('returns null for a bare base64 string with no data: prefix', () => {
    expect(parseClipboardImageData('iVBORw0KGgo=')).toBeNull();
  });

  it('returns null for an unsupported image type (gif)', () => {
    expect(parseClipboardImageData('data:image/gif;base64,AAA')).toBeNull();
  });

  it('returns null for an empty PNG payload', () => {
    expect(parseClipboardImageData('data:image/png;base64,')).toBeNull();
  });

  it('returns null for a text/plain data URI', () => {
    expect(parseClipboardImageData('data:text/plain;base64,AAA')).toBeNull();
  });
});

describe('decodedBase64ByteLength', () => {
  it('decodes an unpadded payload exactly', () => {
    expect(decodedBase64ByteLength('TWFu')).toBe(3);
    expect(decodedBase64ByteLength('AAAA')).toBe(3);
  });

  it('decodes a single-padded payload exactly', () => {
    expect(decodedBase64ByteLength('TWE=')).toBe(2);
    expect(decodedBase64ByteLength('iVBORw0KGgo=')).toBe(8);
  });

  it('decodes a double-padded payload exactly', () => {
    expect(decodedBase64ByteLength('TQ==')).toBe(1);
    expect(decodedBase64ByteLength('AA==')).toBe(1);
  });

  it('returns 0 for an empty payload', () => {
    expect(decodedBase64ByteLength('')).toBe(0);
  });
});

describe('hasClipboardImage', () => {
  it('returns true when hasImageAsync resolves true', async () => {
    clipboardMock.hasImageAsync.mockResolvedValue(true);
    await expect(hasClipboardImage()).resolves.toBe(true);
  });

  it('returns false when hasImageAsync rejects', async () => {
    clipboardMock.hasImageAsync.mockRejectedValue(new Error('denied'));
    await expect(hasClipboardImage()).resolves.toBe(false);
  });
});

describe('hasClipboardUrl', () => {
  it('returns true when hasUrlAsync resolves true', async () => {
    clipboardMock.hasUrlAsync.mockResolvedValue(true);
    await expect(hasClipboardUrl()).resolves.toBe(true);
  });

  it('returns false when hasUrlAsync rejects', async () => {
    clipboardMock.hasUrlAsync.mockRejectedValue(new Error('denied'));
    await expect(hasClipboardUrl()).resolves.toBe(false);
  });
});

describe('readClipboardImageFile', () => {
  it('writes a PNG file with the correct name and encoding', async () => {
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgo=',
    });

    const result = await readClipboardImageFile();

    expect(result).toEqual({
      uri: 'file:///cache/clipboard-images/pasted-image-uuid-1.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith('file:///cache', 'clipboard-images');
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    expect(expoFileSystemMock.File).toHaveBeenCalled();
    const file = fileInstances[0];
    expect(file?.filename).toBe('pasted-image-uuid-1.png');
    expect(file?.write).toHaveBeenCalledWith('iVBORw0KGgo=', { encoding: 'base64' });
  });

  it('returns null when getImageAsync resolves null', async () => {
    clipboardMock.getImageAsync.mockResolvedValue(null);

    const result = await readClipboardImageFile();

    expect(result).toBeNull();
    expect(fileInstances).toHaveLength(0);
  });

  it('returns null when getImageAsync rejects', async () => {
    clipboardMock.getImageAsync.mockRejectedValue(new Error('denied'));

    const result = await readClipboardImageFile();

    expect(result).toBeNull();
    expect(fileInstances).toHaveLength(0);
  });

  it('returns null when the data URI is unparseable', async () => {
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/gif;base64,AAA',
    });

    const result = await readClipboardImageFile();

    expect(result).toBeNull();
    expect(fileInstances).toHaveLength(0);
  });

  it('returns null when file.write throws', async () => {
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expoFileSystemMock.File.mockImplementationOnce(function FileFail(
      _directory: unknown,
      _filename: string
    ) {
      const instance = {
        exists: false,
        uri: 'file:///cache/clipboard-images/pasted-image-uuid-1.png',
        write: vi.fn(() => {
          throw new Error('disk full');
        }),
        filename: 'pasted-image-uuid-1.png',
        directory: _directory as { name?: string },
      };
      fileInstances.push(instance);
      return instance;
    });

    const result = await readClipboardImageFile();

    expect(result).toBeNull();
    expect(fileInstances[0]?.write).toHaveBeenCalled();
  });

  it("returns 'too-large' when maxBytes is set and the decoded payload exceeds it", async () => {
    // 'iVBORw0KGgo=' decodes to 8 bytes.
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgo=',
    });

    const result = await readClipboardImageFile(7);

    expect(result).toBe('too-large');
    // No directory is created and no bytes reach disk.
    expect(expoFileSystemMock.Directory).not.toHaveBeenCalled();
    expect(fileInstances).toHaveLength(0);
  });

  it('writes the file when the decoded payload is within maxBytes', async () => {
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgo=',
    });

    const result = await readClipboardImageFile(8);

    expect(result).toEqual({
      uri: 'file:///cache/clipboard-images/pasted-image-uuid-1.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });
    expect(fileInstances).toHaveLength(1);
  });

  it('does not apply the bound when maxBytes is omitted', async () => {
    clipboardMock.getImageAsync.mockResolvedValue({
      data: 'data:image/png;base64,iVBORw0KGgo=',
    });

    const result = await readClipboardImageFile();

    expect(result).toEqual({
      uri: 'file:///cache/clipboard-images/pasted-image-uuid-1.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });
    expect(fileInstances).toHaveLength(1);
  });
});
