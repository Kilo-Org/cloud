import { describe, expect, it } from 'vitest';

import {
  SECURITY_REMEDIATION_REJECTED_MESSAGE,
  SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
} from './stable-error-messages';

// Drift guard: the mobile ledger maps these sentences onto localized copy by
// exact string match (apps/mobile/src/lib/security-agent-ledger.ts,
// markerKeyFor), so a reword here silently un-maps the mobile copy.
describe('stable error sentences', () => {
  it('pins the exact wire sentence for the not-configured marker', () => {
    expect(SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE).toBe('Security service is not configured');
  });

  it('pins the exact wire sentence for the remediation-rejection marker', () => {
    expect(SECURITY_REMEDIATION_REJECTED_MESSAGE).toBe(
      'Security remediation service request was rejected'
    );
  });
});
