import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as LinearIntegrationDetailsModule from './LinearIntegrationDetails';

// The jest transform compiles JSX with the classic runtime, and the card imports
// no React binding, so the global stands in for it exactly as in
// `PrStatus.test.ts` and `SubOrganizationSections.test.ts`.
globalThis.React = React;

/**
 * The copy the card shows a viewer whose role its procedures reject. It is the
 * same sentence the server's `permission_required` error carries, so the card
 * and the procedures cannot drift apart silently.
 */
const readOnlyNote =
  'Only organization owners, admins, and billing managers can connect or change the organization Linear integration.';

let mockInstallationData: unknown;
const mockComboboxProps: Array<{ disabled?: boolean }> = [];
const mockButtons: Array<{ children?: React.ReactNode }> = [];

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    linear: {
      getInstallation: { queryOptions: () => ({}), queryKey: () => [] },
      uninstallApp: { mutationOptions: () => ({}) },
      updateModel: { mutationOptions: () => ({}) },
      devRemoveDbRowOnly: { mutationOptions: () => ({}) },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockInstallationData, isLoading: false, refetch: jest.fn() }),
  useMutation: () => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({ data: { data: [] }, isLoading: false }),
}));
jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: (props: { disabled?: boolean }) => {
    mockComboboxProps.push(props);
    return jest.requireActual<typeof React>('react').createElement('div', null, 'model-picker');
  },
}));
jest.mock('@/components/ui/button', () => ({
  Button: (props: { children?: React.ReactNode }) => {
    mockButtons.push(props);
    return jest.requireActual<typeof React>('react').createElement('button', null, props.children);
  },
}));

// The mocks above must be registered before the card and its imports load, so
// the card is required here rather than imported.
let LinearIntegrationDetails: typeof LinearIntegrationDetailsModule.LinearIntegrationDetails;

beforeAll(() => {
  ({ LinearIntegrationDetails } =
    jest.requireActual<typeof LinearIntegrationDetailsModule>('./LinearIntegrationDetails'));
});

const activeInstallation = {
  installed: true,
  installation: {
    organizationId: 'synthetic-linear-workspace',
    workspaceName: 'Synthetic Workspace',
    status: 'active',
    suspendedAt: null,
    suspendedBy: null,
    scopes: ['read', 'write'],
    installedAt: '2026-01-01T00:00:00.000Z',
    modelSlug: 'synthetic/model',
  },
};

const suspendedInstallation = {
  ...activeInstallation,
  installed: false,
  installation: { ...activeInstallation.installation, status: 'suspended' },
};

const notConnectedInstallation = { installed: false, installation: null };

function renderCard(props: React.ComponentProps<typeof LinearIntegrationDetails>) {
  mockComboboxProps.length = 0;
  mockButtons.length = 0;
  return renderToStaticMarkup(React.createElement(LinearIntegrationDetails, props));
}

/**
 * Renders every captured button's children, so a label is matched against what
 * the card actually asked the button to show rather than against class names.
 */
function rendersButtonLabel(label: string): boolean {
  return mockButtons.some(button =>
    renderToStaticMarkup(React.createElement(React.Fragment, null, button.children)).includes(
      label
    )
  );
}

describe('LinearIntegrationDetails organization authority', () => {
  beforeEach(() => {
    mockInstallationData = activeInstallation;
  });

  test('gives a viewer without authority a read-only organization card', () => {
    const markup = renderCard({ organizationId: 'organization-id', canManage: false });

    expect(markup).toContain(readOnlyNote);
    expect(rendersButtonLabel('Re-install')).toBe(false);
    expect(rendersButtonLabel('Disconnect')).toBe(false);
    expect(mockComboboxProps.at(-1)?.disabled).toBe(true);
  });

  test('keeps the controls for an authorized manager', () => {
    const markup = renderCard({ organizationId: 'organization-id', canManage: true });

    expect(markup).not.toContain(readOnlyNote);
    expect(rendersButtonLabel('Re-install')).toBe(true);
    expect(rendersButtonLabel('Disconnect')).toBe(true);
    expect(mockComboboxProps.at(-1)?.disabled).toBe(false);
  });

  test('states the suspension without offering the re-install action to a viewer', () => {
    mockInstallationData = suspendedInstallation;
    // The alert paragraph itself says "Re-install Linear to restore the
    // connection", so the action is identified by the button, not that phrase.
    const viewerMarkup = renderCard({ organizationId: 'organization-id', canManage: false });

    expect(viewerMarkup).toContain('Linear integration suspended');
    expect(viewerMarkup).toContain(readOnlyNote);
    expect(rendersButtonLabel('Re-install Linear')).toBe(false);

    const managerMarkup = renderCard({ organizationId: 'organization-id', canManage: true });

    expect(managerMarkup).toContain('Linear integration suspended');
    expect(rendersButtonLabel('Re-install Linear')).toBe(true);
  });

  test('withholds the connect action from a viewer while keeping the explanation', () => {
    mockInstallationData = notConnectedInstallation;
    const viewerMarkup = renderCard({ organizationId: 'organization-id', canManage: false });

    expect(viewerMarkup).toContain('Connect Linear to have Kilo respond');
    expect(viewerMarkup).toContain(readOnlyNote);
    expect(rendersButtonLabel('Connect Linear')).toBe(false);

    const managerMarkup = renderCard({ organizationId: 'organization-id', canManage: true });

    expect(rendersButtonLabel('Connect Linear')).toBe(true);
    expect(managerMarkup).not.toContain(readOnlyNote);
  });

  test('keeps every control on a personal connection that takes no authority prop', () => {
    const markup = renderCard({});

    expect(markup).not.toContain(readOnlyNote);
    expect(rendersButtonLabel('Re-install')).toBe(true);
    expect(rendersButtonLabel('Disconnect')).toBe(true);
    expect(mockComboboxProps.at(-1)?.disabled).toBe(false);
  });

  test('lets a personal connection start from the connect action', () => {
    mockInstallationData = notConnectedInstallation;
    const markup = renderCard({});

    expect(markup).not.toContain(readOnlyNote);
    expect(rendersButtonLabel('Connect Linear')).toBe(true);
  });
});
