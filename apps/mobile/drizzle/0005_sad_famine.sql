-- A row per bind address: the forward editor used to leave a draft behind, so
-- a reopened sheet could store the same address twice. Keep the first of any
-- such pair before the index makes the pair impossible.
DELETE FROM `ssh_forwards`
WHERE `rowid` NOT IN (
  SELECT MIN(`rowid`) FROM `ssh_forwards`
  GROUP BY `host_id`, `direction`, `bind_host`, `bind_port`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_forwards_bind` ON `ssh_forwards` (`host_id`,`direction`,`bind_host`,`bind_port`);