'use client';

import { useState } from 'react';
import type { Snippet } from '@/lib/snippets';
import { CodeBlock, cn } from './ui';

export function CodeTabs({ snippets }: { snippets: Snippet[] }) {
  const [active, setActive] = useState(snippets[0]?.id ?? '');
  const current = snippets.find((s) => s.id === active) ?? snippets[0];
  if (!current) return null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1">
        {snippets.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActive(s.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition',
              s.id === current.id ? 'bg-slate-800 text-cyan-200 shadow-inner' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <CodeBlock code={current.code} />
    </div>
  );
}
