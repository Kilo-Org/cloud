-- Audit rows that double as the outbox (design sections 8.1, 8.2 and 8.5).
--
-- * A credential statement inserts its audit row in the same SQL statement, so both commit
--   together.
-- * `txid` is the inserting transaction's id. The relay reads only rows whose `txid` is below the
--   oldest open transaction, ordered by (`txid`, `id`), so a row that commits late is never
--   skipped.
-- * `shard` is `id` modulo 8; one relay instance owns each shard and keeps one watermark row.
--   Each shard publishes as its own audit stream, so `last_seq` numbers that stream's batches.
-- * Daily partitions hold 7 days. A partition is dropped only when every row in it is older than
--   7 days and every shard's watermark is past every row in it. Maintenance runs one CREATE,
--   TRUNCATE or DROP per call, after every check; an old partition is truncated before it is
--   dropped, so the parent's ACCESS EXCLUSIVE lock covers only removing empty files.
-- * Only the owner can update or delete audit rows; the app role can insert and read them, and
--   cannot set `id`, `txid` or `created_at` itself.

SET LOCAL ROLE uts_owner;

-- `true` when `event` is an `AuditEvent` (`AuditEventSchema` in `@kilocode/sts-contracts`) that
-- UTS may produce: a UTS source and event type, one of the three OCSF classes in use, and no key
-- the strict schema would refuse. The relay cannot skip a row without breaking its stream's
-- sequence, so a row that the relay could not parse must never commit.
-- `test/db/audit-outbox.test.ts` checks this function and the schema against the same cases.
--
-- * String limits use `octet_length`: a UTF-8 byte count is never below the UTF-16 length that
--   the contract's `.max()` counts, so these limits are never looser than the contract's.
-- * The leading WHEN branches settle every JSON type and the time format first (CASE evaluates
--   them in order), so the casts and `jsonb_each` in the last branch never raise.
CREATE FUNCTION uts.is_audit_event(event jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN CASE
  WHEN jsonb_typeof(event) <> 'object'
    OR jsonb_typeof(event -> 'data') IS DISTINCT FROM 'object'
    OR jsonb_typeof(event #> '{data,actor}') IS DISTINCT FROM 'object'
    OR jsonb_typeof(event #> '{data,attributes}') IS DISTINCT FROM 'object'
    OR jsonb_typeof(event #> '{data,classUid}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(event #> '{data,activityId}') IS DISTINCT FROM 'number'
  THEN false
  -- An RFC 3339 UTC time with seconds, as `z.iso.datetime()` accepts it; the day of the month is
  -- checked against the month's length below.
  WHEN jsonb_typeof(event -> 'time') IS DISTINCT FROM 'string'
    OR event ->> 'time'
      !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$'
  THEN false
  ELSE coalesce(
    (event - ARRAY['specversion', 'id', 'source', 'type', 'time', 'datacontenttype', 'data'])
      = '{}'::jsonb
    AND event @> '{"specversion": "1.0", "datacontenttype": "application/json"}'::jsonb
    AND jsonb_typeof(event -> 'id') = 'string'
    AND event ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(event -> 'source') = 'string'
    AND event ->> 'source' ~ '^kilo:uts:(development|staging|production)$'
    AND jsonb_typeof(event -> 'type') = 'string'
    AND event ->> 'type' ~ '^ai\.kilo\.uts(\.[a-z0-9_]+)+$'
    AND substr(event ->> 'time', 9, 2)::integer <= CASE substr(event ->> 'time', 6, 2)
      WHEN '02' THEN CASE
        WHEN substr(event ->> 'time', 1, 4)::integer % 400 = 0
          OR (substr(event ->> 'time', 1, 4)::integer % 4 = 0
            AND substr(event ->> 'time', 1, 4)::integer % 100 <> 0)
        THEN 29
        ELSE 28
      END
      WHEN '04' THEN 30
      WHEN '06' THEN 30
      WHEN '09' THEN 30
      WHEN '11' THEN 30
      ELSE 31
    END
    AND ((event -> 'data')
      - ARRAY['classUid', 'activityId', 'outcome', 'outcomeDetail', 'actor', 'attributes'])
      = '{}'::jsonb
    AND (event #> '{data,classUid}')::numeric IN (3001, 3002, 6003)
    AND (event #> '{data,activityId}')::numeric BETWEEN 0 AND 9007199254740991
    AND (event #> '{data,activityId}')::numeric = trunc((event #> '{data,activityId}')::numeric)
    AND jsonb_typeof(event #> '{data,outcome}') = 'string'
    AND event #>> '{data,outcome}' IN ('success', 'failure', 'denied')
    AND (
      NOT ((event -> 'data') ? 'outcomeDetail')
      OR (
        jsonb_typeof(event #> '{data,outcomeDetail}') = 'string'
        AND octet_length(event #>> '{data,outcomeDetail}') <= 512
      )
    )
    AND ((event #> '{data,actor}') - ARRAY['kind', 'id']) = '{}'::jsonb
    AND jsonb_typeof(event #> '{data,actor,kind}') = 'string'
    AND event #>> '{data,actor,kind}' IN ('workload', 'user', 'service', 'system')
    AND jsonb_typeof(event #> '{data,actor,id}') = 'string'
    AND length(event #>> '{data,actor,id}') >= 1
    AND octet_length(event #>> '{data,actor,id}') <= 256
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(event #> '{data,attributes}') AS attribute
      WHERE attribute.key !~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'
        OR NOT CASE jsonb_typeof(attribute.value)
          WHEN 'string' THEN octet_length(attribute.value #>> '{}') <= 512
          -- A JSON number past the double range parses to Infinity, which `z.number()` refuses.
          WHEN 'number' THEN abs(attribute.value::numeric) <= 1.7976931348623157e308
          WHEN 'boolean' THEN true
          WHEN 'array' THEN jsonb_array_length(attribute.value) <= 256
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(attribute.value) AS item
              WHERE jsonb_typeof(item) <> 'string' OR octet_length(item #>> '{}') > 256
            )
          ELSE false
        END
    ),
    false
  )
END;

CREATE TABLE uts.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  shard smallint NOT NULL GENERATED ALWAYS AS ((id % 8)::smallint) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The CloudEvents `id`; sinks dedupe on it.
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^ai\.kilo\.uts(\.[a-z0-9_]+)+$'),
  -- The subject account, for the user's own audit view; never an email address.
  account_id text CHECK (length(account_id) BETWEEN 1 AND 255),
  -- The full CloudEvents 1.0 envelope with its OCSF payload. It never carries a token value, a
  -- secret, or a key. 8 KB per row keeps one row far below the 60 KB compressed and 1 MiB
  -- decompressed limits of one queue message, so the relay can always send a row alone.
  event jsonb NOT NULL,
  PRIMARY KEY (id, created_at),
  -- `IS TRUE`: a missing key yields NULL, which a bare CHECK would let through.
  CONSTRAINT audit_events_envelope CHECK ((
    uts.is_audit_event(event)
    AND event ->> 'id' = event_id::text
    AND event ->> 'type' = event_type
    AND octet_length(event::text) <= 8192
  ) IS TRUE),
  -- A last check before the archive, which keeps rows for 400 days (design section 8.2): no
  -- token value (`kilo_pat_`, `kilo_rt_` or `kilo_bot_` with at least 16 body characters, or a JWT,
  -- whose header always starts `eyJ`) anywhere in the event, and no bare email address as the
  -- account or the actor. A mention of a prefix alone, such as "malformed kilo_pat_ value", passes.
  CONSTRAINT audit_events_no_credential CHECK (
    event::text !~ 'kilo_(pat|rt|bot)_[A-Za-z0-9_-]{16,}'
    AND event::text !~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.'
    AND coalesce(account_id, '') !~ '^[^@[:space:]/:]+@[^@[:space:]/:]+\.[^@[:space:]/:]+$'
    AND coalesce(event #>> '{data,actor,id}', '')
      !~ '^[^@[:space:]/:]+@[^@[:space:]/:]+\.[^@[:space:]/:]+$'
  )
) PARTITION BY RANGE (created_at);

-- The relay's read: one shard, rows past its watermark, in (txid, id) order. The read and the
-- partition check both put the row comparison `(txid, id) > (last_txid, last_id)` in the index
-- condition, so neither reads a relayed row (README, "Audit outbox").
CREATE INDEX audit_events_relay_idx ON uts.audit_events (shard, txid, id);

-- One row per shard. `last_txid` and `last_id` mark the newest row the relay has delivered and
-- the archive has confirmed. `last_seq` is the stream sequence number of that row, so batches
-- carry contiguous `fromSeq`/`toSeq` values per shard.
CREATE TABLE uts.audit_relay_watermarks (
  shard smallint PRIMARY KEY CHECK (shard BETWEEN 0 AND 7),
  last_txid xid8 NOT NULL DEFAULT '0',
  last_id bigint NOT NULL DEFAULT 0 CHECK (last_id >= 0),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO uts.audit_relay_watermarks (shard) SELECT generate_series(0, 7);

-- The partition check, as SQL text: `true` when a row of partition `p_partition` is past its
-- shard's watermark. Each shard is one probe of the partition's (shard, txid, id) index that
-- starts after the watermark, so a relayed partition costs 8 probes and reads no row.
-- `test/db/audit-maintenance.test.ts` plans this exact text.
CREATE FUNCTION uts.audit_partition_unrelayed_query(p_partition text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN format(
  'SELECT EXISTS (
     SELECT 1
     FROM uts.audit_relay_watermarks AS watermark
     CROSS JOIN LATERAL (
       SELECT 1
       FROM uts.%I AS event
       WHERE event.shard = watermark.shard
         AND (event.txid, event.id) > (watermark.last_txid, watermark.last_id)
       ORDER BY event.txid, event.id
       LIMIT 1
     ) AS unrelayed
   )',
  p_partition
);

-- One maintenance step for the UTC day of `p_now`. It creates the first missing partition among
-- that day and the next `p_days_ahead` days. When none is missing, it takes the first partition
-- whose rows are all older than 7 days and all relayed: it truncates that partition while it still
-- has data, and drops it once it is empty. Partition names carry their UTC day,
-- `audit_events_YYYYMMDD`; a partition with any other name (one added by hand) is left alone.
--
-- * At most one CREATE, TRUNCATE or DROP runs per call, as its last statement, after every check.
-- * The TRUNCATE locks only the old partition, which no insert reaches, so it can take as long as
--   removing the data takes. The DROP that follows locks the parent table with ACCESS EXCLUSIVE,
--   but only to remove empty files, so that lock lasts only for the catalog change and the commit.
-- * The caller repeats the call until it returns no `created`, `truncated` or `dropped` row.
-- * Every call also returns one `kept_unrelayed` row for each old partition that still holds an
--   unrelayed row.
CREATE FUNCTION uts.audit_partition_maintenance_at(p_now timestamptz, p_days_ahead integer)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
-- While a DDL waits for its lock, later inserts queue behind it, so the wait is short. A call that
-- times out changes nothing and the next call retries.
SET lock_timeout = '200ms'
AS $maintenance$
DECLARE
  first_day date := (p_now AT TIME ZONE 'UTC')::date;
  partition_day date;
  partition_table text;
  has_unrelayed boolean;
  drop_table text;
BEGIN
  IF p_days_ahead IS NULL OR p_days_ahead NOT BETWEEN 1 AND 31 THEN
    RAISE EXCEPTION 'p_days_ahead must be between 1 and 31' USING ERRCODE = '22023';
  END IF;

  SELECT day::date INTO partition_day
  FROM generate_series(first_day, first_day + p_days_ahead, interval '1 day') AS day
  WHERE to_regclass(format('uts.%I', 'audit_events_' || to_char(day, 'YYYYMMDD'))) IS NULL
  ORDER BY day
  LIMIT 1;
  IF FOUND THEN
    partition_table := 'audit_events_' || to_char(partition_day, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE uts.%I PARTITION OF uts.audit_events FOR VALUES FROM (%L) TO (%L)',
      partition_table,
      partition_day::timestamp AT TIME ZONE 'UTC',
      (partition_day + 1)::timestamp AT TIME ZONE 'UTC'
    );
    action := 'created';
    partition_name := partition_table;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR partition_table IN
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
    WHERE pg_inherits.inhparent = 'uts.audit_events'::regclass
      AND child.relname ~ '^audit_events_[0-9]{8}$'
    ORDER BY child.relname
  LOOP
    partition_day := to_date(right(partition_table, 8), 'YYYYMMDD');
    -- Keep a partition until its newest possible row is 7 days old.
    CONTINUE WHEN (partition_day + 1)::timestamp AT TIME ZONE 'UTC' > p_now - interval '7 days';

    EXECUTE uts.audit_partition_unrelayed_query(partition_table) INTO has_unrelayed;
    IF has_unrelayed THEN
      action := 'kept_unrelayed';
      partition_name := partition_table;
      RETURN NEXT;
    ELSIF drop_table IS NULL THEN
      drop_table := partition_table;
    END IF;
  END LOOP;

  IF drop_table IS NULL THEN
    RETURN;
  END IF;
  partition_name := drop_table;
  IF pg_relation_size(format('uts.%I', drop_table)::regclass) > 0 THEN
    EXECUTE format('TRUNCATE uts.%I', drop_table);
    action := 'truncated';
  ELSE
    EXECUTE format('DROP TABLE uts.%I', drop_table);
    action := 'dropped';
  END IF;
  RETURN NEXT;
END
$maintenance$;

-- The entry point that the UTS cron calls through the app role: always the current time and a
-- 7-day lead, so a caller cannot move the drop cutoff. Each call is one statement, so through
-- Hyperdrive each step is its own short transaction.
CREATE FUNCTION uts.maintain_audit_partitions()
RETURNS TABLE (action text, partition_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM uts.audit_partition_maintenance_at(now(), 7)
$$;

-- Today's partition and the next 7 days' exist before the first insert.
DO $initial_partitions$
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM uts.audit_partition_maintenance_at(now(), 7) WHERE action = 'created'
  ) LOOP
    NULL;
  END LOOP;
END
$initial_partitions$;
