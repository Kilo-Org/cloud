/* eslint-disable max-lines -- one suite covers the form's states, the organization boundary, both credential shapes and the save failures. */
// eslint-disable-next-line import/no-nodejs-modules -- test-only fixture: a real key, because the form refuses anything else
import { generateKeyPairSync } from 'node:crypto';

import { createElement, type ElementType } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  BYOK_PROVIDER_UNAVAILABLE_MESSAGE,
  MANAGED_KEY_PROVIDER_OCCUPIED_MESSAGE,
  MANAGED_KEY_READ_ONLY_MESSAGE,
} from '@kilocode/app-shared/byok-errors';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { type ModelMapping } from '@/lib/byok/credential-fields';

import { ProviderKeyNewScreen } from './provider-key-new-screen';
import type * as ReactQuery from '@tanstack/react-query';

/**
 * A real key: the Vertex form refuses a private key that is not a PEM, so a
 * placeholder value would never reach the create call this suite asserts.
 */
const { privateKey: fixtureKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedKey = fixtureKey.export({ type: 'pkcs8', format: 'pem' });
const PEM_KEY = typeof exportedKey === 'string' ? exportedKey : exportedKey.toString('utf8');

type MutationOptions = { kind?: 'create' | 'update' };

type ScreenState = {
  params: Record<string, string>;
  providers: { id: string; name: string }[];
  error: boolean;
  role: string | undefined;
  mutateAsync: Mock;
  dismissTo: Mock;
};

type RemovalHandler = (options: { data: { action: { type: string } }; repeat: () => void }) => void;

const ORG_ID = '6f1c2f9a-0d3b-4a55-9c1e-2b8f7c4d5e60';
const KEY_ID = '2b8f7c4d-5e60-4a55-9c1e-6f1c2f9a0d3b';

const state = vi.hoisted((): ScreenState => ({
  params: {},
  providers: [],
  error: false,
  role: 'owner',
  mutateAsync: vi.fn(),
  dismissTo: vi.fn(),
}));

/**
 * The leave guard's registration, recorded the way the navigator would read it:
 * the flag the screen asked for and the handler a removal reaches. `confirm`
 * stands in for the discard prompt, which the guard must never raise here.
 */
const guard = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as RemovalHandler | undefined,
  confirm: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => state.params,
  useRouter: () => ({ dismissTo: state.dismissTo }),
  usePreventRemove: (enabled: boolean, handler: RemovalHandler) => {
    guard.enabled = enabled;
    guard.handler = handler;
  },
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // hooks the screen calls are replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQuery: () => ({
      data: state.providers,
      isPending: false,
      isError: state.error,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useMutation: (options: MutationOptions) => ({
      mutateAsync: (input: unknown) => state.mutateAsync(options.kind, input),
      isPending: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    role: state.role,
    // The hook reads `org` from the same membership entry it reads the role
    // from, so a role is exactly what makes the organization resolve.
    org: state.role === undefined ? undefined : { organizationId: ORG_ID, role: state.role },
    isResolving: false,
  }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    byok: {
      listProviders: { queryOptions: () => ({}), queryKey: () => [] },
      list: { queryKey: () => [] },
      create: { mutationOptions: (options: MutationOptions) => ({ ...options, kind: 'create' }) },
      update: { mutationOptions: (options: MutationOptions) => ({ ...options, kind: 'update' }) },
    },
  }),
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: guard.confirm, dialog: null }),
}));
vi.mock('@/components/account/provider-key-credential-form', () => ({
  ProviderKeyCredentialForm: 'CredentialForm',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: 'OrganizationBoundary',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));

const FIELD = 'FormField' as ElementType;
const BUTTON = 'Button' as ElementType;
const CREDENTIAL_FORM = 'CredentialForm' as ElementType;

/** A tRPC client rejection, carrying the `data.code` the screen reads. */
function serverRefusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code, message } });
}

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ProviderKeyNewScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function statusMessages(root: ReactTestRenderer['root']) {
  return root
    .findAll(node => Object.is(node.type, 'AccessibleStatus'))
    .map(node => node.props.message);
}

function apiKeyField(root: ReactTestRenderer['root']) {
  const [field] = root.findAll(node => Object.is(node.type, FIELD));
  if (!field) {
    throw new Error('missing API key field');
  }
  return field;
}

