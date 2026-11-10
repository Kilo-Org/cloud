/**
 * Older builds of the app kept cloud agent session content — transcripts and
 * resume configuration — in this IndexedDB database. Nothing reads it now, and
 * the database must not stay in a browser that already holds it.
 *
 * The name is a constant on purpose: the deletion target is a historical
 * artifact, not a database the app still opens.
 */
export const LEGACY_SESSION_DATABASE = 'kilocode-cloud-sessions';

let purgeStarted = false;

/**
 * Delete the legacy session database once per page load.
 *
 * A browser that refuses or blocks the deletion keeps the database and the app
 * keeps working: the database is not part of any current code path, so every
 * failure here is ignored.
 */
export function purgeLegacySessionDatabase(): void {
  if (purgeStarted || typeof indexedDB === 'undefined') return;
  purgeStarted = true;

  try {
    const request = indexedDB.deleteDatabase(LEGACY_SESSION_DATABASE);
    request.onerror = null;
    request.onblocked = null;
    request.onsuccess = null;
  } catch {
    // The database stays; the app does not depend on it.
  }
}
