import type { migrate } from 'drizzle-orm/durable-sqlite/migrator';

declare const migrations: Parameters<typeof migrate>[1];
export default migrations;
