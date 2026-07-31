import type { JSX } from 'react';

export const AgentsNewSession = ({
  onCreated: _onCreated,
  onCancel: _onCancel,
}: {
  onCreated: (kiloSessionId: string) => void;
  onCancel: () => void;
}): JSX.Element => (
  <div className="flex flex-1 items-center justify-center px-4 py-6">
    <p className="type-body text-foreground-muted">New session form is not yet implemented.</p>
  </div>
);
