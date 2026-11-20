import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AegisGate Console · API Gateway, Rate-Limiter & Usage-Based Billing',
  description:
    'Control plane for AegisGate: multi-tenant API key onboarding, rate-limit chaos lab, double-entry ledger inspector and FinOps pricing simulator.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-ink-950 font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
