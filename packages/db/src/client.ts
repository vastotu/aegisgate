import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Load the monorepo root .env when DATABASE_URL isn't already provided by the environment.
if (!process.env.DATABASE_URL) {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      config({ path: candidate });
      break;
    }
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set');
}

export type Database = PostgresJsDatabase<typeof schema>;

export const queryClient = postgres(databaseUrl, { max: 10 });
export const db: Database = drizzle(queryClient, { schema });
