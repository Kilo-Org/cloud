import { type ComponentProps, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteMcpServerForm } from '@/components/chat/remote-mcp-server-form';
import { type RemoteMcpServerDraft } from '@/lib/chat/remote-mcp-store';
import { act, TestRenderer } from '@/test/renderer';

/**
 * The add/edit form for a remote MCP server.
 *
 * The form is presentation only, so what it owes the sheet is three things: a
 * Save that is gated on the same rules the store enforces, an invalid field
 * that reads back a message, and the draft the person asked for — including the
 * id and the switch of the server being edited, which the form must not drop.
 */

type FieldProps = {
  readonly label: string;
  readonly defaultValue?: string;
  readonly error?: string;
  readonly onChangeText?: (value: string) => void;
  readonly validate?: (value: string) => string | null;
};

type ButtonProps = {
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress?: () => void;
};

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

const saved: RemoteMcpServerDraft[] = [];
const onSave = (draft: RemoteMcpServerDraft): void => void saved.push(draft);

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function mount(props: ComponentProps<typeof RemoteMcpServerForm>): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(createElement(RemoteMcpServerForm, props));
    await Promise.resolve();
  });
}

/** The mounted tree, for the helpers that read it. */
function mounted(): TestRenderer.ReactTestRenderer {
  if (renderer === undefined) {
    throw new Error('not mounted');
  }
  return renderer;
}

function fields(): FieldProps[] {
  return mounted()
    .root.findAll(node => String(node.type) === 'FormField')
    .map(node => node.props as FieldProps);
}

function saveButton(): ButtonProps {
  return mounted().root.find(node => String(node.type) === 'Button').props as ButtonProps;
}

/** Types into one field, the way the field's own onChangeText reports it. */
async function type(index: number, value: string): Promise<void> {
  const field = fields()[index];
  await act(async () => {
    field?.onChangeText?.(value);
    await Promise.resolve();
  });
}

async function pressSave(): Promise<void> {
  await act(async () => {
    saveButton().onPress?.();
    await Promise.resolve();
  });
}

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

type SegmentedProps = {
  readonly onChange: (value: string) => void;
};

/** Picks a sign-in method, the way the segmented control reports it. */
async function choose(method: RemoteMcpServerDraft['auth']['type']): Promise<void> {
  const control = mounted().root.find(node => String(node.type) === 'SegmentedControl')
    .props as SegmentedProps;
  await act(async () => {
    control.onChange(method);
    await Promise.resolve();
  });
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  saved.length = 0;
  vi.clearAllMocks();
  mountedTokenValues.length = 0;
});

/** A server saved with a bearer value, so an endpoint case names only its edit. */
const savedBearer = {
  id: 'remote',
  name: 'Remote',
  url: 'https://remote.example/mcp',
  auth: { type: 'bearer', token: 'secret' },
  enabled: true,
} as const;

/** A server saved with no sign-in and switched off, so the edit case names only its edit. */
const savedPlain = {
  id: 'remote',
  name: 'Old',
  url: 'https://remote.example/mcp',
  auth: { type: 'none' },
  enabled: false,
} as const;

/** The same server saved with OAuth, so the sign-in case names only its edit. */
const savedOAuth = { ...savedBearer, auth: { type: 'oauth' } } as const;

