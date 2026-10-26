import { type Href } from 'expo-router';

/**
 * The model catalog list: the one in-app parent of a model detail, and the
 * destination every Back control on the detail can name without guessing.
 *
 * The detail route is also reachable without the list beneath it — a deep
 * link, or a stack where the list itself already left — so Back cannot just
 * pop and inherit whatever route happens to be there.
 */
export const MODEL_CATALOG_HREF: Href = '/model-catalog';
