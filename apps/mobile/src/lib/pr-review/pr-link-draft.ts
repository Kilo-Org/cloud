/**
 * The link field's text survives the entry-screen remount that pushing a
 * review route and coming back causes. One slot in module memory: it dies
 * with the JS context, is never written to disk, and an empty field clears it.
 */
export const prLinkDraft = { text: '' };
