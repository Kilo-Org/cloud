-- Security notices (design section 5.13): sign-in history with new-device and new-network
-- detection, notice delivery state with one row per channel attempt, and the views of the user
-- security page (design section 8.4).
--
-- * Every new session records a sign-in in the statement that creates it: an AFTER INSERT trigger
--   on `uts.refresh_grants` (a device sign-in, keyed by its DPoP key) and on
--   `uts.browser_sessions` (keyed by `device_key_hash` when the browser has one). The trigger
--   writes the `new_device_network` notice only when both the device and the network are new to
--   the account, so a new address alone, such as a mobile carrier or a VPN change, fires nothing.
-- * A notice row is the in-app notice, which the security page always shows. Push and email run
--   after the producing statement commits: a Worker claims the row (`pending` to `sending`), sends
--   push and then email, and finishes the claim with one attempt row per channel. A claim that
--   is not finished within 5 minutes can be claimed again, and a late finish of an older claim
--   changes nothing.
-- * Nothing here stores a link, a token or an email address in `details`. The address a notice
--   goes to is fixed when the row is written (`recipient_email`), and the previous address of an
--   email change sits in `old_email`; both are cleared when the notice is finished.
-- * Retention (`uts.maintain_notice_rows`, run by each background pass): a known device or network
--   unseen for 90 days, and a finished notice with its attempts after 400 days.

SET LOCAL ROLE uts_owner;

-- The org bot key notice kind of the PAT and bot key migration, so this migration also applies on
-- a branch without it; `IF NOT EXISTS` makes it a no-op after that migration.
ALTER TYPE uts.notice_kind ADD VALUE IF NOT EXISTS 'bot_key_flagged';

-- Delivery gains the claimed state, and the first channel to deliver moves to the attempt rows.
DROP VIEW uts_read.notices;
DROP INDEX uts.notices_pending_idx;
ALTER TABLE uts.notices
  DROP CONSTRAINT notices_delivery_shape,
  DROP COLUMN delivered_via,
  ALTER COLUMN delivery DROP DEFAULT,
  ALTER COLUMN delivery TYPE text;
DROP TYPE uts.notice_delivery;
CREATE TYPE uts.notice_delivery AS ENUM ('pending', 'sending', 'delivered', 'failed');
CREATE TYPE uts.notice_attempt_outcome AS ENUM (
  'sent', 'no_target', 'not_configured', 'retryable_failure', 'permanent_failure'
);
CREATE TYPE uts.sign_in_session_kind AS ENUM ('browser', 'device');

ALTER TABLE uts.notices
  ALTER COLUMN delivery TYPE uts.notice_delivery USING delivery::uts.notice_delivery,
  ALTER COLUMN delivery SET DEFAULT 'pending',
  -- A pending notice is due once this time has passed; a failed round moves it later.
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Delivery rounds started: one per claim, at most 3.
  ADD COLUMN rounds smallint NOT NULL DEFAULT 0 CHECK (rounds BETWEEN 0 AND 3),
  ADD COLUMN claim_id uuid,
  ADD COLUMN claimed_at timestamptz,
  -- The account's primary email when the notice was written (`uts.fill_notice_recipient`). The
  -- email goes there, and also to the address on file at sending time when that differs, so an
  -- address changed after the event cannot take the notice away from the user.
  ADD COLUMN recipient_email uts.email,
  -- The address an email change replaced: the change notice also goes there, because the new
  -- address may be the one a thief controls.
  ADD COLUMN old_email uts.email,
  ADD CONSTRAINT notices_old_email_kind CHECK (old_email IS NULL OR kind = 'primary_email_changed');

-- Rows written before this migration (none outside development) get their account's address.
UPDATE uts.notices AS notice
SET recipient_email = account.primary_email
FROM uts.accounts AS account
WHERE account.id = notice.account_id AND notice.delivery = 'pending';

