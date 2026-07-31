import type { JSX } from 'react';

export const AgentsSessionView = ({
  kiloSessionId: _kiloSessionId,
  onBack: _onBack,
}: {
  kiloSessionId: string;
  onBack: () => void;
}): JSX.Element => (
  <div className="flex flex-1 items-center justify-center px-4 py-6">
    <p className="type-body text-foreground-muted">Session view is not yet implemented.</p>
  </div>
);
