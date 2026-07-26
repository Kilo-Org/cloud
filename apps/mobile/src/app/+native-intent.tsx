// PR #4779 (share target, open) also creates this file; whichever lands second
// composes both concerns here, with the share-intent check first (a share URL
// must return early before web-path mapping).
export { redirectSystemPath } from '@/lib/deep-link-handler';