ALTER TABLE uts.notices
  ADD CONSTRAINT notices_delivery_shape CHECK (
    CASE delivery
      WHEN 'pending' THEN claim_id IS NULL AND claimed_at IS NULL AND delivered_at IS NULL
        AND failed_at IS NULL AND rounds < 3 AND recipient_email IS NOT NULL
      WHEN 'sending' THEN claim_id IS NOT NULL AND claimed_at IS NOT NULL AND delivered_at IS NULL
        AND failed_at IS NULL AND rounds >= 1 AND recipient_email IS NOT NULL
      WHEN 'delivered' THEN claim_id IS NULL AND claimed_at IS NULL AND delivered_at IS NOT NULL
        AND failed_at IS NULL AND recipient_email IS NULL AND old_email IS NULL
      ELSE claim_id IS NULL AND claimed_at IS NULL AND delivered_at IS NULL
        AND failed_at IS NOT NULL AND recipient_email IS NULL AND old_email IS NULL
    END
  );
CREATE INDEX notices_due_idx ON uts.notices (next_attempt_at) WHERE delivery = 'pending';
CREATE INDEX notices_sending_idx ON uts.notices (claimed_at) WHERE delivery = 'sending';
CREATE INDEX notices_finished_idx ON uts.notices (created_at)
  WHERE delivery IN ('delivered', 'failed');

-- Every producer writes a notice with the account's current primary email as its recipient,
-- whether its statement names one or not.
CREATE FUNCTION uts.fill_notice_recipient() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.delivery = 'pending' AND NEW.recipient_email IS NULL THEN
    SELECT primary_email INTO STRICT NEW.recipient_email FROM uts.accounts WHERE id = NEW.account_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notices_fill_recipient
  BEFORE INSERT ON uts.notices
  FOR EACH ROW EXECUTE FUNCTION uts.fill_notice_recipient();

-- One row per channel tried in a delivery round, in the order tried: push, then email. In-app
-- has no row; the notice row itself is the in-app notice.
CREATE TABLE uts.notice_attempts (
  notice_id uuid NOT NULL REFERENCES uts.notices (id) ON DELETE CASCADE,
  round smallint NOT NULL CHECK (round BETWEEN 1 AND 3),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 2),
  channel uts.notice_channel NOT NULL CHECK (channel <> 'in_app'),
  outcome uts.notice_attempt_outcome NOT NULL,
  attempted_at timestamptz NOT NULL,
  PRIMARY KEY (notice_id, round, position),
  CONSTRAINT notice_attempts_channel_once UNIQUE (notice_id, round, channel)
);

-- A browser's per-install key, as a 32-byte hash the web BFF sends with the session. NULL when
-- the browser has none; such a sign-in counts as a new device (design section 5.13).
ALTER TABLE uts.browser_sessions ADD COLUMN device_key_hash uts.sha256;

-- The devices and networks each account has signed in from. A row unseen for 90 days counts as
-- new again on its next sign-in. A device is a DPoP key thumbprint or a browser's device key
-- hash; a network is the autonomous system when known, else the /24 (IPv4) or /48 (IPv6) prefix.
CREATE TABLE uts.known_devices (
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  device_key uts.sha256 NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, device_key),
  CONSTRAINT known_devices_seen_order CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX known_devices_last_seen_idx ON uts.known_devices (last_seen_at);

CREATE TABLE uts.known_networks (
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  network_key text NOT NULL CHECK (network_key ~ '^(as[0-9]{1,10}|net:[0-9a-f.:]{1,45}/(24|48))$'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, network_key),
  CONSTRAINT known_networks_seen_order CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX known_networks_last_seen_idx ON uts.known_networks (last_seen_at);

-- Recent sign-ins for the security page: the newest 50 per account. The session reference
-- becomes NULL when the session row is deleted; the kind stays.
CREATE TABLE uts.sign_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uts.account_id NOT NULL REFERENCES uts.accounts (id) ON DELETE CASCADE,
  session_kind uts.sign_in_session_kind NOT NULL,
  browser_session_id uuid REFERENCES uts.browser_sessions (id) ON DELETE SET NULL,
  device_session_id uuid REFERENCES uts.device_sessions (id) ON DELETE SET NULL,
  signed_in_at timestamptz NOT NULL DEFAULT now(),
  amr uts.auth_method[] NOT NULL
    CHECK (cardinality(amr) BETWEEN 1 AND 8 AND array_position(amr, NULL) IS NULL),
  device_label text CHECK (length(device_label) BETWEEN 1 AND 128),
  platform text CHECK (length(platform) BETWEEN 1 AND 64),
  client_ip inet,
  asn integer CHECK (asn > 0),
  country uts.country_code,
  city text CHECK (length(city) <= 128),
  new_device boolean NOT NULL,
  new_network boolean NOT NULL,
  notice_id uuid REFERENCES uts.notices (id) ON DELETE SET NULL,
  CONSTRAINT sign_ins_session_shape CHECK (
    CASE session_kind
      WHEN 'browser' THEN device_session_id IS NULL
      ELSE browser_session_id IS NULL
    END
  ),
  CONSTRAINT sign_ins_notice_shape CHECK (notice_id IS NULL OR (new_device AND new_network))
);
CREATE INDEX sign_ins_account_idx ON uts.sign_ins (account_id, signed_in_at);
-- Deleting a notice (retention, `uts.maintain_notice_rows`) sets `notice_id` NULL in the sign-ins
-- that name it; this index makes that a probe instead of a scan of every sign-in per notice.
CREATE INDEX sign_ins_notice_idx ON uts.sign_ins (notice_id) WHERE notice_id IS NOT NULL;

