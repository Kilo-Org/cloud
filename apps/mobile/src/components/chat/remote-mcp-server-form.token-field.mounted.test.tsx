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
 * The token field of the remote MCP server form: what it shows, what a save
 * sends, and when it is mounted again.
 *
 * The field is uncontrolled and its text lives in the form's ref, so a
 * keystroke never remounts it — the field already shows what was typed, and a
 * remount would drop the caret. Only a programmatic replacement of that text
 * remounts it: a URL that retargets the field, and the saved endpoint putting
 * its value back. A value belongs to the endpoint the URL named when it was
 * typed, and it never travels to another one. The form's own field, gating and
 * draft contract lives in `remote-mcp-server-form.mounted.test.tsx`.
 */

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The real field writes `defaultValue` once, on attach, so the form's clearing
// and restoring depend on a keyed remount. This mock records the value each
// token field instance attached with, which is what the form's key changes.
// The factory is hoisted above the file's imports, so React can only come from
// a dynamic import here.
vi.mock('@/components/ui/form-field', async () => {
  const React = await import('react');
  return {
    FormField: (props: FieldProps) => {
      const attached = React.useRef<string | null>(null);
      if (attached.current === null) {
        attached.current = props.defaultValue ?? '';
        if (props.label === 'modelChat.mcpOAuth.fieldToken') {
          mountedTokenValues.push(attached.current);
        }
      }
      return React.createElement('FormField', props);
    },
  };
});
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));

const { mountedTokenValues } = vi.hoisted(() => ({ mountedTokenValues: [] as string[] }));

afterEach(() => {
  resetForm();
  vi.clearAllMocks();
  mountedTokenValues.length = 0;
});

/** The token field was cleared for an endpoint the value does not belong to. */
function expectTokenCleared(): void {
  expect(mountedTokenValues.at(-1)).toBe('');
  expect(fields()[2]?.error).toBe('common.required');
  expect(saveButton().disabled).toBe(true);
}

/** The save reported the bearer value the person typed, as entered by them. */
function expectSavedBearer(token: string): void {
  expect(saved[0]?.auth).toEqual({ type: 'bearer', token });
  expect(saved[0]?.tokenEntered).toBe(true);
}

/** A server saved with a bearer value, so an endpoint case names only its edit. */
const savedBearer = {
  id: 'remote',
  name: 'Remote',
  url: 'https://remote.example/mcp',
  auth: { type: 'bearer', token: 'secret' },
  enabled: true,
} as const;

/** The same server saved with OAuth, so the sign-in case names only its edit. */
const savedOAuth = { ...savedBearer, auth: { type: 'oauth' } } as const;

