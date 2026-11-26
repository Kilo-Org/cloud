SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usename = '{{username}}';
DROP ROLE IF EXISTS "{{username}}"
