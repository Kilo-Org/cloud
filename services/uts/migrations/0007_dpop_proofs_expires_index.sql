-- An index on `uts.dpop_proofs (expires_at)`. `uts.maintain_oauth_rows()` deletes expired DPoP
-- proof `jti`s every minute. Every mint and refresh inserts one row that lives about 2 minutes, so
-- the table holds about 2 minutes of mints; without this index each maintenance call scans all of
-- it. With it, the delete reads only the expired range, which is the oldest end of the index;
-- inserts append at the newest end.

SET LOCAL ROLE uts_owner;

CREATE INDEX dpop_proofs_expires_idx ON uts.dpop_proofs (expires_at);
