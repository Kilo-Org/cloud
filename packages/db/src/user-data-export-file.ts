/**
 * The format of the user data export file, recorded on `user_data_exports.schema_version`
 * and reported as `schemaVersion` in the file's own header.
 *
 * Shared rather than defined in the Worker because the row and the file it describes have
 * to agree, and they are written by different processes: the web router creates the row,
 * the Worker writes the file. A constant in one of them leaves the other guessing.
 *
 * Distinct from the Worker's `EXPORT_SCHEMA_VERSION`, which versions the queue and
 * download message contract. That one is pinned with `z.literal`, so raising it fails
 * every in-flight message mid-deploy. This one has no such constraint.
 *
 * Raise it when the file's shape changes in a way that could break a reader:
 *
 *   1  the original set of sources
 *   2  the warehouse profile columns added to the identity section (location, historic
 *      and current, plus the analytics copies of name, email and hosted domain)
 *   3  the `code_indexing_manifest` source (project, branch and file path per indexed
 *      file), which the original set omitted
 *   4  the warehouse sources the original set omitted, added as one batch:
 *        `code_indexing_search`   the search text, the project it ran against, the
 *                                 results it returned and when it ran
 *        `deployment_events`      one record set per deployment event, with the build and
 *                                 deployment it belongs to, its type, its payload and who
 *                                 created it
 *
 *      One entry rather than one per source, because they ship together. A reader cares
 *      that the file gained sources at 4, not the order they were written in.
 *
 * The column's database default stays at 1 deliberately. Every insert sets this value
 * explicitly, so bumping the format never needs a migration, and a row written without it
 * is visibly stale rather than quietly wrong.
 */
export const EXPORT_FILE_SCHEMA_VERSION = 4;
