// Zero-dependency ANSI rendering helpers.

const forceColor = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
export const colorEnabled = forceColor || (!process.env.NO_COLOR && Boolean(process.stdout.isTTY));

const wrap = (open: number, close: number) => (s: string | number): string =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const term = {
  altOn: '\x1b[?1049h',
  altOff: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  home: '\x1b[H',
  clearDown: '\x1b[J',
  clearLine: '\x1b[2K\r',
};

const ANSI_SEQ = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_AT_START = /^\x1b\[[0-9;?]*[A-Za-z]/;

export const visibleLength = (s: string): number => s.replace(ANSI_SEQ, '').length;

/** Pads or truncates (ANSI-aware) to exactly `width` visible columns. */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  const len = visibleLength(s);
  if (len <= width) return s + ' '.repeat(width - len);

  let out = '';
  let count = 0;
  let i = 0;
  while (i < s.length && count < width - 1) {
    if (s[i] === '\x1b') {
      const m = ANSI_AT_START.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    count++;
    i++;
  }
  return `${out}…${colorEnabled ? '\x1b[0m' : ''}`;
}

export const padLeft = (s: string | number, width: number): string => {
  const str = String(s);
  return ' '.repeat(Math.max(0, width - visibleLength(str))) + str;
};

export function bar(value: number, max: number, width: number, paint: (s: string) => string = c.green): string {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return paint('█'.repeat(filled)) + c.gray('░'.repeat(width - filled));
}

const SPARK = '▁▂▃▄▅▆▇█';
export function sparkline(values: number[], max = Math.max(1, ...values)): string {
  return values.map((v) => (v <= 0 ? ' ' : SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))])).join('');
}

/** Renders a titled box `┌─ title ─┐ │ … │ └──┘` of total `width` columns. */
export function box(title: string, lines: string[], width: number): string[] {
  const inner = width - 2;
  const label = title ? ` ${title} ` : '';
  const top = c.gray('┌─') + c.bold(c.cyan(label)) + c.gray(`${'─'.repeat(Math.max(0, inner - 1 - visibleLength(label)))}┐`);
  const body = lines.map((line) => `${c.gray('│')} ${fit(line, inner - 2)} ${c.gray('│')}`);
  return [top, ...body, c.gray(`└${'─'.repeat(inner)}┘`)];
}

/** Places two boxes side by side, padding the shorter one. */
export function sideBySide(left: string[], right: string[], leftWidth: number, gap = 1): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) out.push(fit(left[i] ?? '', leftWidth) + ' '.repeat(gap) + (right[i] ?? ''));
  return out;
}

export const fmt = {
  int: (n: number): string => Math.round(n).toLocaleString('en-US'),
  ms: (n: number): string => `${n.toFixed(2)}ms`,
  usd: (n: number): string => `$${n.toFixed(4)}`,
  pct: (n: number): string => `${n.toFixed(1)}%`,
  time: (ts: number | string): string => new Date(ts).toISOString().slice(11, 23),
};

export const termWidth = (): number => Math.max(80, Math.min(160, process.stdout.columns ?? 100));
export const termHeight = (): number => Math.max(24, process.stdout.rows ?? 40);
