if (!process.env.POSTGRES_URL) {
  throw new Error('Set POSTGRES_URL to a migrated test database before running the Postgres suite');
}