-- The network a sign-in came from: `as<number>` when the autonomous system is known, else the
-- client address's /24 or /48 prefix, else NULL (nothing to compare).
CREATE FUNCTION uts.network_key(p_client_ip inet, p_asn integer) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
RETURN CASE
  WHEN p_asn IS NOT NULL THEN 'as' || p_asn
  WHEN p_client_ip IS NULL THEN NULL
  ELSE 'net:' || host(network(set_masklen(
    p_client_ip, CASE family(p_client_ip) WHEN 4 THEN 24 ELSE 48 END
  ))) || CASE family(p_client_ip) WHEN 4 THEN '/24' ELSE '/48' END
END;

-- Records one sign-in and, when both its device and its network are new to the account, writes
-- the `new_device_network` notice. Returns the notice id, or NULL.
--
-- `new` is decided by the upsert itself: a row this statement inserted, or one unseen for 90 days
-- that it renewed, has `first_seen_at = now()`. Two concurrent sign-ins from one new device and
-- network serialize on the primary key, so the second sees the first's row and fires nothing.
-- A NULL device key (no per-install key) is always new; a NULL network key never is, because
-- there is nothing to compare.
--
-- The first sign-in of an account sets the baseline and fires nothing. An account has a baseline
-- once it has a known network, a recorded sign-in, or another live session: an account whose
-- sessions predate this migration, or carried no network, is not treated as new.
--
-- The notice carries only facts the sign-in cannot choose: the kind of client from a closed list
-- (`browser`, `desktop`, `mobile`), the approximate place from the network, and the sign-in
-- methods. The device label and platform the client sent stay in `uts.sign_ins` for the security
-- page, never in a notice text (design section 5.13).
CREATE FUNCTION uts.record_sign_in(
  p_account_id text,
  p_session_kind uts.sign_in_session_kind,
  p_session_id uuid,
  p_device_key bytea,
  p_device_kind text,
  p_amr uts.auth_method[],
  p_device_label text,
  p_platform text,
  p_client_ip inet,
  p_asn integer,
  p_country text,
  p_city text
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  net_key text := uts.network_key(p_client_ip, p_asn);
  has_baseline boolean;
  device_new boolean := true;
  network_new boolean := false;
  new_notice_id uuid;
BEGIN
  IF p_device_kind NOT IN ('browser', 'desktop', 'mobile') THEN
    RAISE EXCEPTION 'unknown device kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  has_baseline := EXISTS (SELECT 1 FROM uts.known_networks WHERE account_id = p_account_id)
    OR EXISTS (SELECT 1 FROM uts.sign_ins WHERE account_id = p_account_id)
    OR EXISTS (
      SELECT 1 FROM uts.device_sessions
      WHERE account_id = p_account_id AND status = 'active' AND id <> p_session_id
    )
    OR EXISTS (
      SELECT 1 FROM uts.browser_sessions
      WHERE account_id = p_account_id AND status = 'active' AND id <> p_session_id
    );

  IF p_device_key IS NOT NULL THEN
    INSERT INTO uts.known_devices AS known (account_id, device_key, first_seen_at, last_seen_at)
    VALUES (p_account_id, p_device_key, now(), now())
    ON CONFLICT (account_id, device_key) DO UPDATE SET
      last_seen_at = now(),
      first_seen_at = CASE
        WHEN known.last_seen_at < now() - interval '90 days' THEN now()
        ELSE known.first_seen_at
      END
    RETURNING known.first_seen_at = now() INTO device_new;
  END IF;

  IF net_key IS NOT NULL THEN
    INSERT INTO uts.known_networks AS known (account_id, network_key, first_seen_at, last_seen_at)
    VALUES (p_account_id, net_key, now(), now())
    ON CONFLICT (account_id, network_key) DO UPDATE SET
      last_seen_at = now(),
      first_seen_at = CASE
        WHEN known.last_seen_at < now() - interval '90 days' THEN now()
        ELSE known.first_seen_at
      END
    RETURNING known.first_seen_at = now() INTO network_new;
  END IF;

  IF has_baseline AND device_new AND network_new THEN
    INSERT INTO uts.notices (account_id, kind, details)
    VALUES (
      p_account_id, 'new_device_network',
      jsonb_strip_nulls(jsonb_build_object(
        'sessionKind', p_session_kind,
        'deviceKind', p_device_kind,
        'country', p_country,
        'city', p_city,
        'methods', to_jsonb(p_amr::text[])
      ))
    )
    RETURNING id INTO new_notice_id;
  END IF;

  INSERT INTO uts.sign_ins (
    account_id, session_kind, browser_session_id, device_session_id, amr, device_label, platform,
    client_ip, asn, country, city, new_device, new_network, notice_id
  ) VALUES (
    p_account_id, p_session_kind,
    CASE p_session_kind WHEN 'browser' THEN p_session_id END,
    CASE p_session_kind WHEN 'device' THEN p_session_id END,
    p_amr, p_device_label, p_platform, p_client_ip, p_asn, p_country, p_city,
    device_new, network_new, new_notice_id
  );

  -- Keep the newest 50 sign-ins of the account (one probe of `sign_ins_account_idx`).
  DELETE FROM uts.sign_ins
  WHERE id IN (
    SELECT old.id FROM uts.sign_ins AS old
    WHERE old.account_id = p_account_id
    ORDER BY old.signed_in_at DESC
    OFFSET 50
  );

  RETURN new_notice_id;
END
$$;

-- A first-party refresh grant is one device sign-in: its DPoP key is the device, its device
-- session holds the network. The trigger runs as the table owner, inside the granting statement.
CREATE FUNCTION uts.record_device_sign_in() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  device_session uts.device_sessions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT device_session FROM uts.device_sessions WHERE id = NEW.device_session_id;
  PERFORM uts.record_sign_in(
    NEW.account_id, 'device', device_session.id, NEW.dpop_jkt, device_session.client_class::text,
    device_session.amr, device_session.device_label, device_session.platform,
    device_session.client_ip, device_session.asn, device_session.country, device_session.city
  );
  RETURN NULL;
END
$$;
CREATE TRIGGER refresh_grants_record_sign_in
  AFTER INSERT ON uts.refresh_grants
  FOR EACH ROW EXECUTE FUNCTION uts.record_device_sign_in();

CREATE FUNCTION uts.record_browser_sign_in() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM uts.record_sign_in(
    NEW.account_id, 'browser', NEW.id, NEW.device_key_hash, 'browser', NEW.amr,
    NULLIF(left(NEW.user_agent, 128), ''), NULL, NEW.client_ip, NEW.asn, NEW.country, NEW.city
  );
  RETURN NULL;
END
$$;
CREATE TRIGGER browser_sessions_record_sign_in
  AFTER INSERT ON uts.browser_sessions
  FOR EACH ROW EXECUTE FUNCTION uts.record_browser_sign_in();

-- The baseline of every account that already holds live sessions: their device keys and
-- networks, so the first sign-in after this migration is compared with them (design 5.13).
INSERT INTO uts.known_devices (account_id, device_key, first_seen_at, last_seen_at)
SELECT grant_row.account_id, grant_row.dpop_jkt, min(grant_row.created_at),
  max(greatest(grant_row.created_at, grant_row.last_used_at))
FROM uts.refresh_grants AS grant_row
WHERE grant_row.status = 'active'
GROUP BY grant_row.account_id, grant_row.dpop_jkt;

INSERT INTO uts.known_networks (account_id, network_key, first_seen_at, last_seen_at)
SELECT live.account_id, live.network_key, min(live.created_at),
  max(greatest(live.created_at, live.last_seen_at))
FROM (
  SELECT account_id, uts.network_key(client_ip, asn) AS network_key, created_at, last_seen_at
  FROM uts.device_sessions WHERE status = 'active'
  UNION ALL
  SELECT account_id, uts.network_key(client_ip, asn), created_at, last_seen_at
  FROM uts.browser_sessions WHERE status = 'active'
) AS live
WHERE live.network_key IS NOT NULL
GROUP BY live.account_id, live.network_key;

-- What a Worker needs to deliver a claimed notice: the address fixed when the notice was written,
-- the account's primary email now (the email also goes there when it differs), the previous
-- address of an email change, and the channels an earlier round already settled, which this
-- round skips.
CREATE TYPE uts.claimed_notice AS (
  notice_id uuid,
  claim_id uuid,
  account_id text,
  kind uts.notice_kind,
  details jsonb,
  created_at timestamptz,
  round smallint,
  recipient_email text,
  primary_email text,
  old_email text,
  settled_channels uts.notice_channel[]
);

-- Claims the given notices that are due: pending with `next_attempt_at` passed and written in the
-- last 24 hours, or sending under a claim older than 5 minutes (its Worker stopped before
-- finishing) and before its third round. Rows another statement holds are skipped, so two
-- Workers never claim one notice at once.
CREATE FUNCTION uts.claim_notice_rows(p_ids uuid[]) RETURNS SETOF uts.claimed_notice
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT notice.id FROM uts.notices AS notice
    WHERE notice.id = ANY (p_ids)
      AND (
        (notice.delivery = 'pending' AND notice.next_attempt_at <= now()
          AND notice.created_at >= now() - interval '24 hours')
        OR (notice.delivery = 'sending' AND notice.claimed_at < now() - interval '5 minutes'
            AND notice.rounds < 3)
      )
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE uts.notices AS notice
    SET delivery = 'sending', claim_id = gen_random_uuid(), claimed_at = now(),
      rounds = notice.rounds + 1
    FROM due
    WHERE notice.id = due.id
    RETURNING notice.*
  )
  SELECT claimed.id, claimed.claim_id, claimed.account_id::text, claimed.kind, claimed.details,
    claimed.created_at, claimed.rounds, claimed.recipient_email::text,
    account.primary_email::text, claimed.old_email::text,
    ARRAY(
      SELECT DISTINCT attempt.channel FROM uts.notice_attempts AS attempt
      WHERE attempt.notice_id = claimed.id
        AND attempt.outcome IN ('sent', 'no_target', 'not_configured', 'permanent_failure')
      ORDER BY attempt.channel
    )
  FROM claimed
  JOIN uts.accounts AS account ON account.id = claimed.account_id