describe('the remote MCP server form', () => {
  it('gates Save until the name and the URL are there', async () => {
    await mount({ onSave });

    expect(saveButton().disabled).toBe(true);

    await type(0, 'Remote');
    expect(saveButton().disabled).toBe(true);

    await type(1, 'https://remote.example/mcp');
    expect(saveButton().disabled).toBe(false);
  });

  it('refuses a URL the store would refuse, and reads the reason back', async () => {
    await mount({ onSave });
    await type(0, 'Remote');
    await type(1, 'ftp://remote.example/mcp');

    expect(saveButton().disabled).toBe(true);
    expect(fields()[1]?.validate?.('ftp://remote.example/mcp')).toBe(
      'modelChat.mcp.fieldUrlInvalid'
    );
  });

  it('reports the draft with the token as a bearer credential', async () => {
    await mount({ onSave });
    await type(0, 'Remote');
    await type(1, 'https://remote.example/mcp');
    await choose('bearer');
    expect(saveButton().disabled).toBe(true);
    await type(2, 'secret');

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
    await type(0, 'Remote');
    await type(1, 'https://remote.example/mcp');

    await pressSave();

    expect(fields()).toHaveLength(2);
    expect(saved[0]?.auth).toEqual({ type: 'none' });
  });

  it('reports OAuth with no token field, so the sign-in happens after the save', async () => {
    await mount({ onSave });
    await type(0, 'Remote');
    await type(1, 'https://remote.example/mcp');
    await choose('oauth');

    await pressSave();

    expect(fields()).toHaveLength(2);
    expect(saved[0]?.auth).toEqual({ type: 'oauth' });
  });

  it('edits a server without changing its id or its switch', async () => {
    await mount({ server: savedPlain, onSave });

    expect(saveButton().disabled).toBe(false);

    await type(0, 'New');
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

    await type(0, 'notes');
    await type(1, 'https://notes.example/mcp');

    // Undoing the typed name clears the flag again.
    await type(0, '');

    expect(dirty[0]).toBe(true);
    expect(dirty.at(-1)).toBe(true);

    await type(1, '');
    expect(dirty.at(-1)).toBe(false);
  });

  it('keeps a typed value when the URL only respells the endpoint it was typed for', async () => {
    await mount({ server: savedBearer, onSave });

    await type(2, 'rotated');
    // Respelling the saved URL names the endpoint the value was typed for, so
    // the field keeps it and no remount puts the saved value back over it.
    await type(1, 'https://remote.example/mcp/');

    expect(mountedTokenValues).toEqual(['secret']);
    expect(saveButton().disabled).toBe(false);

    await pressSave();

    expectSavedBearer('rotated');
  });

  it('does not carry a typed value to another endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    await type(2, 'rotated');
    await type(1, 'https://two.example/mcp');

    // The value was typed for the saved endpoint, so the new one starts empty.
    expectTokenCleared();

    await type(2, 'rotated');
    await pressSave();

    expect(saved[0]?.url).toBe('https://two.example/mcp');
    expectSavedBearer('rotated');
  });

  it('does not carry a saved value that was typed and erased to another endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    // Typing a character and erasing it leaves the field showing the saved
    // value, but the value was touched, so it belongs to the endpoint the URL
    // names, not to whatever endpoint a later edit names.
    await type(2, 'secre');
    await type(2, 'secret');
    await type(1, 'https://two.example/mcp');

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

    await type(1, 'https://elsewhere.example/mcp');

    // The saved value belonged to the endpoint the form opened on, so the field
    // is empty for the endpoint it now names and Save waits for a value.
    expect(mountedTokenValues).toEqual(['secret', '']);
    expect(saveButton().disabled).toBe(true);
    expect(fields()[2]?.error).toBe('common.required');

    // Returning to the saved endpoint puts its value back, and a save that
    // enters no value reports that none was entered.
    await type(1, 'https://remote.example/mcp/');
    expect(mountedTokenValues.at(-1)).toBe('secret');
    expect(saveButton().disabled).toBe(false);
    await pressSave();
    expect(saved[0]?.tokenEntered).toBe(false);

    await type(1, 'https://elsewhere.example/mcp');
    await type(2, 'entered');
    await pressSave();

    expect(saved[1]?.url).toBe('https://elsewhere.example/mcp');
    expect(saved[1]?.auth).toEqual({ type: 'bearer', token: 'entered' });
    expect(saved[1]?.tokenEntered).toBe(true);
  });

  it('keeps a value entered for the endpoint the URL now names', async () => {
    await mount({ server: savedBearer, onSave });
    await type(1, 'https://elsewhere.example/mcp');
    expect(saveButton().disabled).toBe(true);

    // The value typed for the endpoint the URL now names belongs to that
    // endpoint, so it is reported as entered.
    await type(2, 'secret');
    expect(saveButton().disabled).toBe(false);

    await pressSave();
    expectSavedBearer('secret');
  });

  it('keeps a value typed while the URL names no endpoint', async () => {
    await mount({ server: savedBearer, onSave });

    // The URL names nothing while the person retypes it, and a value typed
    // then is theirs: it belongs to the endpoint the URL then names, so the
    // field keeps it rather than being cleared or restored over.
    await type(1, '');
    await type(2, 'typed');
    await type(1, 'https://two.example/mcp');

    expect(mountedTokenValues).toEqual(['secret', '']);
    expect(saveButton().disabled).toBe(false);

    await pressSave();

    expect(saved[0]?.url).toBe('https://two.example/mcp');
    expectSavedBearer('typed');
  });

  it('keeps a token typed while adding a server', async () => {
    await mount({ onSave });

    await type(0, 'Remote');
    await choose('bearer');
    await type(2, 'secret');
    await type(1, 'https://remote.example/mcp');

    await pressSave();

    expect(saved[0]?.url).toBe('https://remote.example/mcp');
    expect(saved[0]?.auth).toEqual({ type: 'bearer', token: 'secret' });
  });

  it('reports only the name and token edits the saved draft keeps', async () => {
    const dirty: boolean[] = [];
    await mount({ server: savedBearer, onSave, onDirtyChange: value => void dirty.push(value) });

    await type(2, 'another');
    expect(dirty.at(-1)).toBe(true);

    await type(2, 'secret');
    expect(dirty.at(-1)).toBe(false);

    // Whitespace the saved draft trims away is not an edit.
    await type(0, 'Remote ');
    expect(dirty.at(-1)).toBe(false);

    await type(2, ' secret ');
    expect(dirty.at(-1)).toBe(false);

    await type(2, 'secret2');
    expect(dirty.at(-1)).toBe(true);
  });

  it('drops a bearer token from the dirty check when an OAuth server is left selected', async () => {
    const dirty: boolean[] = [];
    await mount({ server: savedOAuth, onSave, onDirtyChange: value => void dirty.push(value) });

    // A bearer token typed on the way past must not outlive the bearer method.
    await choose('bearer');
    await type(2, 'secret-token');
    expect(dirty.at(-1)).toBe(true);

    await choose('oauth');
    expect(dirty.at(-1)).toBe(false);
  });
});
