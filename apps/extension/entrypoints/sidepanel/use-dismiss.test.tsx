// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { JSX } from 'react';
import { useDismissOnOutsideClick, useEscapeKey, useModalDialog } from './use-dismiss';

const DialogHarness = ({ onClose }: { onClose: () => void }): JSX.Element => {
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

  return <button type="button">{`Dismissed ${count}`}</button>;
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
