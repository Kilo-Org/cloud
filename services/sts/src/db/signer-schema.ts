/**
 * SignerDO keeps its key in KV storage and no SQL tables. This schema stays so its migrations, which
 * dropped the table an earlier revision used, keep running for objects created before.
 */
export {};
