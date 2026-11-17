import React, { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useOrganizationAvailableModels } from '@/app/api/organizations/hooks';
import { AvailableModelsDialog } from './AvailableModelsDialog';

jest.mock('@/app/api/organizations/hooks', () => ({ useOrganizationAvailableModels: jest.fn() }));
// Radix renders dialog content through a portal, which server rendering skips.
jest.mock('@/components/ui/dialog', () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children);
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

Object.assign(globalThis, { React });

const mockUseOrganizationAvailableModels = jest.mocked(useOrganizationAvailableModels);

const PRICE_NOTE =
  'Prices are for our preferred provider. Actual charges can differ, and may be higher, if a request fails over to another provider or provider restrictions are configured.';

function setModels(models: { id: string; pricing: { prompt: string; completion: string } }[]) {
  mockUseOrganizationAvailableModels.mockReturnValue({
    data: { data: models },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useOrganizationAvailableModels>);
}

function renderDialog() {
  return renderToStaticMarkup(
    createElement(AvailableModelsDialog, {
      open: true,
      onOpenChange: () => {},
      organizationId: 'org',
    })
  );
}

describe('AvailableModelsDialog', () => {
  it('notes that listed prices are for the preferred provider', () => {
    setModels([{ id: 'vendor/priced', pricing: { prompt: '0.000003', completion: '0.000015' } }]);
    const html = renderDialog();
    expect(html).toContain('/1M prompt');
    expect(html).toContain(PRICE_NOTE);
  });

  it('omits the note when no model shows a price', () => {
    setModels([{ id: 'vendor/free', pricing: { prompt: '0', completion: '0' } }]);
    const html = renderDialog();
    expect(html).not.toContain('/1M prompt');
    expect(html).not.toContain(PRICE_NOTE);
  });
});
