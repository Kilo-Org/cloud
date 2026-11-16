import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { KiloclawCreditRenewals } from './KiloclawCreditRenewals';

jest.mock('@/app/admin/useAdminPermissions', () => ({
  useAdminPermissions: () => ({ isSuperadmin: true }),
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    admin: {
      kiloclawCreditRenewals: {
        preview: {
          queryOptions: () => ({}),
          queryKey: () => ['preview'],
        },
        stop: { mutationOptions: () => ({}) },
      },
    },
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

Object.assign(globalThis, { React });

function setPreview(renewing: number, ending: number) {
  jest.mocked(useQuery).mockReturnValue({
    data: { renewing, ending },
    isPending: false,
    isError: false,
  } as unknown as UseQueryResult);
  jest.mocked(useMutation).mockReturnValue({
    data: undefined,
    isPending: false,
    error: null,
    reset: jest.fn(),
    mutate: jest.fn(),
  } as unknown as UseMutationResult);
}

describe('KiloclawCreditRenewals', () => {
  it('shows the preview count', () => {
    setPreview(3, 1);

    const html = renderToStaticMarkup(React.createElement(KiloclawCreditRenewals));

    expect(html).toContain('3 renewing, 1 already ending.');
    expect(html).not.toContain('disabled=""');
  });

  it('disables the stop button when there is nothing to stop', () => {
    setPreview(0, 2);

    const html = renderToStaticMarkup(React.createElement(KiloclawCreditRenewals));

    expect(html).toContain('Stop all credit renewals');
    expect(html).toContain('disabled=""');
  });
});
