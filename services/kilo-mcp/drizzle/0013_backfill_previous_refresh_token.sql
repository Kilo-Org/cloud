-- The old guard revoked any superseded hash, so no row ever had `previous` set.
-- Every successful rotation presented the grant's then-current token, which
-- makes the second-newest row of each grant exactly the token the provider
-- still accepts after its last rotation. One statement: the row_number window
-- cannot be referenced in the same query level as the update.
UPDATE `oauth_refresh_token_history`
SET `previous` = 1
WHERE `rowid` IN (
  SELECT `rowid`
  FROM (
    SELECT
      `rowid`,
      ROW_NUMBER() OVER (
        PARTITION BY `user_id`, `grant_id`
        ORDER BY `expires_at` DESC, `rowid` DESC
      ) AS `rn`
    FROM `oauth_refresh_token_history`
  )
  WHERE `rn` = 2
);
