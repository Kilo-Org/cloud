CREATE ROLE "{{username}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' CONNECTION LIMIT 2 IN ROLE kilo_lease_migration;
ALTER ROLE "{{username}}" SET role = 'postgres'
