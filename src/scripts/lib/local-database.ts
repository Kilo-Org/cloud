import { createDrizzleClient } from '@kilocode/db/client';

const { db: localDb, pool: localPool } = createDrizzleClient({
  connectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
  poolConfig: { max: 10, application_name: 'local-kilo-script' },
  logger: true,
  ssl: false,
});

export { localDb, localPool };
