import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  posthogCustomStorage,
  purgePostHogPersistence,
  resetPostHogStorageForTests,
  sealPostHogStorage,
  unsealPostHogStorage,
} from './posthog-storage';

const expoFileSystemMock = vi.hoisted(() => {
  // Distinct, non-empty payloads per PostHog file. A reader that returns the
  // wrong file, or invents a value, cannot match both payloads.
  const fileContents: Record<string, string> = {
    '.posthog-rn.json': '{"distinct_id":"anon-1"}',
    '.posthog-rn-logs.json': '[]',
  };

  const File = vi.fn(function FileMock(_base: string, name: string) {
    const file: MockFileInstance = {
      _exists: true,
      get exists() {
        return (this as { _exists: boolean })._exists;
      },
      text: vi.fn().mockResolvedValue(fileContents[name] ?? ''),
      writeSync(value: string) {
        this.content = value;
      },
      delete: vi.fn(),
    };
    return file;
  });
  return {
    File,
    fileContents,
    Paths: { cache: 'file:///cache', document: 'file:///document' },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

type MockFileInstance = {
  _exists: boolean;
  readonly exists: boolean;
  text: ReturnType<typeof vi.fn>;
  content?: string;
  writeSync: (value: string) => void;
  delete: ReturnType<typeof vi.fn>;
};

function lastFileInstance(): MockFileInstance {
  const inst = expoFileSystemMock.File.mock.results.at(-1)?.value;
  if (!inst) {
    throw new Error('no File instance yet — call the operation before checking the instance');
  }
  return inst;
}

function createdFiles(): { base: string; name: string }[] {
  return (expoFileSystemMock.File.mock.calls as [string, string][]).map(([base, name]) => ({
    base,
    name,
  }));
}

function makeNextFile(opts?: {
  exists?: boolean;
  textReject?: Error;
  writeReject?: Error;
  deleteReject?: Error;
}): void {
  const exists = opts?.exists ?? true;
  const textReject = opts?.textReject;
  const writeReject = opts?.writeReject;
  const deleteReject = opts?.deleteReject;
  expoFileSystemMock.File.mockImplementationOnce(function FileMock(
    this: MockFileInstance,
    _base: string,
    name: string
  ) {
    const file: MockFileInstance = {
      _exists: exists,
      get exists() {
        return exists;
      },
      text: textReject
        ? vi.fn().mockRejectedValue(textReject)
        : vi.fn().mockResolvedValue(expoFileSystemMock.fileContents[name] ?? ''),
      writeSync(value: string) {
        if (writeReject) {
          throw writeReject;
        }
        this.content = value;
      },
      delete: deleteReject
        ? vi.fn(() => {
            throw deleteReject;
          })
        : vi.fn(),
    };
    return file;
  });
}

beforeEach(() => {
  resetPostHogStorageForTests();
  vi.clearAllMocks();
});

describe('posthogCustomStorage', () => {
  describe('getItem', () => {
    it('reads from Paths.cache for the events file', async () => {
      await posthogCustomStorage.getItem('.posthog-rn.json');
      const files = createdFiles();
      expect(files).toHaveLength(1);
      expect(files[0]?.base).toBe('file:///cache');
      expect(files[0]?.name).toBe('.posthog-rn.json');
    });

    it('reads from Paths.cache for the logs file', async () => {
      await posthogCustomStorage.getItem('.posthog-rn-logs.json');
      const files = createdFiles();
      expect(files).toHaveLength(1);
      expect(files[0]?.base).toBe('file:///cache');
      expect(files[0]?.name).toBe('.posthog-rn-logs.json');
    });

    it('never uses Paths.document', async () => {
      await posthogCustomStorage.getItem('.posthog-rn.json');
      for (const { base } of createdFiles()) {
        expect(base).not.toBe('file:///document');
      }
    });

    it('returns the content of the requested file', async () => {
      const events = await posthogCustomStorage.getItem('.posthog-rn.json');
      const logs = await posthogCustomStorage.getItem('.posthog-rn-logs.json');

      expect(events).toBe('{"distinct_id":"anon-1"}');
      expect(logs).toBe('[]');
    });

    it('returns null when the file does not exist', async () => {
      makeNextFile({ exists: false });
      const result = await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(result).toBeNull();
    });

    it('returns null on a read error', async () => {
      makeNextFile({ textReject: new Error('disk full') });
      const result = await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(result).toBeNull();
    });
  });

  describe('setItem', () => {
    it('writes to Paths.cache for the events file', () => {
      posthogCustomStorage.setItem('.posthog-rn.json', '{}');
      const files = createdFiles();
      expect(files).toHaveLength(1);
      expect(files[0]?.base).toBe('file:///cache');
      expect(files[0]?.name).toBe('.posthog-rn.json');
    });

    it('writes to Paths.cache for the logs file', () => {
      posthogCustomStorage.setItem('.posthog-rn-logs.json', '[]');
      const files = createdFiles();
      expect(files).toHaveLength(1);
      expect(files[0]?.base).toBe('file:///cache');
      expect(files[0]?.name).toBe('.posthog-rn-logs.json');
    });

    it('never uses Paths.document', () => {
      posthogCustomStorage.setItem('.posthog-rn.json', '{}');
      for (const { base } of createdFiles()) {
        expect(base).not.toBe('file:///document');
      }
    });

    it('writes the value to the file', () => {
      posthogCustomStorage.setItem('.posthog-rn.json', '{"q":1}');
      expect(lastFileInstance().content).toBe('{"q":1}');
    });

    it('swallows a write error', () => {
      makeNextFile({ writeReject: new Error('disk full') });
      expect(() => {
        posthogCustomStorage.setItem('.posthog-rn.json', '{}');
      }).not.toThrow();
    });
  });
});

describe('seal', () => {
  describe('sealed getItem', () => {
    it('returns null when sealed', async () => {
      sealPostHogStorage();
      const result = await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(result).toBeNull();
    });

    it('does not touch the file system when sealed', async () => {
      sealPostHogStorage();
      await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(expoFileSystemMock.File).not.toHaveBeenCalled();
    });
  });

  describe('sealed setItem', () => {
    it('writes nothing when sealed', () => {
      sealPostHogStorage();
      posthogCustomStorage.setItem('.posthog-rn.json', 'payload');
      expect(expoFileSystemMock.File).not.toHaveBeenCalled();
    });
  });

  describe('after unseal', () => {
    it('setItem writes again', () => {
      sealPostHogStorage();
      unsealPostHogStorage();
      posthogCustomStorage.setItem('.posthog-rn.json', 'payload');
      expect(lastFileInstance().content).toBe('payload');
    });

    it('getItem reads again', async () => {
      sealPostHogStorage();
      unsealPostHogStorage();
      const result = await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(result).toBe('{"distinct_id":"anon-1"}');
    });
  });
});

describe('purgePostHogPersistence', () => {
  it('does nothing when unsealed', () => {
    purgePostHogPersistence();
    expect(expoFileSystemMock.File).not.toHaveBeenCalled();
  });

  it('deletes all four paths when sealed', () => {
    sealPostHogStorage();
    purgePostHogPersistence();

    const files = createdFiles();
    expect(files).toHaveLength(4);

    const paths = files.map(f => `${f.base}/${f.name}`);
    expect(paths).toContain('file:///cache/.posthog-rn.json');
    expect(paths).toContain('file:///cache/.posthog-rn-logs.json');
    expect(paths).toContain('file:///document/.posthog-rn.json');
    expect(paths).toContain('file:///document/.posthog-rn-logs.json');

    for (const inst of expoFileSystemMock.File.mock.instances as MockFileInstance[]) {
      expect(inst.delete).toHaveBeenCalled();
    }
  });
});
