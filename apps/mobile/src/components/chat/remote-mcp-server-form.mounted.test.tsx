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
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const saved: RemoteMcpServerDraft[] = [];
const onSave = (draft: RemoteMcpServerDraft): void => {
  saved.push(draft);
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function mount(props: ComponentProps<typeof RemoteMcpServerForm>): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(createElement(RemoteMcpServerForm, props));
    await Promise.resolve();
  });
}

function fields(): FieldProps[] {
  if (renderer === undefined) {
    throw new Error('not mounted');
  }
  return renderer.root
    .findAll(node => String(node.type) === 'FormField')
    .map(node => node.props as FieldProps);
}

function saveButton(): ButtonProps {
  if (renderer === undefined) {
    throw new Error('not mounted');
  }
  return renderer.root.find(node => String(node.type) === 'Button').props as ButtonProps;
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

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  saved.length = 0;
  vi.clearAllMocks();
});

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
    await type(2, 'secret');

    await pressSave();

    expect(saved).toEqual([
      {
        name: 'Remote',
        url: 'https://remote.example/mcp',
        auth: { type: 'bearer', token: 'secret' },
        enabled: true,
      },
    ]);
  });

  it('reports no token as no auth, not as an empty credential', async () => {
    await mount({ onSave });
    await type(0, 'Remote');
    await type(1, 'https://remote.example/mcp');

    await pressSave();

    expect(saved[0]?.auth).toEqual({ type: 'none' });
  });

  it('edits a server without changing its id or its switch', async () => {
    await mount({
      server: {
        id: 'remote',
        name: 'Old',
        url: 'https://remote.example/mcp',
        auth: { type: 'none' },
        enabled: false,
      },
      onSave,
    });

    expect(saveButton().disabled).toBe(false);

    await type(0, 'New');
    await pressSave();

    expect(saved).toEqual([
      {
        id: 'remote',
        name: 'New',
        url: 'https://remote.example/mcp',
        auth: { type: 'none' },
        enabled: false,
      },
    ]);
  });

  it('shows Save working while a save is in flight', async () => {
    await mount({ onSave, saving: true });

    expect(saveButton().loading).toBe(true);
  });
});
