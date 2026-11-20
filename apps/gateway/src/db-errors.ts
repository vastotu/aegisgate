/** Network-level error codes (Node + postgres.js) meaning Postgres is unreachable. */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

/** SQLSTATEs meaning the database is not usable right now (missing DB, auth failure, schema not pushed). */
const UNAVAILABLE_SQLSTATES = new Set(['3D000', '28000', '28P01', '42P01']);
/** SQLSTATE classes: 08 connection exception, 53 insufficient resources, 57P operator intervention. */
const UNAVAILABLE_SQLSTATE_PREFIXES = ['08', '53', '57P'];

/** Returns the first string `code` found on an error or its `cause` chain. */
export function pgErrorCode(err: unknown): string | undefined {
  for (let cur: unknown = err; cur && typeof cur === 'object'; cur = (cur as { cause?: unknown }).cause) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function isDatabaseUnavailable(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (!code) return false;
  return (
    CONNECTION_CODES.has(code) ||
    UNAVAILABLE_SQLSTATES.has(code) ||
    UNAVAILABLE_SQLSTATE_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}
