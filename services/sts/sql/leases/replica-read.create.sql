SELECT kilo_lease.check_username('{{username}}');
CREATE ROLE "{{username}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' CONNECTION LIMIT 4 IN ROLE kilo_lease_replica_read;
GRANT "{{username}}" TO kilo_lease_replica_admin WITH INHERIT TRUE, SET FALSE;
ALTER ROLE "{{username}}" SET default_transaction_read_only = on;
ALTER ROLE "{{username}}" SET statement_timeout = '60s';
ALTER ROLE "{{username}}" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE "{{username}}" SET idle_session_timeout = '15min'
