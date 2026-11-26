CREATE ROLE "{{username}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' CONNECTION LIMIT 4 IN ROLE kilo_lease_replica_read;
ALTER ROLE "{{username}}" SET default_transaction_read_only = on;
ALTER ROLE "{{username}}" SET statement_timeout = '60s'
