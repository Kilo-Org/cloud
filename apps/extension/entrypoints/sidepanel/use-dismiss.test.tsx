/* eslint-disable vitest/no-hooks, vitest/require-top-level-describe -- every test here mounts a surface with a document-level listener, so the DOM must be cleaned between tests */
// @vitest-environment jsdom

import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useDismissOnOutsideClick, useEscapeKey, useModalDialog } from './use-dismiss';

afterEach(cleanup);

const DialogHarness = ({
  onClose,
  withSelect = false,
}: {
  onClose: () => void;
  withSelect?: boolean;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const dialogRef = useModalDialog({
    onClose: () => {
      setOpen(false);
      onClose();
    },
    open,
  });

  return (
    <div>
      <button
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        Open settings
      </button>
      {open ? (
        <div ref={dialogRef} role="dialog" tabIndex={-1}>
          <button type="button">First control</button>
          <button
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
              }
            }}
            type="button"
          >
            Escape owner
          </button>
          {withSelect ? (
            <select aria-label="Credit account">
              <option value="one">One</option>
            </select>
          ) : null}
          <button type="button">Last control</button>
        </div>
      ) : null}
    </div>
  );
};

const EscapeHarness = ({ enabled }: { enabled: boolean }): JSX.Element => {
  const [count, setCount] = useState(0);
  useEscapeKey(enabled, () => {
    setCount(current => current + 1);
  });

  return (
    <div>
      <button type="button">{`Dismissed ${count}`}</button>
      <select aria-label="Native picker">
        <option value="one">One</option>
      </select>
    </div>
  );
};

const OutsideClickHarness = ({ enabled }: { enabled: boolean }): JSX.Element => {
  const [dismissed, setDismissed] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideClick({
    enabled,
    onDismiss: () => {
      setDismissed(current => current + 1);
    },
    targetRef: containerRef,
  });

  return (
    <div>
      <div ref={containerRef}>
        <button type="button">Inside</button>
      </div>
      <button type="button">{`Outside ${dismissed}`}</button>
    </div>
  );
};

describe('modal dialog focus and dismissal', () => {
  it('moves focus inside on open and restores it on Escape', () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open settings' });

    opener.focus();
    fireEvent.click(opener);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First control' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    // eslint-disable-next-line vitest/prefer-called-times -- vitest/prefer-called-once is also enabled and prefers the singular matcher.
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes from a focused closed select inside the dialog', () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} withSelect />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    const select = screen.getByRole('combobox', { name: 'Credit account' });
    select.focus();
    fireEvent.keyDown(select, { key: 'Escape' });

    // eslint-disable-next-line vitest/prefer-called-times -- vitest/prefer-called-once is also enabled and prefers the singular matcher.
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves Escape to a control that already handled it', () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Escape owner' }), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(<DialogHarness onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));

    const first = screen.getByRole('button', { name: 'First control' });
    const last = screen.getByRole('button', { name: 'Last control' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('escape dismissal', () => {
  it('fires only while enabled', () => {
    const { rerender } = render(<EscapeHarness enabled={false} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Dismissed 0' })).toBeDefined();

    rerender(<EscapeHarness enabled />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Dismissed 1' })).toBeDefined();
  });

  it('dismisses from a focused closed select', () => {
    render(<EscapeHarness enabled />);

    const select = screen.getByRole('combobox', { name: 'Native picker' });
    select.focus();
    fireEvent.keyDown(select, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Dismissed 1' })).toBeDefined();
  });
});

describe('outside click dismissal', () => {
  it('fires only for pointer events outside the target', () => {
    const { rerender } = render(<OutsideClickHarness enabled={false} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside 0' }));
    expect(screen.getByRole('button', { name: 'Outside 0' })).toBeDefined();

    rerender(<OutsideClickHarness enabled />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
    expect(screen.getByRole('button', { name: 'Outside 0' })).toBeDefined();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside 0' }));
    expect(screen.getByRole('button', { name: 'Outside 1' })).toBeDefined();
  });
});
