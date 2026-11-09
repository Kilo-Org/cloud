import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAgentSettingsButton } from './CloudAgentSettingsButton';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type DialogProps = {
  open?: boolean;
  initialSection?: string;
  organizationId?: string;
};

let mockSearchParams = new URLSearchParams();
const mockDialogProps: DialogProps[] = [];

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

jest.mock('lucide-react', () => ({ Settings: () => null }));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('button', null, children),
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => children,
}));

jest.mock('./CloudAgentSettingsDialog', () => ({
  CloudAgentSettingsDialog: (props: DialogProps) => {
    mockDialogProps.push(props);
    return null;
  },
}));

function renderButton(organizationId?: string): DialogProps {
  mockDialogProps.length = 0;
  renderToStaticMarkup(React.createElement(CloudAgentSettingsButton, { organizationId }));
  const props = mockDialogProps[0];
  if (!props) throw new Error('CloudAgentSettingsDialog was not rendered');
  return props;
}

function setSearchParams(search: string): void {
  mockSearchParams = new URLSearchParams(search);
}

describe('CloudAgentSettingsButton deep links', () => {
  it('opens personal profiles for the personal profiles deep link', () => {
    setSearchParams('?settings=profiles');

    const props = renderButton();

    expect(props.open).toBe(true);
    expect(props.initialSection).toBe('profiles');
    expect(props.organizationId).toBeUndefined();
  });

  it('does not open organization profiles from the personal profiles link', () => {
    setSearchParams('?settings=profiles');

    const props = renderButton('org-1');

    expect(props.open).toBe(false);
    expect(props.initialSection).toBe('general');
    expect(props.organizationId).toBe('org-1');
  });

  it('keeps opening organization compute from the compute deep link', () => {
    setSearchParams('?settings=compute');

    const props = renderButton('org-1');

    expect(props.open).toBe(true);
    expect(props.initialSection).toBe('compute');
  });

  it('does not open compute in personal scope', () => {
    setSearchParams('?settings=compute');

    const props = renderButton();

    expect(props.open).toBe(false);
    expect(props.initialSection).toBe('general');
  });

  it('stays closed without a settings query', () => {
    setSearchParams('');

    const props = renderButton();

    expect(props.open).toBe(false);
    expect(props.initialSection).toBe('general');
  });
});
