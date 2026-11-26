-- The audit relay watermark moves only through `uts.advance_audit_watermark` (design section 8.1).
--
-- * A watermark moved past a row that was never sent would let that row go unrelayed with no gap
--   in its stream, and its partition would later be dropped as relayed. The app role therefore
--   loses UPDATE on the watermarks, and the function accepts only a move that numbers every row it
--   passes: the stream's sequence advances by exactly the count of the shard's rows between the
--   old and the new position. A move without a send then leaves a sequence gap at the audit relay
--   service, which holds the stream and pages, instead of a silent loss.
-- * This supersedes the comment on `uts.audit_relay_watermarks` in 0002: the watermark marks the
--   newest row the audit queue accepted. Nothing confirms that the archive stored it; UTS cannot
--   bind the archive. The comment on the table below states this.

SET LOCAL ROLE uts_owner;

REVOKE UPDATE ON uts.audit_relay_watermarks FROM uts_app;

COMMENT ON TABLE uts.audit_relay_watermarks IS
  'One row per audit shard. last_txid and last_id mark the newest row whose batch the audit queue '
  'accepted; last_seq is that row''s sequence number in the shard''s stream. There is no archive '
  'confirmation. Moved only by uts.advance_audit_watermark.';

-- Moves shard `p_shard`'s watermark from sequence number `p_from_seq` to the row (`p_to_txid`,
-- `p_to_id`) at sequence number `p_to_seq`. Returns false, changing nothing, when the watermark no
-- longer stands at `p_from_seq` (another runner moved it). Raises 22023 for any other refused
-- move, which changes nothing:
--
-- * the new position is not after the old one, or `p_to_seq - p_from_seq` is not 1 to 500;
-- * the target row does not exist in the shard, or its transaction is not below the oldest open
--   transaction (so a later commit could still sort before it);
-- * the shard holds a different number of rows between the old position (excluded) and the new
--   one (included) than `p_to_seq - p_from_seq`.
--
-- The count reads at most 501 entries of the (shard, txid, id) index with the row comparisons as
-- the index condition, so a call costs one index range read of the batch it confirms.
CREATE FUNCTION uts.advance_audit_watermark(
  p_shard smallint,
  p_from_seq bigint,
  p_to_txid xid8,
  p_to_id bigint,
  p_to_seq bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Taken before this call locks the row, which gives its own transaction an id.
  horizon CONSTANT xid8 := pg_snapshot_xmin(pg_current_snapshot());
  current uts.audit_relay_watermarks%ROWTYPE;
  covered bigint;
BEGIN
  IF p_shard IS NULL OR p_from_seq IS NULL OR p_to_txid IS NULL OR p_to_id IS NULL
    OR p_to_seq IS NULL
  THEN
    RAISE EXCEPTION 'every argument is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current FROM uts.audit_relay_watermarks WHERE shard = p_shard FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no audit shard %', p_shard USING ERRCODE = '22023';
  END IF;
  IF current.last_seq <> p_from_seq THEN
    RETURN false;
  END IF;

  IF p_to_seq - p_from_seq NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a watermark moves by 1 to 500 rows' USING ERRCODE = '22023';
  END IF;
  IF (p_to_txid, p_to_id) <= (current.last_txid, current.last_id) THEN
    RAISE EXCEPTION 'a watermark moves only forward' USING ERRCODE = '22023';
  END IF;
  IF p_to_txid >= horizon OR NOT EXISTS (
    SELECT 1 FROM uts.audit_events AS target
    WHERE target.shard = p_shard AND target.txid = p_to_txid AND target.id = p_to_id
  ) THEN
    RAISE EXCEPTION 'the target row is not a final row of the shard' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO covered
  FROM (
    SELECT 1
    FROM uts.audit_events AS passed
    WHERE passed.shard = p_shard
      AND (passed.txid, passed.id) > (current.last_txid, current.last_id)
      AND (passed.txid, passed.id) <= (p_to_txid, p_to_id)
    LIMIT 501
  ) AS window_rows;
  IF covered <> p_to_seq - p_from_seq THEN
    RAISE EXCEPTION 'the move passes % rows but numbers %', covered, p_to_seq - p_from_seq
      USING ERRCODE = '22023';
  END IF;

  UPDATE uts.audit_relay_watermarks
  SET last_txid = p_to_txid, last_id = p_to_id, last_seq = p_to_seq, updated_at = now()
  WHERE shard = p_shard;
  RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION uts.advance_audit_watermark(smallint, bigint, xid8, bigint, bigint)
  TO uts_app;
