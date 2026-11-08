import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { createRoot as createReactRoot, Root } from 'react-dom/client';
import type ContributorChampionsAdminPageComponent from './page';

const mockEnrolledRows = [
  {
    contributorId: 'contributor-enrolled',
    githubLogin: 'enrolled-dev',
    githubProfileUrl: 'https://github.com/enrolled-dev',
    email: 'enrolled@example.com',
    linkedUserId: 'user-enrolled',
    linkedUserName: 'Enrolled Dev',
    contributionsAllTime: 4,
    contributions30d: 1,
    suggestedTier: 'contributor',
    selectedTier: 'contributor',
    enrolledTier: 'contributor',
    enrolledAt: '2026-01-01T00:00:00.000Z',
    creditAmountUsd: 0,
    creditsLastGrantedAt: null,
    linkedKiloUserId: 'user-enrolled',
    hasGithubIntegration: true,
  },
];

const mockReviewRows = [
  {
    contributorId: 'contributor-review',
    githubLogin: 'review-dev',
    githubProfileUrl: 'https://github.com/review-dev',
    email: 'review@example.com',
    linkedUserId: 'user-review',
    linkedUserName: 'Review Dev',
    contributionsAllTime: 6,
    contributions30d: 2,
    suggestedTier: 'ambassador',
    selectedTier: 'ambassador',
    enrolledTier: null,
    enrolledAt: null,
    creditAmountUsd: null,
    creditsLastGrantedAt: null,
    linkedKiloUserId: 'user-review',
    hasGithubIntegration: false,
  },
];