$$;

-- Claims one notice right after the statement that wrote it, such as `POST /account/pats`.
CREATE FUNCTION uts.claim_notice(p_notice_id uuid) RETURNS SETOF uts.claimed_notice
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM uts.claim_notice_rows(ARRAY[p_notice_id])
$$;

-- Claims the `credential_created` notice that the create statement wrote for one PAT or org bot
-- key. Only a pending notice of the last hour qualifies, so the read is a range of
-- `notices_account_idx` that an account's older notices do not lengthen.
CREATE FUNCTION uts.claim_credential_notice(
  p_account_id text,
  p_credential text,
  p_credential_id uuid
) RETURNS SETOF uts.claimed_notice
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM uts.claim_notice_rows(ARRAY(
    SELECT notice.id FROM uts.notices AS notice
    WHERE notice.account_id = p_account_id
      AND notice.created_at > now() - interval '1 hour'
      AND notice.delivery = 'pending'
      AND notice.kind = 'credential_created'
      AND notice.details @> jsonb_build_object(
        'credential', p_credential,
        CASE p_credential WHEN 'pat' THEN 'patId' ELSE 'botKeyId' END, p_credential_id
      )
  ))
$$;

-- The background pass: up to `p_limit` due notices, oldest first. A pending notice older than 24
-- hours is no longer sent, and a third-round claim that was never finished is not retried: each is
-- delivered when an earlier attempt sent it, else failed (its in-app row stays). Up to 500 such
-- rows are settled per call; the claim itself never takes them, so a larger backlog only waits
-- for the next calls and never delays fresh notices.
CREATE FUNCTION uts.claim_due_notices(p_limit integer) RETURNS SETOF uts.claimed_notice
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'claim between 1 and 100 notices' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH given_up AS (
    SELECT stale.id,
      EXISTS (
        SELECT 1 FROM uts.notice_attempts AS attempt
        WHERE attempt.notice_id = stale.id AND attempt.outcome = 'sent'
      ) AS sent
    FROM uts.notices AS stale
    WHERE (stale.delivery = 'pending' AND stale.next_attempt_at <= now()
        AND stale.created_at < now() - interval '24 hours')
      OR (stale.delivery = 'sending' AND stale.rounds = 3
        AND stale.claimed_at < now() - interval '5 minutes')
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  )
  UPDATE uts.notices AS notice
  SET delivery = CASE WHEN given_up.sent THEN 'delivered' ELSE 'failed' END::uts.notice_delivery,
    delivered_at = CASE WHEN given_up.sent THEN now() END,
    failed_at = CASE WHEN given_up.sent THEN NULL ELSE now() END,
    claim_id = NULL, claimed_at = NULL, recipient_email = NULL, old_email = NULL
  FROM given_up
  WHERE notice.id = given_up.id;
  RETURN QUERY SELECT * FROM uts.claim_notice_rows(ARRAY(
    SELECT due.id FROM (
      (SELECT pending.id, pending.next_attempt_at AS due_at FROM uts.notices AS pending
       WHERE pending.delivery = 'pending' AND pending.next_attempt_at <= now()
         AND pending.created_at >= now() - interval '24 hours'
       ORDER BY pending.next_attempt_at LIMIT p_limit)
      UNION ALL
      (SELECT sending.id, sending.claimed_at FROM uts.notices AS sending
       WHERE sending.delivery = 'sending' AND sending.claimed_at < now() - interval '5 minutes'
         AND sending.rounds < 3
       ORDER BY sending.claimed_at LIMIT p_limit)
    ) AS due
    ORDER BY due.due_at
    LIMIT p_limit
  ));
