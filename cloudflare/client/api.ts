export class RequestError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
  get uncertain() { return this.status === 0 || this.status === 408 || this.status >= 500; }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(path, { ...options, credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const body: unknown = await response.json().catch(() => null);
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const failure = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
    if (!response.ok) throw new RequestError(typeof failure.message === 'string' ? failure.message : typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : `The request could not be completed (${response.status}).`, response.status, typeof failure.code === 'string' ? failure.code : typeof payload.code === 'string' ? payload.code : undefined);
    if (body === null) throw new RequestError('The response could not be verified.');
    return body as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('The connection was interrupted.');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

export const send = <T>(path: string, body: unknown, method = 'POST') => request<T>(path, { method, body: JSON.stringify(body) });
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