const mockPermission = { canManageCredits: false, isPermissionResolved: false };

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => ({
    data:
      options.queryKey?.[0] === 'contributor-enrolled-list'
        ? mockEnrolledRows
        : options.queryKey?.[0] === 'contributor-review-queue'
          ? mockReviewRows
          : [],
    isLoading: false,
  }),
  useMutation: () => ({ isPending: false, mutate: jest.fn(), mutateAsync: jest.fn() }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      contributorChampions: {
        reviewQueue: {
          queryOptions: () => ({ queryKey: ['contributor-review-queue'] }),
          queryKey: () => ['contributor-review-queue'],
        },
        enrolledList: {
          queryOptions: () => ({ queryKey: ['contributor-enrolled-list'] }),
          queryKey: () => ['contributor-enrolled-list'],
        },
        contributionDrillIn: {
          queryOptions: () => ({ queryKey: ['contributor-drill-in'] }),
        },
        searchKiloUsers: { queryOptions: () => ({ queryKey: ['contributor-user-search'] }) },
        syncNow: { mutationOptions: () => ({}) },
        enroll: { mutationOptions: () => ({}) },
        upgradeTier: { mutationOptions: () => ({}) },
        manualEnroll: { mutationOptions: () => ({}) },
        setSelectedTier: { mutationOptions: () => ({}) },
      },
    },
  }),
}));
jest.mock('@/app/admin/useAdminCreditManagementPermission', () => ({
  useAdminCreditManagementPermission: () => mockPermission,
}));
jest.mock('next/link', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    __esModule: true,
    default: ({ children, ...props }: React.ComponentProps<'a'>) =>
      react.createElement('a', props, children),
  };
});
jest.mock('@/app/admin/components/AdminPage', () => {
  const react = jest.requireActual<typeof React>('react');
  return {
    __esModule: true,
    default: ({ children, buttons }: { children?: React.ReactNode; buttons?: React.ReactNode }) =>
      react.createElement('main', null, buttons, children),
  };
});
jest.mock('@/components/ui/breadcrumb', () => {
  const react = jest.requireActual<typeof React>('react');
  const span = ({ children }: { children?: React.ReactNode }) =>
    react.createElement('span', null, children);
  return {
    BreadcrumbItem: span,
    BreadcrumbPage: span,
    BreadcrumbLink: span,
    BreadcrumbSeparator: () => null,
  };
});
jest.mock('@/components/ui/dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const block =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      react.createElement(tag, null, children);
  return {
    Dialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
      open ? react.createElement(react.Fragment, null, children) : null,
    DialogContent: ({ children }: { children?: React.ReactNode }) =>
      react.createElement('div', { role: 'dialog' }, children),
    DialogHeader: block('div'),
    DialogFooter: block('div'),
    DialogTitle: block('div'),
    DialogDescription: block('div'),
    DialogClose: ({ children }: { children?: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

const noteText =
  'Read-only: the credit manager permission is required to enroll or upgrade contributors.';

describe('ContributorChampionsAdminPage credit grants', () => {
  let root: Root;
  let container: HTMLElement;
  let cleanup: () => void;
  let Page: typeof ContributorChampionsAdminPageComponent;

  beforeEach(async () => {
    const requireFromNext = createRequire(require.resolve('next/package.json'));
    const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    // Radix Select portals its closed content into `new DocumentFragment()`, and
    // linkedom exposes DocumentFragment only as an illegal `new` facade, so hand
    // the constructor back a real document fragment.
    const DocumentFragment = function DocumentFragment() {
      return document.createDocumentFragment();
    };
    const replacements = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      DocumentFragment,
      Node: window.Node,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = new Map(
      Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
    );
    Object.assign(globalThis, replacements);
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    // Linkedom globals must exist before React DOM and the page module evaluate,
    // so both imports are dynamic on purpose.
    const { createRoot }: { createRoot: typeof createReactRoot } = await import('react-dom/client');
    const {
      default: ContributorChampionsAdminPage,
    }: {
      default: typeof ContributorChampionsAdminPageComponent;
    } = await import('./page');
    Page = ContributorChampionsAdminPage;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    cleanup?.();
  });

  function render() {
    act(() => root.render(createElement(Page)));
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('button'));
  }

  function buttonContaining(text: string): HTMLButtonElement {
    const match = buttons().find(button => (button.textContent ?? '').includes(text));
    if (!match) throw new Error(`Button containing "${text}" missing`);
    return match;
  }

  function buttonWithTitle(title: string): HTMLButtonElement {
    const match = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
    if (!match) throw new Error(`Button titled "${title}" missing`);
    return match;
  }

  function section(heading: string): HTMLElement {
    const match = Array.from(container.querySelectorAll('section')).find(
      element => element.querySelector('h2')?.textContent === heading
    );
    if (!match) throw new Error(`Section "${heading}" missing`);
    return match;
  }

  it('enables the credit-granting controls for an operator with the credit manager permission', () => {
    mockPermission.canManageCredits = true;
    mockPermission.isPermissionResolved = true;
    render();

    expect(buttonContaining('Manual enroll').disabled).toBe(false);
    expect(buttonWithTitle('Add contributor as ambassador').disabled).toBe(false);
    expect(buttonContaining('Upgrade to…').disabled).toBe(false);
    expect(section('Enrolled').textContent).not.toContain(noteText);
    expect(section('Review Queue').textContent).not.toContain(noteText);
  });

  it('disables the credit-granting controls for a plain admin', () => {
    mockPermission.canManageCredits = false;
    mockPermission.isPermissionResolved = true;
    render();

    const manualEnroll = buttonContaining('Manual enroll');
    expect(manualEnroll.disabled).toBe(true);
    expect(manualEnroll.title).toBe(noteText);
    const upgradeSelect = buttonContaining('Upgrade to…');
    expect(upgradeSelect.disabled).toBe(true);
    expect(upgradeSelect.title).toBe(noteText);
    expect(container.textContent).toContain(noteText);

    const enrolledSection = section('Enrolled');
    const reviewQueueSection = section('Review Queue');
    expect(enrolledSection.textContent).toContain(noteText);
    expect(reviewQueueSection.textContent).toContain(noteText);

    const enrollButton = reviewQueueSection.querySelector<HTMLButtonElement>(
      `button[title="${noteText}"]`
    );
    if (!enrollButton) throw new Error('Enroll button permission hint missing');
    expect(enrollButton.disabled).toBe(true);

    act(() => manualEnroll.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('treats an unresolved permission query as unprivileged', () => {
    mockPermission.canManageCredits = true;
    mockPermission.isPermissionResolved = false;
    render();

    expect(buttonContaining('Manual enroll').disabled).toBe(true);
    expect(buttonContaining('Upgrade to…').disabled).toBe(true);
    expect(section('Enrolled').textContent).toContain(noteText);
    expect(section('Review Queue').textContent).toContain(noteText);

    const enrollButton = section('Review Queue').querySelector<HTMLButtonElement>(
      `button[title="${noteText}"]`
    );
    if (!enrollButton) throw new Error('Enroll button permission hint missing');
    expect(enrollButton.disabled).toBe(true);
  });

  it('closes the enrollment confirm button when the permission stops allowing credit grants', () => {
    mockPermission.canManageCredits = true;
    mockPermission.isPermissionResolved = true;
    render();

    act(() => buttonWithTitle('Add contributor as ambassador').click());
    expect(buttonContaining('Confirm enrollment').disabled).toBe(false);

    mockPermission.canManageCredits = false;
    mockPermission.isPermissionResolved = true;
    render();

    expect(buttonContaining('Confirm enrollment').disabled).toBe(true);
  });

  it('keeps the read-only views and selected-tier control available to a plain admin', () => {
    mockPermission.canManageCredits = false;
    mockPermission.isPermissionResolved = true;
    render();

    expect(buttonContaining('Sync now').disabled).toBe(false);
    expect(buttonContaining('ambassador').disabled).toBe(false);
  });
});
