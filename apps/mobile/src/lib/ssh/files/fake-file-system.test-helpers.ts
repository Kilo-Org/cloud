function entryUri(base: string | { uri: string }, names: readonly string[]): string {
  const root = typeof base === 'string' ? base : base.uri;
  return names.length === 0 ? root : `${root}/${names.join('/')}`;
}

function createFakeFileSystem() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const refusedDeletes = new Set<string>();
  const listing = { fails: false };

  function fileAt(uri: string) {
    return {
      uri,
      get exists() {
        return files.has(uri);
      },
      text: () => Promise.resolve(files.get(uri) ?? ''),
      delete: () => {
        if (refusedDeletes.delete(uri)) {
          throw new Error('delete refused');
        }
        files.delete(uri);
      },
    };
  }

  function File(base: string | { uri: string }, ...names: string[]) {
    return fileAt(entryUri(base, names));
  }

  function Directory(base: string | { uri: string }, ...names: string[]) {
    const uri = entryUri(base, names);
    return {
      uri,
      get exists() {
        return directories.has(uri);
      },
      create: () => {
        directories.add(uri);
      },
      list: () => {
        if (listing.fails) {
          throw new Error('unreadable directory');
        }
        const prefix = `${uri}/`;
        return [...files.keys()]
          .filter(candidate => candidate.startsWith(prefix))
          .filter(candidate => !candidate.slice(prefix.length).includes('/'))
          .map(candidate => fileAt(candidate));
      },
      delete: () => {
        directories.delete(uri);
      },
    };
  }

  return {
    files,
    directories,
    refusedDeletes,
    failListing: () => {
      listing.fails = true;
    },
    reset: () => {
      files.clear();
      directories.clear();
      refusedDeletes.clear();
      listing.fails = false;
    },
    Directory,
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
}

export const fakeFs = createFakeFileSystem();
