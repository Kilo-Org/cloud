import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudAgentSettingsButton } from './CloudAgentSettingsButton';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

type DialogProps = {
  open?: boolean;
  initialSection?: string;
  organizationId?: string;
  onOpenChange?: (open: boolean) => void;
  onSectionChange?: (section: 'general' | 'profiles' | 'environments' | 'compute') => void;
};

let mockSearchParams = new URLSearchParams();
let mockPathname = '/cloud';
const mockReplace = jest.fn();
const mockDialogProps: DialogProps[] = [];

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
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
  beforeEach(() => {
    mockReplace.mockReset();
    mockPathname = '/cloud';
  });

  it.each([
    ['?settings', 'general'],
    ['?settings=', 'general'],
    ['?settings=general', 'general'],
    ['?settings=environments', 'environments'],
  ] as const)('opens %s on the %s section', (search, section) => {
    setSearchParams(search);

    const props = renderButton();

    expect(props.open).toBe(true);
    expect(props.initialSection).toBe(section);
  });

  it('opens personal profiles for the personal profiles deep link', () => {
    setSearchParams('?settings=profiles');

    const props = renderButton();

    expect(props.open).toBe(true);
    expect(props.initialSection).toBe('profiles');
    expect(props.organizationId).toBeUndefined();
  });

  it('opens profiles for a profiles deep link in organization scope', () => {
    setSearchParams('?settings=profiles');

    const props = renderButton('org-1');

    expect(props.open).toBe(true);
    expect(props.initialSection).toBe('profiles');
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

  it('writes the active section to the URL', () => {
    setSearchParams('?foo=bar');
    mockPathname = '/cloud';
    const props = renderButton();

    props.onSectionChange?.('environments');

    expect(mockReplace).toHaveBeenCalledWith('/cloud?foo=bar&settings=environments', {
      scroll: false,
    });
  });

  it('clears the settings query when the dialog closes', () => {
    setSearchParams('?settings=general');
    mockPathname = '/cloud';
    const props = renderButton();

    props.onOpenChange?.(false);

    expect(mockReplace).toHaveBeenCalledWith('/cloud', { scroll: false });
  });

  it('keeps other query params when clearing settings on close', () => {
    setSearchParams('?settings=environments&foo=bar');
    mockPathname = '/cloud';
    const props = renderButton();

    props.onOpenChange?.(false);

    expect(mockReplace).toHaveBeenCalledWith('/cloud?foo=bar', { scroll: false });
  });

  it('does not rewrite the URL when the dialog opens', () => {
    setSearchParams('');
    mockPathname = '/cloud';
    const props = renderButton();

    props.onOpenChange?.(true);

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
