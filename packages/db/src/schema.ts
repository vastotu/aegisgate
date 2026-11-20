import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  description: text('description'),
  upstreamUrl: varchar('upstream_url', { length: 512 }).notNull(),
  monthlyBudgetCredits: bigint('monthly_budget_credits', { mode: 'number' }).notNull().default(100000),
  /** Revenue per credit (USD). */
  creditUnitPriceUsd: numeric('credit_unit_price_usd', { precision: 10, scale: 6 }).notNull().default('0.001000'),
  /** Cloud unit cost per request (USD), used for FinOps margin calculation. */
  infraCostPerReqUsd: numeric('infra_cost_per_req_usd', { precision: 10, scale: 6 }).notNull().default('0.000150'),
  isShowcaseTenant: boolean('is_showcase_tenant').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  keyPrefix: varchar('key_prefix', { length: 32 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const rateLimitRules = pgTable('rate_limit_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  routePattern: varchar('route_pattern', { length: 255 }).notNull(),
  httpMethod: varchar('http_method', { length: 16 }).notNull().default('ALL'),
  algorithm: varchar('algorithm', { length: 32 }).notNull().default('token_bucket'),
  limitCount: integer('limit_count').notNull().default(100),
  windowSec: integer('window_sec').notNull().default(60),
  burstCapacity: integer('burst_capacity').notNull().default(120),
  costWeightCredits: integer('cost_weight_credits').notNull().default(1),
  priority: integer('priority').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Null for global platform accounts. */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  accountCode: varchar('account_code', { length: 64 }).notNull().unique(),
  accountType: varchar('account_type', { length: 32 }).notNull(),
  balanceCredits: bigint('balance_credits', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    direction: varchar('direction', { length: 10 }).notNull(),
    amountCredits: bigint('amount_credits', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    prevHash: varchar('prev_hash', { length: 64 }).notNull(),
    entryHash: varchar('entry_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('ledger_entries_project_created_idx').on(t.projectId, t.createdAt)],
);

export const apiUsageLogs = pgTable(
  'api_usage_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    route: varchar('route', { length: 255 }).notNull(),
    method: varchar('method', { length: 16 }).notNull(),
    statusCode: integer('status_code').notNull(),
    latencyMs: numeric('latency_ms', { precision: 8, scale: 2 }).notNull(),
    costCredits: integer('cost_credits').notNull().default(1),
    clientIp: varchar('client_ip', { length: 64 }).notNull(),
    blockedReason: varchar('blocked_reason', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('api_usage_logs_project_created_idx').on(t.projectId, t.createdAt),
    index('api_usage_logs_status_created_idx').on(t.statusCode, t.createdAt),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type RateLimitRule = typeof rateLimitRules.$inferSelect;
export type NewRateLimitRule = typeof rateLimitRules.$inferInsert;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type ApiUsageLog = typeof apiUsageLogs.$inferSelect;
export type NewApiUsageLog = typeof apiUsageLogs.$inferInsert;
