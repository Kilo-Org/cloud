// Legacy route — existing @kilocode/openclaw-security-advisor@0.1.x plugin
// installs POST here. Canonical implementation lives at
// /api/shell-security/analyze; this route re-exports POST so both
// endpoints behave identically. Kept alive indefinitely because we cannot
// force old plugin versions to upgrade.
export { POST } from '../../shell-security/analyze/route';