END
$$;

-- Finishes a claim with this round's attempts, in the order tried (`p_attempts`: a JSON array of
-- `{"channel", "outcome", "attemptedAt"}`). `p_planned` is every out-of-band channel the notice's
-- kind uses. The notice is delivered once a channel sent it, failed when none did, and pending
-- again (1 minute after round 1, 5 after round 2) while a planned channel only failed in a way
-- that can succeed later. Outcomes: `finished` with the new delivery state, or `stale_claim` when
-- `p_claim_id` is not the notice's current claim (a late finish changes nothing).
CREATE FUNCTION uts.finish_notice(
  p_notice_id uuid,
  p_claim_id uuid,
  p_planned uts.notice_channel[],
  p_attempts jsonb
) RETURNS TABLE (outcome text, delivery uts.notice_delivery)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  notice uts.notices%ROWTYPE;
  unsettled boolean;
  any_sent boolean;
  next_state uts.notice_delivery;
BEGIN
  SELECT * INTO notice FROM uts.notices AS claimed
  WHERE claimed.id = p_notice_id AND claimed.claim_id = p_claim_id
    AND claimed.delivery = 'sending'
  FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'stale_claim';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO uts.notice_attempts (notice_id, round, position, channel, outcome, attempted_at)
  SELECT p_notice_id, notice.rounds, attempt.position::smallint, attempt.channel, attempt.outcome,
    attempt.attempted_at
  FROM ROWS FROM (
    jsonb_to_recordset(p_attempts) AS (
      channel uts.notice_channel, outcome uts.notice_attempt_outcome, "attemptedAt" timestamptz
    )
  ) WITH ORDINALITY AS attempt(channel, outcome, attempted_at, position);

  SELECT EXISTS (
    SELECT 1 FROM uts.notice_attempts AS attempt
    WHERE attempt.notice_id = p_notice_id AND attempt.outcome = 'sent'
  ) INTO any_sent;
  SELECT EXISTS (
    SELECT 1 FROM unnest(p_planned) AS planned(channel)
    WHERE NOT EXISTS (
      SELECT 1 FROM uts.notice_attempts AS attempt
      WHERE attempt.notice_id = p_notice_id AND attempt.channel = planned.channel
        AND attempt.outcome <> 'retryable_failure'
    )
  ) INTO unsettled;

  IF unsettled AND notice.rounds < 3 THEN
    next_state := 'pending';
    UPDATE uts.notices AS target
    SET delivery = 'pending', claim_id = NULL, claimed_at = NULL,
      next_attempt_at = now() + CASE notice.rounds WHEN 1 THEN interval '1 minute'
        ELSE interval '5 minutes' END
    WHERE target.id = p_notice_id;
  ELSIF any_sent THEN
    next_state := 'delivered';
    UPDATE uts.notices AS target
    SET delivery = 'delivered', delivered_at = now(), claim_id = NULL, claimed_at = NULL,
      recipient_email = NULL, old_email = NULL
    WHERE target.id = p_notice_id;
  ELSE
    next_state := 'failed';
    UPDATE uts.notices AS target
    SET delivery = 'failed', failed_at = now(), claim_id = NULL, claimed_at = NULL,
      recipient_email = NULL, old_email = NULL
    WHERE target.id = p_notice_id;
  END IF;
  outcome := 'finished';
  delivery := next_state;
  RETURN NEXT;
