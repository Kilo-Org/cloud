import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { credentialForm, type ModelMapping } from '@/lib/byok/credential-fields';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { ProviderKeyCredentialForm } from './provider-key-credential-form';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/icons', () => ({ Plus: 'Plus', X: 'X' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#888' }),
}));

let renderer: ReactTestRenderer | undefined = undefined;
const onEdit = vi.fn();

async function mount(
  providerId: string,
  mode: 'apiKey' | 'accessKeys',
  mappings?: { current: Map<number, Partial<ModelMapping>> }
) {
  const form = credentialForm(providerId, mode);
  if (!form) {
    throw new Error(`no structured form for ${providerId}`);
  }
  const created: { mounted?: ReactTestRenderer } = {};
  await act(() => {
    created.mounted = TestRenderer.create(
      createElement(ProviderKeyCredentialForm, {
        form,
        mode,
        onModeChange: () => undefined,
        onEdit: () => {
          onEdit();
        },
        disabled: false,
        values: { current: {} },
        mappings: mappings ?? { current: new Map() },
        errors: {},
      })
    );
  });
  const mounted = created.mounted;
  if (!mounted) {
    throw new Error('not mounted');
  }
  renderer = mounted;
  return mounted.root;
}

function field(root: ReactTestRenderer['root'], labelKey: string) {
  const hit = root
    .findAll(node => Object.is(node.type, 'FormField'))
    .find(node => node.props.label === labelKey);
  if (!hit) {
    throw new Error(`missing ${labelKey}`);
  }
  return hit;
}

/** The props every credential input must carry, whatever it holds. */
function expectNoLearning(props: Record<string, unknown>): void {
  expect(props.autoCapitalize).toBe('none');
  expect(props.autoCorrect).toBe(false);
  expect(props.autoComplete).toBe('off');
  expect(props.spellCheck).toBe(false);
  expect(props.importantForAutofill).toBe('no');
  expect(props.textContentType).toBe('none');
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  onEdit.mockClear();
});

describe('ProviderKeyCredentialForm secret inputs', () => {
  it('reports every typed value as an edit', async () => {
    const root = await mount('azure', 'apiKey');
    for (const labelKey of [
      'profile.providerKeys.apiKeyLabel',
      'profile.providerKeys.resourceName',
    ]) {
      act(() => {
        (field(root, labelKey).props.onChangeText as (value: string) => void)('typed');
      });
    }

    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it('registers each added mapping row in the order it is shown', async () => {
    const mappings: { current: Map<number, Partial<ModelMapping>> } = { current: new Map() };
    const root = await mount('azure', 'apiKey', mappings);
    const addMapping = () => {
      const [button] = root.findAll(node => Object.is(node.type, 'Button')).slice(-1);
      if (!button) {
        throw new Error('missing the add-mapping button');
      }
      act(() => {
        (button.props.onPress as () => void)();
      });
    };

    addMapping();
    addMapping();

    // The draft holds every row on screen, empty or not: a refusal names a row
    // by the number the form prints, and an untouched row above it still counts.
    expect([...mappings.current.entries()]).toEqual([
      [0, {}],
      [1, {}],
    ]);
  });

  it('masks Azure’s key and never suggests or learns from it', async () => {
    const root = await mount('azure', 'apiKey');
    const key = field(root, 'profile.providerKeys.apiKeyLabel');

    expect(key.props.secureTextEntry).toBe(true);
    expect(key.props.multiline).toBe(false);
    expect(key.props.keyboardType).toBeUndefined();
    expectNoLearning(key.props);

    const resource = field(root, 'profile.providerKeys.resourceName');
    expect(resource.props.secureTextEntry).toBe(false);
    expectNoLearning(resource.props);
  });

  it('masks both Bedrock key fields and the API key', async () => {
    const root = await mount('bedrock', 'accessKeys');

    expect(field(root, 'profile.providerKeys.secretAccessKey').props.secureTextEntry).toBe(true);
    expect(field(root, 'profile.providerKeys.accessKeyId').props.secureTextEntry).toBe(false);
    for (const labelKey of [
      'profile.providerKeys.accessKeyId',
      'profile.providerKeys.secretAccessKey',
      'profile.providerKeys.region',
    ]) {
      expectNoLearning(field(root, labelKey).props);
    }

    const keyMode = await mount('bedrock', 'apiKey');
    expect(field(keyMode, 'profile.providerKeys.apiKeyLabel').props.secureTextEntry).toBe(true);
  });

  it('masks the Vertex private key and keeps it suggestion-free', async () => {
    const root = await mount('vertex', 'apiKey');
    const privateKey = field(root, 'profile.providerKeys.privateKey');

    // Neither platform masks a multiline input. Android takes no soft-keyboard
    // input for it at all; iOS opens its keyboard because that prop is
    // Android-only, so the PEM is visible there while typed and the rest of the
    // props are what keep the keyboard from suggesting or learning it.
    expect(privateKey.props.multiline).toBe(true);
    expect(privateKey.props.secureTextEntry).toBe(true);
    expect(privateKey.props.showSoftInputOnFocus).toBe(false);
    expect(privateKey.props.placeholder).toBe('profile.providerKeys.apiKeyPlaceholder');
    expectNoLearning(privateKey.props);

    const project = field(root, 'profile.providerKeys.project');
    expect(project.props.secureTextEntry).toBe(false);
    expect(project.props.keyboardType).toBeUndefined();
    expectNoLearning(project.props);
  });
});
