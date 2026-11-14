import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  choose,
  type FieldProps,
  fields,
  mount,
  onSave,
  pressSave,
  resetForm,
  saveButton,
  saved,
  typeInto,
} from '@/components/chat/remote-mcp-server-form.test-helpers';

/**
 * The add/edit form for a remote MCP server.
 *
 * The form is presentation only, so what it owes the sheet is three things: a
 * Save that is gated on the same rules the store enforces, an invalid field
 * that reads back a message, and the draft the person asked for — including the
 * id and the switch of the server being edited, which the form must not drop.
 *
 * The token field's own contract — what it shows, what it keeps, and when it is
 * mounted again — lives in `remote-mcp-server-form.token-field.mounted.test.tsx`.
 */

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The real field loads a native input and a form engine; the form only reports
// its `defaultValue` once, so a host node with the same props is the whole
// surface these cases read. The factory is hoisted above this file's imports,
// so React can only come from a dynamic import here.
vi.mock('@/components/ui/form-field', async () => {
  const React = await import('react');
  return { FormField: (props: FieldProps) => React.createElement('FormField', props) };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));

afterEach(() => {
  resetForm();
  vi.clearAllMocks();
});

/** A server saved with no sign-in and switched off, so the edit case names only its edit. */
const savedPlain = {
  id: 'remote',
  name: 'Old',
  url: 'https://remote.example/mcp',
  auth: { type: 'none' },
  enabled: false,
} as const;

describe('the remote MCP server form', () => {
  it('gates Save until the name and the URL are there', async () => {
    await mount({ onSave });

    expect(saveButton().disabled).toBe(true);

    await typeInto(0, 'Remote');
    expect(saveButton().disabled).toBe(true);

    await typeInto(1, 'https://remote.example/mcp');
    expect(saveButton().disabled).toBe(false);
  });

  it('refuses a URL the store would refuse, and reads the reason back', async () => {
    await mount({ onSave });
    await typeInto(0, 'Remote');
    await typeInto(1, 'ftp://remote.example/mcp');

    expect(saveButton().disabled).toBe(true);
    expect(fields()[1]?.validate?.('ftp://remote.example/mcp')).toBe(
      'modelChat.mcp.fieldUrlInvalid'
    );
  });

  it('reports the draft with the token as a bearer credential', async () => {
    await mount({ onSave });
    await typeInto(0, 'Remote');
    await typeInto(1, 'https://remote.example/mcp');
    await choose('bearer');
    expect(saveButton().disabled).toBe(true);
    await typeInto(2, 'secret');

    await pressSave();

    expect(saved).toEqual([
      {
        name: 'Remote',
        url: 'https://remote.example/mcp',
        auth: { type: 'bearer', token: 'secret' },
        enabled: true,
        tokenEntered: true,
      },
    ]);
  });

  it('reports no sign-in by default, with no token field', async () => {
    await mount({ onSave });
    await typeInto(0, 'Remote');
    await typeInto(1, 'https://remote.example/mcp');

    await pressSave();

    expect(fields()).toHaveLength(2);
    expect(saved[0]?.auth).toEqual({ type: 'none' });
  });

  it('reports OAuth with no token field, so the sign-in happens after the save', async () => {
    await mount({ onSave });
    await typeInto(0, 'Remote');
    await typeInto(1, 'https://remote.example/mcp');
    await choose('oauth');

    await pressSave();

    expect(fields()).toHaveLength(2);
    expect(saved[0]?.auth).toEqual({ type: 'oauth' });
  });

  it('edits a server without changing its id or its switch', async () => {
    await mount({ server: savedPlain, onSave });

    expect(saveButton().disabled).toBe(false);

    await typeInto(0, 'New');
    await pressSave();

    expect(saved).toEqual([{ ...savedPlain, name: 'New', tokenEntered: false }]);
  });

  it('shows Save working while a save is in flight', async () => {
    await mount({ onSave, saving: true });

    expect(saveButton().loading).toBe(true);
  });

  it('reports unsaved edits to the sheet, and clears the report when they are undone', async () => {
    const dirty: boolean[] = [];
    await mount({
      onSave,
      onDirtyChange: value => {
        dirty.push(value);
      },
    });

    await typeInto(0, 'notes');
    await typeInto(1, 'https://notes.example/mcp');

    // Undoing the typed name clears the flag again.
    await typeInto(0, '');

    expect(dirty[0]).toBe(true);
    expect(dirty.at(-1)).toBe(true);

    await typeInto(1, '');
    expect(dirty.at(-1)).toBe(false);
  });
});