function credentialForm(root: ReactTestRenderer['root']) {
  const [form] = root.findAll(node => Object.is(node.type, CREDENTIAL_FORM));
  if (!form) {
    throw new Error('missing the structured credential form');
  }
  return {
    values: form.props.values as { current: Record<string, string> },
    form: form.props.form as { kind: string },
    mappings: form.props.mappings as { current: Map<number, Partial<ModelMapping>> },
    onModeChange: form.props.onModeChange as (mode: string) => void,
    onEdit: form.props.onEdit as () => void,
    errors: form.props.errors as Record<string, string | undefined>,
  };
}

function allButtons(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, BUTTON));
}

function addButton(root: ReactTestRenderer['root']) {
  const all = allButtons(root);
  const last = all.at(-1);
  if (!last) {
    throw new Error('missing the submit button');
  }
  return last;
}

function retryButton(root: ReactTestRenderer['root']) {
  return allButtons(root).find(
    node => node.findAll(child => child.props.children === 'Retry').length > 0
  );
}

async function submitKey(root: ReactTestRenderer['root'], key: string) {
  act(() => {
    (apiKeyField(root).props.onChangeText as (value: string) => void)(key);
  });
  await act(async () => {
    (addButton(root).props.onPress as () => void)();
    // A save that lands leaves through the guard, which schedules its pop one
    // task after the disarm render. This tick is queued before that one, so the
    // second tick is what carries the pop out.
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Press Add key and leave the request unsettled, so the screen renders its
 * pending state. The returned `resolve` lands the save the way the server would.
 */
async function submitKeyPending(root: ReactTestRenderer['root'], key: string) {
  const deferred = Promise.withResolvers<undefined>();
  state.mutateAsync.mockReturnValueOnce(deferred.promise);
  act(() => {
    (apiKeyField(root).props.onChangeText as (value: string) => void)(key);
  });
  // The press starts an async `submit`; the state write it makes inside the
  // first await resolves before the promise the request holds.
  await act(async () => {
    (addButton(root).props.onPress as () => void)();
    await Promise.resolve();
  });
  return {
    resolve: async () => {
      await act(async () => {
        deferred.resolve(undefined);
        await Promise.resolve();
      });
    },
  };
}

/** Hand the guard the removal a Back press produces. */
function pressBack() {
  const handler = guard.handler;
  if (!handler) {
    throw new Error('the guard did not register a removal handler');
  }
  const repeat = vi.fn();
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        repeat();
      },
    });
  });
  return repeat;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.params = { provider: 'anthropic' };
  state.providers = [{ id: 'anthropic', name: 'Anthropic' }];
  state.error = false;
  state.role = 'owner';
  state.mutateAsync.mockReset();
  state.mutateAsync.mockResolvedValue(undefined);
  state.dismissTo.mockClear();
  guard.enabled = false;
  guard.handler = undefined;
  guard.confirm.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ProviderKeyNewScreen', () => {
  it('names the chosen provider in the header subtitle and masks the key field', async () => {
    const root = await mount();

    // The provider is the header's subtitle, not a body line that read as a
    // field label with no field under it.
    const [header] = root.findAll(node => Object.is(node.type, 'ScreenHeader'));
    expect(header?.props.subtitle).toBe('Anthropic');
    expect(
      root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children)
    ).not.toContain('Anthropic');
    expect(apiKeyField(root).props.secureTextEntry).toBe(true);
  });

  it('sends the provider and the trimmed key once', async () => {
    const root = await mount();

    await submitKey(root, '  sk-test-123  ');

    expect(state.mutateAsync).toHaveBeenCalledWith('create', {
      provider_id: 'anthropic',
      api_key: 'sk-test-123',
    });
  });

  it('sends the organization when it adds a key to one', async () => {
    state.params = { provider: 'anthropic', org: ORG_ID };
    const root = await mount();

    await submitKey(root, 'sk-org-key');

    expect(state.mutateAsync).toHaveBeenCalledWith('create', {
      organizationId: ORG_ID,
      provider_id: 'anthropic',
      api_key: 'sk-org-key',
    });
  });

  it('refuses to submit an empty key', async () => {
    const root = await mount();

    await submitKey(root, '   ');

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(statusMessages(root)).toEqual(['Enter the key.']);
  });

  it('reports a refused key in place and stays on the form', async () => {
    state.mutateAsync.mockRejectedValueOnce({
      data: { code: 'BAD_REQUEST', message: 'That key was rejected by the provider' },
    });
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual(['The key could not be saved.']);
    expect(state.dismissTo).not.toHaveBeenCalled();
    // A refusal of the value itself offers no retry: the same value would be
    // refused again, so the reader has to change it.
    expect(retryButton(root)).toBeUndefined();
  });

  it('offers a retry when the save failed for a reason that can change', async () => {
    state.mutateAsync.mockRejectedValueOnce(new Error('The network dropped the request'));
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    // The transport text is not the reader's copy: the state offers a retry and
    // says so in the app's own words.
    expect(statusMessages(root)).toEqual(['Could not save the key.']);
    expect(retryButton(root)).toBeDefined();
  });

  it('names a duplicate key instead of quoting the refusal', async () => {
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('CONFLICT', 'A key for this provider already exists')
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual([
      'You already have a key for this provider. Remove it before you add another.',
    ]);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('reports a key the provider format rejects', async () => {
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('UNPROCESSABLE_CONTENT', 'The key does not match the provider format')
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual([
      'This key is not in the format this provider expects. Check it and try again.',
    ]);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('reports a managed key refused with a conflict as read-only, not as a duplicate', async () => {
    // The update route reuses `CONFLICT` for a plan-managed key, so the edit
    // path is the one that reaches this refusal; the screen must match the
    // shared sentence rather than the code alone.
    state.params = { provider: 'anthropic', id: KEY_ID };
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('CONFLICT', MANAGED_KEY_READ_ONLY_MESSAGE)
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(state.mutateAsync).toHaveBeenCalledWith(
      'update',
      expect.objectContaining({ id: KEY_ID })
    );
    expect(statusMessages(root)).toEqual([
      "A coding plan manages this provider's key, and the key is read-only. Cancel the coding plan to add your own.",
    ]);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('reports a provider key the coding plan manages as read-only', async () => {
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('PRECONDITION_FAILED', MANAGED_KEY_PROVIDER_OCCUPIED_MESSAGE)
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual([
      "A coding plan manages this provider's key, and the key is read-only. Cancel the coding plan to add your own.",
    ]);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('answers an unrelated precondition refusal with the generic refused copy', async () => {
    // `PRECONDITION_FAILED` alone also covers other refusals, so the screen
    // matches the sentence both sides share rather than the code alone.
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('PRECONDITION_FAILED', 'The account is not ready for this key')
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual(['The key could not be saved.']);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('reports a provider the server has not opened as unavailable, not as a retry', async () => {
    // The refusal is matched on the sentence both sides share, so the screen
    // needs no provider id of its own to recognise it.
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('FORBIDDEN', BYOK_PROVIDER_UNAVAILABLE_MESSAGE)
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual([
      'This provider is not available yet, so you cannot add a key for it.',
    ]);
    expect(retryButton(root)).toBeUndefined();
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('keeps the generic copy for a permission denial that is not the unavailable provider', async () => {
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('FORBIDDEN', 'You cannot write this key')
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    // `FORBIDDEN` alone does not mean the provider is unavailable, so the
    // server's sentence is replaced rather than repeated.
    expect(statusMessages(root)).toEqual(['The key could not be saved.']);
    expect(state.dismissTo).not.toHaveBeenCalled();
  });

  it('reports a store failure in its own words for a server fault', async () => {
    state.mutateAsync.mockRejectedValueOnce(
      serverRefusal('INTERNAL_SERVER_ERROR', 'KMS unavailable')
    );
    const root = await mount();

    await submitKey(root, 'sk-test-123');

    expect(statusMessages(root)).toEqual(['Could not save the key.']);
    expect(retryButton(root)).toBeDefined();
  });

  it('drops the saved key so it cannot be sent twice', async () => {
    const root = await mount();
    await submitKey(root, 'sk-test-123');

    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).toHaveBeenCalledTimes(1);
    expect(statusMessages(root)).toEqual(['Enter the key.']);
  });

  it('returns to the list after the key is added', async () => {
    const root = await mount();
    await submitKey(root, 'sk-test-123');

    expect(state.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/provider-keys');
  });

  it('returns to the organization’s list after the key is added', async () => {
    state.params = { provider: 'anthropic', org: ORG_ID };
    const root = await mount();
    await submitKey(root, 'sk-org-key');

    expect(state.dismissTo).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(3_profile)/provider-keys',
      params: { org: ORG_ID },
    });
  });

  it('replaces the key it was opened on instead of adding another', async () => {
    state.params = { provider: 'anthropic', id: KEY_ID, org: ORG_ID };
    const root = await mount();

    await submitKey(root, 'sk-replacement');

    expect(state.mutateAsync).toHaveBeenCalledWith('update', {
      organizationId: ORG_ID,
      id: KEY_ID,
      api_key: 'sk-replacement',
    });
  });

  it('stores a structured credential as the JSON the web form accepts', async () => {
    state.params = { provider: 'vertex' };
    state.providers = [{ id: 'vertex', name: 'Google Vertex AI' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = {
        project: 'project',
        location: 'global',
        clientEmail: 'service@example.test',
        privateKey: PEM_KEY,
      };
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).toHaveBeenCalledWith('create', {
      provider_id: 'vertex',
      api_key: JSON.stringify({
        project: 'project',
        location: 'global',
        googleCredentials: { clientEmail: 'service@example.test', privateKey: PEM_KEY.trim() },
      }),
    });
  });

  it('puts a refused Vertex key under its own field and sends nothing', async () => {
    state.params = { provider: 'vertex' };
    state.providers = [{ id: 'vertex', name: 'Google Vertex AI' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = {
        project: 'project',
        location: 'global',
        clientEmail: 'service@example.test',
        privateKey: 'not a key',
      };
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(credentialForm(root).errors).toEqual({
      privateKey: 'Paste the whole key block, from the BEGIN line to the END line.',
    });
    expect(statusMessages(root)).toHaveLength(1);
  });

  // A complete block a passphrase protects is already whole, so the sentence
  // asking for the whole block names what the reader has pasted and offers no
  // way forward. The form names the passphrase instead.
  it('names the passphrase under an encrypted Vertex key, not a missing block', async () => {
    state.params = { provider: 'vertex' };
    state.providers = [{ id: 'vertex', name: 'Google Vertex AI' }];
    const root = await mount();
    const encrypted = fixtureKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'x',
    });

    act(() => {
      credentialForm(root).values.current = {
        project: 'project',
        location: 'global',
        clientEmail: 'service@example.test',
        privateKey: typeof encrypted === 'string' ? encrypted : encrypted.toString('utf8'),
      };
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(credentialForm(root).errors).toEqual({
      privateKey:
        'This key block is passphrase-protected. Paste a service account key that has no passphrase.',
    });
    expect(statusMessages(root)).toHaveLength(1);
  });

  it('names the field a structured credential still needs', async () => {
    state.params = { provider: 'azure' };
    state.providers = [{ id: 'azure', name: 'Azure Foundry' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = { apiKey: 'azure-key', resourceName: '   ' };
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(statusMessages(root)).toEqual(['The key is missing a required value.']);
  });

  it('retires the structured field error and the refusal once the form is edited', async () => {
    state.params = { provider: 'azure' };
    state.providers = [{ id: 'azure', name: 'Azure Foundry' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = { apiKey: 'azure-key', resourceName: '   ' };
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });
    expect(credentialForm(root).errors).toEqual({
      resourceName: 'Azure resource name is required.',
    });
    expect(statusMessages(root)).toEqual(['The key is missing a required value.']);

    act(() => {
      credentialForm(root).onEdit();
    });

    // An edit with nothing left to clear must not stop the previous one from
    // clearing: the refusal and the field error both go.
    expect(credentialForm(root).errors).toEqual({});
    expect(statusMessages(root)).toEqual([]);
  });

  it('refuses the form to a role that cannot change an organization’s keys', async () => {
    state.params = { provider: 'anthropic', org: ORG_ID };
    state.role = 'member';
    const root = await mount();

    const [queryError] = root.findAll(node => Object.is(node.type, 'QueryError'));
    if (!queryError) {
      throw new Error('missing the refusal state');
    }
    expect(queryError.props.variant).toBe('permission');
    expect(allButtons(root)).toHaveLength(0);
  });

  it('leaves an organization it cannot resolve to the boundary', async () => {
    state.params = { provider: 'anthropic', org: ORG_ID };
    state.role = undefined;
    const root = await mount();

    const [boundary] = root.findAll(node => Object.is(node.type, 'OrganizationBoundary'));
    expect(boundary?.props.organizationIdOverride).toBe(ORG_ID);
    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
  });

  it('drops the Bedrock values the method it switches to does not show', async () => {
    state.params = { provider: 'bedrock' };
    state.providers = [{ id: 'bedrock', name: 'Amazon Bedrock' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = { apiKey: 'sk-bedrock', region: 'us-east-1' };
    });
    act(() => {
      credentialForm(root).onModeChange('accessKeys');
    });

    // The API key field is gone from the form, so its value must be gone from
    // the draft as well: Save cannot send what the reader cannot see.
    expect(credentialForm(root).values.current).toEqual({ region: 'us-east-1' });
  });

  it('names the half-filled mapping instead of refusing the whole credential', async () => {
    state.params = { provider: 'azure' };
    state.providers = [{ id: 'azure', name: 'Azure Foundry' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = { apiKey: 'azure-key', resourceName: 'foundry' };
      credentialForm(root).mappings.current.set(0, { gatewayModelSlug: 'gpt-4' });
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(statusMessages(root)).toEqual([
      'Mapping 1 needs both a gateway model slug and a deployment name.',
    ]);
  });

  it('counts the rows the form shows, including one nothing was typed into', async () => {
    state.params = { provider: 'azure' };
    state.providers = [{ id: 'azure', name: 'Azure Foundry' }];
    const root = await mount();

    act(() => {
      credentialForm(root).values.current = { apiKey: 'azure-key', resourceName: 'foundry' };
      const { mappings } = credentialForm(root);
      mappings.current.set(0, {});
      mappings.current.set(1, { customModelId: 'gpt-4o' });
    });
    await act(() => {
      (addButton(root).props.onPress as () => void)();
    });

    expect(state.mutateAsync).not.toHaveBeenCalled();
    expect(statusMessages(root)).toEqual([
      'Mapping 2 needs both a gateway model slug and a deployment name.',
    ]);
  });

  it('warns that replacing a key replaces its model mappings', async () => {
    state.params = { provider: 'azure', id: KEY_ID };
    state.providers = [{ id: 'azure', name: 'Azure Foundry' }];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children)
    ).toContain(
      'Replacing the key also replaces the saved model mappings: re-enter every mapping you still need.'
    );
  });

  it('retires a save refusal once the reader edits the value', async () => {
    state.mutateAsync.mockRejectedValueOnce({
      data: { code: 'BAD_REQUEST', message: 'That key was rejected by the provider' },
    });
    const root = await mount();

    await submitKey(root, 'sk-test-123');
    expect(statusMessages(root)).toEqual(['The key could not be saved.']);

    act(() => {
      (apiKeyField(root).props.onChangeText as (value: string) => void)('sk-test-456');
    });

    expect(statusMessages(root)).toEqual([]);
  });

  it('treats a provider the server does not offer as an invalid link', async () => {
    state.params = { provider: 'not-a-provider' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'InvalidRouteState'))).toHaveLength(1);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  // The write window is the only thing this guard answers: a Back there must not
  // remove the route, because the save's own `dismissTo` would then be a second
  // removal of the same scene and reboot the Android native stack.
  it('drops a Back while the save is in flight and keeps the form on screen', async () => {
    const root = await mount();
    await submitKeyPending(root, 'sk-test-123');

    expect(guard.enabled).toBe(true);
    const repeat = pressBack();

    // The removal is dropped, not prompted: Discard cannot call the request back.
    expect(repeat).not.toHaveBeenCalled();
    expect(guard.confirm).not.toHaveBeenCalled();
    expect(state.dismissTo).not.toHaveBeenCalled();
    // The screen the removal would have popped is still the pending form.
    expect(addButton(root).props.loading).toBe(true);
  });

  it('leaves on Back when no save is in flight', async () => {
    await mount();

    expect(guard.enabled).toBe(false);
    const repeat = pressBack();

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(guard.confirm).not.toHaveBeenCalled();
  });

  it('exits through the guard when the save lands, so the scene leaves once', async () => {
    const root = await mount();
    const save = await submitKeyPending(root, 'sk-test-123');

    // Android Back arrives while the request is still out, as it does in the
    // report; the guard holds the route.
    const backRepeat = pressBack();
    expect(backRepeat).not.toHaveBeenCalled();

    await save.resolve();
    await waitFor(() => state.dismissTo.mock.calls.length > 0);

    // The form's own exit is the leave, dispatched after the disarm render: one
    // dismissal of the list href, and no removal replayed from a still-armed
    // guard. The device run proves the ordering the native stack sees; this
    // suite proves the screen asks for the disarmed leave and nothing else.
    expect(state.dismissTo).toHaveBeenCalledTimes(1);
    expect(state.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/provider-keys');
    expect(guard.enabled).toBe(false);
    expect(backRepeat).not.toHaveBeenCalled();
  });
});
