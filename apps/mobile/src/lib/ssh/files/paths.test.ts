import { type SftpEntry } from '@kilocode/react-native-ssh';
import { describe, expect, it } from 'vitest';

import {
  breadcrumbTrail,
  fileNameOf,
  joinRemotePath,
  MAX_PREVIEW_BYTES,
  parentRemotePath,
  previewKindOf,
  sortEntries,
} from './paths';

const entry = (name: string, kind: SftpEntry['kind'], size = 0): SftpEntry => ({
  name,
  kind,
  size,
  modifiedUnix: 1_700_000_000,
  permissions: 0o644,
});

describe('remote paths', () => {
  it('joins a directory and a name, including the root', () => {
    expect(joinRemotePath('/home/user', 'notes.txt')).toBe('/home/user/notes.txt');
    expect(joinRemotePath('/home/user/', 'notes.txt')).toBe('/home/user/notes.txt');
    expect(joinRemotePath('/', '.ssh')).toBe('/.ssh');
  });

  it('walks to the parent, and the root is its own parent', () => {
    expect(parentRemotePath('/home/user/app')).toBe('/home/user');
    expect(parentRemotePath('/home')).toBe('/');
    expect(parentRemotePath('/')).toBe('/');
  });

  it('names one crumb per segment', () => {
    expect(breadcrumbTrail('/home/user')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'user', path: '/home/user' },
    ]);
    expect(breadcrumbTrail('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('reads the file name of a remote path', () => {
    expect(fileNameOf('/home/user/report.csv')).toBe('report.csv');
    expect(fileNameOf('/home/user/')).toBe('user');
  });
});

describe('directory order', () => {
  it('puts directories first, then names case-insensitively', () => {
    const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
    const sorted = sortEntries(
      [
        entry('b.txt', 'file'),
        entry('Zeta', 'directory'),
        entry('a.txt', 'file'),
        entry('Alpha', 'directory'),
      ],
      collator
    );

    expect(sorted.map(item => item.name)).toEqual(['Alpha', 'Zeta', 'a.txt', 'b.txt']);
  });
});

describe('preview choice', () => {
  it('previews images and small text files in place', () => {
    expect(previewKindOf(entry('photo.png', 'file'))).toBe('image');
    expect(previewKindOf(entry('notes.md', 'file', 100))).toBe('text');
  });

  it('refuses a text file above the preview limit', () => {
    expect(previewKindOf(entry('dump.log', 'file', MAX_PREVIEW_BYTES + 1))).toBeNull();
  });

  it('refuses directories and unknown extensions', () => {
    expect(previewKindOf(entry('app', 'directory'))).toBeNull();
    expect(previewKindOf(entry('archive.bin', 'file', 10))).toBeNull();
  });
});
