import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/** Used when DATABASE_URL is unset: nothing listens there, so the gateway runs in offline showcase mode. */
const OFFLINE_DATABASE_URL = 'postgresql://offline:offline@127.0.0.1:5432/aegisgate';

// Load the monorepo root .env when DATABASE_URL isn't already provided by the environment.
if (!process.env.DATABASE_URL) {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      config({ path: candidate });
      break;
    }
  }
}

/**
 * Removes `channel_binding=...` (added by Neon's connection strings). postgres.js forwards unknown
 * query params as server settings, and Postgres rejects this one.
 */
export function sanitizeDatabaseUrl(url: string): string {
  return url.replace(/([?&])channel_binding=[^&]*(&|$)/, (_match, lead: string, trail: string) => {
    if (lead === '?') return trail ? '?' : '';
    return trail ? '&' : '';
  });
}

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set; using an offline placeholder (gateway serves offline showcase data)');
}
const databaseUrl = sanitizeDatabaseUrl(process.env.DATABASE_URL || OFFLINE_DATABASE_URL);

export type Database = PostgresJsDatabase<typeof schema>;

export const queryClient = postgres(databaseUrl, { max: 10 });
export const db: Database = drizzle(queryClient, { schema });
