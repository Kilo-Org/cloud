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
 *        `enrichment_data`        the GitHub and Clay profile data third parties assembled
 *                                 about the person. Personal exports only; the source has
 *                                 no organization reading
 *        `microdollar_usage_journal`
 *                                 one record pair per usage event, naming the event and
 *                                 the project it belongs to
 *        `security_findings`      one dependency vulnerability per repository, with its
 *                                 triage state, classification and the upstream alert
 *        `source_embeddings`      the project, file path and branch of each indexed chunk
 *                                 of source. The vectors are not in the warehouse
 *
 *      One entry rather than one per source, because they shipped together. A reader
 *      cares that the file gained sources at 4, not the order they were written in.
 *   5  the `platform_integrations` source (the connected source forge, the account it was
 *      connected under, and the repositories it reaches)
 *
 *      Its own version rather than an addition to 4, because 4 has shipped. Extending a
 *      released entry would leave two different file shapes both claiming it, which is
 *      the one thing this constant exists to prevent.
 *   6  two more sources, and one change to two existing ones:
 *        `external_usage_daily`   the countries a person appeared from. Not usage history:
 *                                 the source table was reduced to three columns on
 *                                 2026-08-14 and holds no date, model or volume
 *        `cloud_agent_code_reviews`
 *                                 one journal row per state change of a code review, with
 *                                 the pull request it covers and the summary it replaced
 *
 *      Also at 6, `app_builder_projects` and `app_builder_messages` narrowed to
 *      `id, title` and `id, data` on request.
 *   7  the `audiences` source (the marketing view's copy of the person's email address).
 *      Personal exports only; the source has no organization reading. It is also the one
 *      source NOT bounded to `snapshotAt` — the dbt model carries no row timestamp, so it
 *      holds current state as of its last run rather than state at the cutoff
 *   8  two more sources, both personal exports only, neither having an organization
 *      reading:
 *        `user_auth_provider`     which identity providers the person signed in with, and
 *                                 the account id, email, display name, avatar and hosted
 *                                 domain each one supplied, plus when it was linked. One
 *                                 record set per linked account, so a person with Google
 *                                 and GitHub linked has two
 *        `orb_customer`           the billing customer record: postal and shipping
 *                                 addresses, tax id, contact emails and name
 *
 *      One entry for the two, because they ship in the same change. Neither extends 7,
 *      which has already been released.
 *
 *      Also at 8, a narrowing of what three existing sources return, on request. Every
 *      one of these is a field a reader of an earlier file will find missing:
 *        `code_indexing_search`   no longer returns `created_at`
 *        `deployment_events`      no longer returns `event_type` or `event_timestamp`
 *        `user_auth_provider`     no longer returns `provider`, `provider_account_id` or
 *                                 `created_at`. The first two are still read, because they
 *                                 are that source's cursor and the two halves of its
 *                                 record id, so in a version-8 file which account a record
 *                                 belongs to is recoverable from that id. Not so from 9,
 *                                 where the id itself is gone
 *
 *      Where a dropped column was needed to page or to identify a row it is still
 *      SELECTed and simply not returned. Where it was not, it is no longer read at all.
 *   9  three sources resolving location below the identity section's per-person country:
 *        `int_microdollar_usage_enriched`
 *                                 the project a usage row belonged to, and the city,
 *                                 country and coordinates derived from the requesting IP
 *        `microdollar_usage_hourly`
 *                                 the countries a person appeared from, per project
 *        `usage_daily`            the countries a person appeared from
 *
 *      Also at 9, the per-record property some sources set and others could not is gone,
 *      so a reader no longer has to interpret its absence. `id` remains the one optional
 *      property: a record carries `source`, `field` and `value` always, and `id` only from
 *      a source with a stable per-row key. Where the file names a row it still names it
 *      the same way; where it never could, the property is simply absent.
 *
 *      A further narrowing of what three existing sources return, on request. Each is a
 *      field a reader of an earlier file will find missing:
 *        `deployment_events`      no longer returns `created_by_user_id`
 *        `orb_customer`           no longer returns `external_customer_id`, and no longer
 *                                 selects it either. Nothing here needs it: the load is
 *                                 what matches it to a person, so on every row an export
 *                                 can reach it held the same value as the scope already
 *        `user_auth_provider`     no longer returns a record `id`. The pair it was built
 *                                 from is still read as that source's cursor, but two
 *                                 linked accounts supplying the same profile now produce
 *                                 records nothing in the file tells apart
 *
 *      As at 8: where a dropped column is needed to page or to resolve a row it is still
 *      SELECTed and simply not returned.
 *
 *      A trailer also arrives at 9. Every file ends with one, naming any source that
 *      failed while being read, so a file that ends without one was truncated.
 *
 *      And the identity section is now the warehouse's `users` row alone — the account,
 *      billing, link, routing-identifier and `signup_ip` columns the primary alone held
 *      were dropped on request. `email` and `name` are returned under those names rather
 *      than the account's own column names. The export no longer reads the primary at all,
 *      so every field in the file is as of the same snapshot.
 *
 * The column's database default stays at 1 deliberately. Every insert sets this value
 * explicitly, so bumping the format never needs a migration, and a row written without it
 * is visibly stale rather than quietly wrong.
 */
export const EXPORT_FILE_SCHEMA_VERSION = 9;
