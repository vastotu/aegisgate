import { SHOWCASE_TENANTS } from '@aegisgate/shared';

/** Raw demo API keys for the seeded showcase tenants, by slug. Public by design. */
export const SHOWCASE_DEMO_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  SHOWCASE_TENANTS.map((t) => [t.slug, t.demoApiKey]),
);