END
$$;

-- Retention, one bounded step per call (each background pass runs it): known devices and
-- networks unseen for 90 days (they count as new again anyway), and finished notices with their
-- attempts 400 days after they were written. Each kind deletes at most `p_batch` rows.
CREATE FUNCTION uts.maintain_notice_rows(p_batch integer)
RETURNS TABLE (kind text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_batch NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'delete between 1 and 5000 rows' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM uts.known_devices AS known
  WHERE (known.account_id, known.device_key) IN (
    SELECT stale.account_id, stale.device_key FROM uts.known_devices AS stale
    WHERE stale.last_seen_at < now() - interval '90 days'
    LIMIT p_batch
  );
  kind := 'known_devices';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.known_networks AS known
  WHERE (known.account_id, known.network_key) IN (
    SELECT stale.account_id, stale.network_key FROM uts.known_networks AS stale
    WHERE stale.last_seen_at < now() - interval '90 days'
    LIMIT p_batch
  );
  kind := 'known_networks';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;

  DELETE FROM uts.notices AS notice
  WHERE notice.id IN (
    SELECT old.id FROM uts.notices AS old
    WHERE old.delivery IN ('delivered', 'failed') AND old.created_at < now() - interval '400 days'
    LIMIT p_batch
  );
  kind := 'notices';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN NEXT;
END
$$;

-- Views for the security page, read through the replica config. They leave out client addresses,
-- device keys and the recipient and old addresses of a notice.
CREATE VIEW uts_read.notices AS
  SELECT id, account_id, kind, details, created_at, delivery, delivered_at, failed_at, read_at
  FROM uts.notices;

CREATE VIEW uts_read.notice_attempts AS
  SELECT notice_id, round, position, channel, outcome, attempted_at
  FROM uts.notice_attempts;

CREATE VIEW uts_read.sign_ins AS
  SELECT id, account_id, session_kind, browser_session_id, device_session_id, signed_in_at, amr,
    device_label, platform, asn, country, city, new_device, new_network, notice_id
  FROM uts.sign_ins;

GRANT SELECT ON uts_read.notices, uts_read.notice_attempts, uts_read.sign_ins TO uts_reader;

-- The app login reads these tables and writes them only through the functions above.
GRANT SELECT ON uts.notice_attempts, uts.known_devices, uts.known_networks, uts.sign_ins
  TO uts_app;
GRANT EXECUTE ON FUNCTION
  uts.claim_notice(uuid),
  uts.claim_credential_notice(text, text, uuid),
  uts.claim_due_notices(integer),
  uts.finish_notice(uuid, uuid, uts.notice_channel[], jsonb),
  uts.maintain_notice_rows(integer)
TO uts_app;
