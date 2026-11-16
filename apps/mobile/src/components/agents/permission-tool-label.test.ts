import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { permissionToolLabel } from './permission-tool-label';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

/** Every permission id a CLI can put in a request, with its English subject. */
const KNOWN_SUBJECTS = [
  ['read', 'read'],
  ['edit', 'edit'],
  ['write', 'write'],
  ['bash', 'bash'],
  ['glob', 'glob'],
  ['grep', 'grep'],
  ['list', 'list'],
  ['patch', 'patch'],
  ['apply_patch', 'patch'],
  ['task', 'task'],
  ['webfetch', 'fetching a web page'],
  ['websearch', 'searching online'],
  ['codesearch', 'searching code'],
  ['todoread', 'todo list'],
  ['todowrite', 'todo list'],
  ['skill', 'skill loading'],
  ['lsp', 'language server access'],
  ['browser_open', 'browser access'],
  ['notebook_read', 'notebook access'],
  ['notebook_edit', 'notebook access'],
  ['notebook_execute', 'notebook access'],
  ['board_read', 'board access'],
  ['board_post', 'board access'],
  ['question', 'asking you questions'],
  ['suggest', 'suggestions'],
  ['recall', 'memory recall'],
  ['repo_clone', 'repository cloning'],
  ['repo_overview', 'repository overview'],
  ['semantic_search', 'semantic search'],
  ['external_directory', 'access to an external directory'],
  ['doom_loop', 'repeated tool calls'],
  ['agent_manager', 'agent management'],
  ['sandbox_escalation', 'host access'],
] as const;

describe('permissionToolLabel', () => {
  it.each(KNOWN_SUBJECTS)('names the %s permission for the allow sentence', async (id, label) => {
    await i18n.changeLanguage('en');
    expect(permissionToolLabel(id)).toBe(label);
  });

  it('returns an unknown id unchanged instead of capitalizing it', () => {
    expect(permissionToolLabel('some_future_tool')).toBe('some_future_tool');
    // A config-only id the CLI never asks about stays a raw fallback.
    expect(permissionToolLabel('markdown_source')).toBe('markdown_source');
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
    // The reported subject is translated, never the machine id.
    expect(permissionToolLabel('external_directory')).not.toBe('external_directory');
  });
});
