import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isPostHogStorageSealed,
  POSTHOG_STORAGE_FILES,
  posthogCustomStorage,
  purgePostHogPersistence,
  resetPostHogStorageForTests,
  sealPostHogStorage,
  unsealPostHogStorage,
} from './posthog-storage';

// ---- mock ----

const expoFileSystemMock = vi.hoisted(() => {
  const File = vi.fn(function FileMock(_base: string, _name: string) {
    return {
      _exists: true,
      get exists() {
        return (this as { _exists: boolean })._exists;
      },
      text: vi.fn().mockResolvedValue(''),
      write: vi.fn(),
      delete: vi.fn(),
    };
  });
  return {
    File,
    Paths: { cache: 'file:///cache', document: 'file:///document' },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

// ---- helpers ----

type MockFileInstance = {
  _exists: boolean;
  readonly exists: boolean;
  text: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function lastFileInstance(): MockFileInstance {
  const instances = expoFileSystemMock.File.mock.instances as MockFileInstance[];
  const inst = instances.at(-1);
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
    _name: string
  ) {
    return {
      _exists: exists,
      get exists() {
        return exists;
      },
      text: textReject ? vi.fn().mockRejectedValue(textReject) : vi.fn().mockResolvedValue(''),
      write: writeReject ? vi.fn(() => { throw writeReject; }) : vi.fn(),
      delete: deleteReject ? vi.fn(() => { throw deleteReject; }) : vi.fn(),
    };
  });
}

beforeEach(() => {
  resetPostHogStorageForTests();
  vi.clearAllMocks();
});

// ---- tests ----

describe(POSTHOG_STORAGE_FILES, () => {
  it('has two entries matching the SDK storage files', () => {
    expect(POSTHOG_STORAGE_FILES).toEqual(['.posthog-rn.json', '.posthog-rn-logs.json']);
  });
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

    it('returns the file content', async () => {
      const result = await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(lastFileInstance().text).toHaveBeenCalled();
      expect(result).toBe('');
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
      expect(lastFileInstance().write).toHaveBeenCalledWith('{"q":1}');
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
  it('starts unsealed', () => {
    expect(isPostHogStorageSealed()).toBe(false);
  });

  it('sealPostHogStorage sets the seal', () => {
    sealPostHogStorage();
    expect(isPostHogStorageSealed()).toBe(true);
  });

  it('unsealPostHogStorage clears the seal', () => {
    sealPostHogStorage();
    unsealPostHogStorage();
    expect(isPostHogStorageSealed()).toBe(false);
  });

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
      expect(lastFileInstance().write).toHaveBeenCalledWith('payload');
    });

    it('getItem reads again', async () => {
      sealPostHogStorage();
      unsealPostHogStorage();
      await posthogCustomStorage.getItem('.posthog-rn.json');
      expect(lastFileInstance().text).toHaveBeenCalled();
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

    // Every File instance had delete() called.
    for (const inst of expoFileSystemMock.File.mock.instances as MockFileInstance[]) {
      expect(inst.delete).toHaveBeenCalled();
    }
  });

  it('does not throw when files are missing (purge safety)', () => {
    sealPostHogStorage();
    // Override the default so all four File instances report exists = false.
    expoFileSystemMock.File.mockImplementation(function FileMockMissing(
      this: MockFileInstance,
      _base: string,
      _name: string
    ) {
      return {
        _exists: false,
        get exists() {
          return false;
        },
        text: vi.fn(),
        write: vi.fn(),
        delete: vi.fn(),
      };
    });

    expect(() => { purgePostHogPersistence(); }).not.toThrow();
  });

  it('swallows a delete error', () => {
    sealPostHogStorage();
    makeNextFile({ deleteReject: new Error('permission denied') });

    expect(() => { purgePostHogPersistence(); }).not.toThrow();
  });
});

describe('resetPostHogStorageForTests', () => {
  it('resets the seal', () => {
    sealPostHogStorage();
    expect(isPostHogStorageSealed()).toBe(true);

    resetPostHogStorageForTests();
    expect(isPostHogStorageSealed()).toBe(false);
  });
});
