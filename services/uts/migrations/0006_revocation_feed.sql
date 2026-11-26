-- The revocation feed (design section 5.6): what a statement that revokes hands to the two feed
-- objects, and the entry kind for a blocked account.
--
-- * A revoking statement writes its `uts.revocations` rows with `revoked_at = now()`, the start
--   time of its transaction. The Worker runs the grant function and
--   `uts.feed_entries_of_statement()` in one SQL statement (`src/grants/store.ts`), so the
--   entries come back with the outcome, and the Worker writes them to the feed objects after the
--   statement commits. The feed objects' backfill reads `uts.revocations` directly as the app login
--   (`src/revocation/store.ts`), so an entry whose write to both objects failed still reaches them.
-- * A `blocked_account` entry names an account by its id. A PAT lookup finds nothing for a blocked
--   account (`uts.lookup_pat`), so the entry only has to outlast the PAT caches, as a `pat` entry
--   does; the CHECK on `uts.revocations` lets it stay 10 minutes or longer.

SET LOCAL ROLE uts_owner;

ALTER TYPE uts.revocation_kind ADD VALUE 'blocked_account';

-- Every write to `uts.revocations` is stamped with the start time of its transaction: the statement
-- entries and the recent backfill find a row only by `revoked_at`, so a row written with an older
-- time, or updated without moving it, would never reach a feed object that keeps running. The
-- feed time keeps its length (`feed_expires_at - revoked_at`), so every shape CHECK still holds.
CREATE FUNCTION uts.stamp_revocation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.feed_expires_at := now() + (NEW.feed_expires_at - NEW.revoked_at);
  NEW.revoked_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER revocations_stamp
BEFORE INSERT OR UPDATE ON uts.revocations
FOR EACH ROW EXECUTE FUNCTION uts.stamp_revocation();

-- Every feed entry whose `revoked_at` is the start time of the current transaction, oldest first,
-- as a JSON array of `{kind, id, revoked_before, revoked_at, expires_at}` with times in epoch
-- milliseconds (`revoked_before` null except for a `subject` entry). A row another transaction
-- wrote in the same microsecond is a real revocation too, and a feed object takes an entry twice
-- without change. VOLATILE: its query takes a new snapshot, so it sees the rows the grant
-- function in the same statement wrote before it; a STABLE function would read the statement's
-- first snapshot and see none. One probe of `revocations_revoked_at_idx`.
CREATE FUNCTION uts.feed_entries_of_statement() RETURNS jsonb
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', entry.kind,
        'id', entry.subject_id,
        'revoked_before', floor(extract(epoch FROM entry.revoked_before) * 1000),
        'revoked_at', floor(extract(epoch FROM entry.revoked_at) * 1000),
        'expires_at', floor(extract(epoch FROM entry.feed_expires_at) * 1000)
      )
      ORDER BY entry.id
    ),
    '[]'::jsonb
  )
  FROM uts.revocations AS entry
  WHERE entry.revoked_at = now()
$$;

GRANT EXECUTE ON FUNCTION uts.feed_entries_of_statement() TO uts_app;
