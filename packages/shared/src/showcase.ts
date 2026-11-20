import type { RateLimitAlgo } from './contracts';

// The 3 preset showcase tenants. Shared by the gateway's offline store and the console's
// in-browser sandbox (the DB seed in packages/db/src/seed.ts mirrors the same values).

export interface ShowcaseRuleSpec {
  routePattern: string;
  algorithm: RateLimitAlgo;
  limitCount: number;
  windowSec: number;
  burstCapacity: number;
  costWeightCredits: number;
  priority: number;
}

export interface ShowcaseTenantSpec {
  name: string;
  slug: string;
  emoji: string;
  description: string;
  upstreamUrl: string;
  monthlyBudgetCredits: number;
  demoApiKey: string;
  rules: readonly ShowcaseRuleSpec[];
}

export const SHOWCASE_TENANTS: readonly ShowcaseTenantSpec[] = [
  {
    name: 'HappyShark.io Game Server',
    slug: 'happyshark',
    emoji: '🦈',
    description: 'Real-time multiplayer game server with room joins and WebSocket frame relays.',
    upstreamUrl: 'https://happyshark.io',
    monthlyBudgetCredits: 500_000,
    demoApiKey: 'ag_live_happyshark_demo_key_2026',
    rules: [
      { routePattern: '/api/room/join', algorithm: 'token_bucket', limitCount: 20, windowSec: 60, burstCapacity: 30, costWeightCredits: 5, priority: 10 },
      { routePattern: '/ws/frame', algorithm: 'sliding_window', limitCount: 60, windowSec: 1, burstCapacity: 60, costWeightCredits: 1, priority: 10 },
      { routePattern: '*', algorithm: 'token_bucket', limitCount: 120, windowSec: 60, burstCapacity: 150, costWeightCredits: 1, priority: 0 },
    ],
  },
  {
    name: 'Fintech Market Dashboard',
    slug: 'fintech-dash',
    emoji: '📊',
    description: 'Market quote streaming and Monte Carlo risk reporting dashboard.',
    upstreamUrl: 'https://fintech-dashboard.example.com',
    monthlyBudgetCredits: 250_000,
    demoApiKey: 'ag_live_fintech_demo_key_2026',
    rules: [
      { routePattern: '/api/market/quote', algorithm: 'sliding_window', limitCount: 30, windowSec: 60, burstCapacity: 30, costWeightCredits: 2, priority: 10 },
      { routePattern: '/api/report/monte-carlo', algorithm: 'token_bucket', limitCount: 5, windowSec: 60, burstCapacity: 5, costWeightCredits: 50, priority: 10 },
    ],
  },
  {
    name: 'AI Copilot & Sandbox API',
    slug: 'ai-sandbox',
    emoji: '🤖',
    description: 'LLM chat completions sandbox with high per-request credit weight.',
    upstreamUrl: 'https://api.example.com',
    monthlyBudgetCredits: 50_000,
    demoApiKey: 'ag_live_aisandbox_demo_key_2026',
    rules: [
      { routePattern: '/v1/chat/completions', algorithm: 'token_bucket', limitCount: 10, windowSec: 60, burstCapacity: 15, costWeightCredits: 100, priority: 10 },
    ],
  },
];
