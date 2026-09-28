import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { permissionToolLabel } from './permission-tool-label';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('permissionToolLabel', () => {
  it('maps every known tool id to its catalog name', async () => {
    await i18n.changeLanguage('en');
    expect(permissionToolLabel('read')).toBe('read');
    expect(permissionToolLabel('edit')).toBe('edit');
    expect(permissionToolLabel('write')).toBe('write');
    expect(permissionToolLabel('bash')).toBe('bash');
    expect(permissionToolLabel('glob')).toBe('glob');
    expect(permissionToolLabel('grep')).toBe('grep');
    expect(permissionToolLabel('list')).toBe('list');
    expect(permissionToolLabel('patch')).toBe('patch');
    expect(permissionToolLabel('apply_patch')).toBe('patch');
    expect(permissionToolLabel('task')).toBe('task');
  });

  it('returns an unknown id unchanged instead of capitalizing it', () => {
    expect(permissionToolLabel('webfetch')).toBe('webfetch');
    expect(permissionToolLabel('websearch')).toBe('websearch');
    expect(permissionToolLabel('codesearch')).toBe('codesearch');
    expect(permissionToolLabel('todoread')).toBe('todoread');
    expect(permissionToolLabel('todowrite')).toBe('todowrite');
    expect(permissionToolLabel('some_future_tool')).toBe('some_future_tool');
  });

  it('returns an id that names an inherited member unchanged', () => {
    // A bare object-literal index would hit `Object.prototype` here and hand
    // `i18n.t` a function instead of the fallback.
    expect(permissionToolLabel('constructor')).toBe('constructor');
    expect(permissionToolLabel('toString')).toBe('toString');
    expect(permissionToolLabel('hasOwnProperty')).toBe('hasOwnProperty');
    expect(permissionToolLabel('__proto__')).toBe('__proto__');
  });

  it('strips a tool namespace prefix before the lookup', async () => {
    await i18n.changeLanguage('en');
    expect(permissionToolLabel('file_write')).toBe('write');
    expect(permissionToolLabel('bash_read')).toBe('read');
    // Nothing known behind the prefix: fall back to the original raw id.
    expect(permissionToolLabel('file_frobnicate')).toBe('file_frobnicate');
  });

  it('renders the Serbian names the permission sentence needs', async () => {
    await i18n.changeLanguage('sr');
    expect(permissionToolLabel('bash')).toBe('bash');
    expect(permissionToolLabel('read')).toBe('čitanje');
    expect(permissionToolLabel('read')).not.toBe('Read');
  });
});
