// Re-export kept so existing import paths under apps/web keep working; the
// canonical implementation lives in @kilocode/worker-utils so that services
// (e.g. session-ingest) can apply the same normalization at write time.
//
// Imported via the subpath export (not the package root) so Jest doesn't have
// to transform unrelated ESM dependencies like `jose` pulled in by the
// worker-utils entry point.
export { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';
