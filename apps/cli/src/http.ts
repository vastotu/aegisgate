export interface JsonResponse<T> {
  status: number;
  body: T;
}

/** Minimal fetch wrapper with timeout. Throws on network error or non-JSON body. */
export async function requestJson<T>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 3_000),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export const errorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
};