describe('the remote MCP server form token field', () => {
  it('keeps a typed value when the URL only respells the endpoint it was typed for', async () => {
    await mount({ server: savedBearer, onSave });

    await typeInto(2, 'rotated');
    // Respelling the saved URL names the endpoint the value was typed for, so
    // the field keeps it and no remount puts the saved value back over it.
    await typeInto(1, 'https://remote.example/mcp/');

    expect(mountedTokenValues).toEqual(['secret']);
    expect(saveButton().disabled).toBe(false);

    await pressSave();

    expectSavedBearer('rotated');
  });

  it('shows and saves the typed token after the sign-in method is switched away and back', async () => {
    /* Choosing another method unmounts the token field; choosing Bearer again
       mounts a new one. What it shows then is the value the save sends — a form
       that shows the saved token and sends the typed one saves a credential the
       person cannot see. */
    await mount({ server: savedBearer, onSave });

    await typeInto(2, 'rotated');
    await choose('oauth');
    await choose('bearer');

    expect(mountedTokenValues).toEqual(['secret', 'rotated']);
    expect(fields()[2]?.defaultValue).toBe('rotated');
    expect(saveButton().disabled).toBe(false);

    await pressSave();
    expectSavedBearer('rotated');
  });

  it('does not remount the token field while the person types', async () => {
    await mount({ server: savedBearer, onSave });

    await typeInto(2, 'a');
    await typeInto(2, 'ab');
    await typeInto(2, 'abc');

    // The field is uncontrolled and already shows what was typed; remounting it
    // on a keystroke would drop the caret and the rest of the value.
    expect(mountedTokenValues).toEqual(['secret']);
    expect(fields()[2]?.defaultValue).toBe('secret');
  });

  it('does not carry a typed value to another endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    await typeInto(2, 'rotated');
    await typeInto(1, 'https://two.example/mcp');

    // The value was typed for the saved endpoint, so the new one starts empty.
    expectTokenCleared();

    await typeInto(2, 'rotated');
    await pressSave();

    expect(saved[0]?.url).toBe('https://two.example/mcp');
    expectSavedBearer('rotated');
  });

  it('does not carry a saved value that was typed and erased to another endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    // Typing a character and erasing it leaves the field showing the saved
    // value, but the value was touched, so it belongs to the endpoint the URL
    // names, not to whatever endpoint a later edit names.
    await typeInto(2, 'secre');
    await typeInto(2, 'secret');
    await typeInto(1, 'https://two.example/mcp');

    expectTokenCleared();
    await pressSave();
    expect(saved).toEqual([]);

    // A draft the new endpoint can save says no value was entered for it.
    await choose('none');
    await pressSave();
    expect(saved[0]?.url).toBe('https://two.example/mcp');
    expect(saved[0]?.tokenEntered).toBe(false);
  });

  it('asks for the token again when the URL names another endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    await typeInto(1, 'https://elsewhere.example/mcp');

    // The saved value belonged to the endpoint the form opened on, so the field
    // is empty for the endpoint it now names and Save waits for a value.
    expect(mountedTokenValues).toEqual(['secret', '']);
    expect(saveButton().disabled).toBe(true);
    expect(fields()[2]?.error).toBe('common.required');

    // Returning to the saved endpoint puts its value back, and a save that
    // enters no value reports that none was entered.
    await typeInto(1, 'https://remote.example/mcp/');
    expect(mountedTokenValues.at(-1)).toBe('secret');
    expect(saveButton().disabled).toBe(false);
    await pressSave();
    expect(saved[0]?.tokenEntered).toBe(false);

    await typeInto(1, 'https://elsewhere.example/mcp');
    await typeInto(2, 'entered');
    await pressSave();

    expect(saved[1]?.url).toBe('https://elsewhere.example/mcp');
    expect(saved[1]?.auth).toEqual({ type: 'bearer', token: 'entered' });
    expect(saved[1]?.tokenEntered).toBe(true);
  });

  it('keeps a value entered for the endpoint the URL now names', async () => {
    await mount({ server: savedBearer, onSave });
    await typeInto(1, 'https://elsewhere.example/mcp');
    expect(saveButton().disabled).toBe(true);

    // The value typed for the endpoint the URL now names belongs to that
    // endpoint, so it is reported as entered.
    await typeInto(2, 'secret');
    expect(saveButton().disabled).toBe(false);

    await pressSave();
    expectSavedBearer('secret');
  });

  it('keeps a value typed while the URL names no endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    // The URL names nothing while the person retypes it, and a value typed
    // then is theirs: it belongs to the endpoint the URL then names, so the
    // field keeps it rather than being cleared or restored over.
    await typeInto(1, '');
    await typeInto(2, 'typed');
    await typeInto(1, 'https://two.example/mcp');

    expect(mountedTokenValues).toEqual(['secret', '']);
    expect(saveButton().disabled).toBe(false);

    await pressSave();

    expect(saved[0]?.url).toBe('https://two.example/mcp');
    expectSavedBearer('typed');
  });

  it('keeps a token typed while adding a server', async () => {
    await mount({ onSave });

    await typeInto(0, 'Remote');
    await choose('bearer');
    await typeInto(2, 'secret');
    await typeInto(1, 'https://remote.example/mcp');

    await pressSave();

    expect(saved[0]?.url).toBe('https://remote.example/mcp');
    expect(saved[0]?.auth).toEqual({ type: 'bearer', token: 'secret' });
  });

  it('reports only the name and token edits the saved draft keeps', async () => {
    const dirty: boolean[] = [];
    await mount({ server: savedBearer, onSave, onDirtyChange: value => void dirty.push(value) });

    await typeInto(2, 'another');
    expect(dirty.at(-1)).toBe(true);

    await typeInto(2, 'secret');
    expect(dirty.at(-1)).toBe(false);

    // Whitespace the saved draft trims away is not an edit.
    await typeInto(0, 'Remote ');
    expect(dirty.at(-1)).toBe(false);

    await typeInto(2, ' secret ');
    expect(dirty.at(-1)).toBe(false);

    await typeInto(2, 'secret2');
    expect(dirty.at(-1)).toBe(true);
  });

  it('drops a bearer token from the dirty check when an OAuth server is left selected', async () => {
    const dirty: boolean[] = [];
    await mount({ server: savedOAuth, onSave, onDirtyChange: value => void dirty.push(value) });

    // A bearer token typed on the way past must not outlive the bearer method.
    await choose('bearer');
    await typeInto(2, 'secret-token');
    expect(dirty.at(-1)).toBe(true);

    await choose('oauth');
    expect(dirty.at(-1)).toBe(false);
  });
});
