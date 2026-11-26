SELECT kilo_lease.check_username('{{username}}');
CREATE ROLE "{{username}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' CONNECTION LIMIT 2 IN ROLE kilo_lease_migration;
GRANT "{{username}}" TO kilo_lease_migration_admin WITH INHERIT TRUE, SET FALSE;
ALTER ROLE "{{username}}" SET role = 'postgres'
