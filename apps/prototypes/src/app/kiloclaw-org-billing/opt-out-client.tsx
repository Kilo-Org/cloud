'use client';

import { useState } from 'react';
import { KiloClawTabPreview, OrgSettingsPagePreview } from './components';

/**
 * Client-side wrapper that owns the opt-out boolean state so the toggle and
 * confirm dialog are interactive in the prototype.
 */
export function OptOutTabClient({
  plan,
  wrapInTabs = false,
}: {
  plan: 'teams' | 'enterprise';
  wrapInTabs?: boolean;
}) {
  const [optOut, setOptOut] = useState(false);

  if (wrapInTabs) {
    return <OrgSettingsPagePreview plan={plan} optOut={optOut} onOptOutChange={setOptOut} />;
  }

  return <KiloClawTabPreview plan={plan} optOut={optOut} onOptOutChange={setOptOut} />;
}
