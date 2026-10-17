import { describe, expect, it } from 'vitest';
import { objectUrl, scopedObjectKey } from './object-key';

const PREFIX = 'user-1/app-builder/';
const SOURCE_KEY = 'user-1/app-builder/msg-1/img-1.png';

const REJECTED_SOURCE_PATHS = [
  '',
  '/msg-1/img-1.png',
  '../img-1.png',
  'msg-1/../../img-1.png',
  './img-1.png',
  'msg-1//img-1.png',
  'msg-1/',
  'msg-1%2fimg-1.png',
  '%2e%2e/img-1.png',
  '.%2e/img-1.png',
  '%2E./img-1.png',
  'msg-1\\img-1.png',
  'msg-1\u0000img-1.png',
  'msg-1/img 1.png',
  'msg-1/img-1.png?x=1',
  'msg-1/img-1.png#x',
  'msg-1/über.png',
];

const REWRITTEN_KEYS = [
  'user-1/app-builder/%2e%2e/other/secret.png',
  'user-1/app-builder/./img-1.png',
  'user-1/app-builder/img-1.png?x=1',
  'user-1/app-builder/img-1.png#x',
  'user-1/app-builder/img%zz.png',
];

describe('scopedObjectKey', () => {
  it('scopes a plain relative path to the prefix', () => {
    expect(scopedObjectKey(PREFIX, 'msg-1/img-1.png')).toBe(SOURCE_KEY);
    expect(scopedObjectKey(PREFIX, 'msg-1/nested/img-1.png')).toBe(
      'user-1/app-builder/msg-1/nested/img-1.png'
    );
  });

  it('accepts only plain relative paths', () => {
    for (const sourcePath of REJECTED_SOURCE_PATHS) {
      expect(
        () => scopedObjectKey(PREFIX, sourcePath),
        `sourcePath: ${JSON.stringify(sourcePath)}`
      ).toThrow('Access denied: invalid source path');
    }
  });
});

describe('objectUrl', () => {
  it('keeps the requested bucket and key in the request path', () => {
    expect(
      objectUrl('https://acct.r2.cloudflarestorage.com', 'attachments', SOURCE_KEY).toString()
    ).toBe(`https://acct.r2.cloudflarestorage.com/attachments/${SOURCE_KEY}`);
  });

  it('refuses a key that does not stay in the request path unchanged', () => {
    for (const key of REWRITTEN_KEYS) {
      expect(
        () => objectUrl('https://acct.r2.cloudflarestorage.com', 'attachments', key),
        `key: ${key}`
      ).toThrow(`Invalid R2 object key: ${key}`);
    }
  });
});
