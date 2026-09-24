export class RequestError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
  /** The server may or may not have applied the request (network loss, timeout, server error). */
  get uncertain() { return this.status === 0 || this.status === 408 || this.status >= 500; }
}

export type Channel = 'admin' | 'kiosk';
type Options = { method?: string; body?: unknown; location?: number | null; signal?: AbortSignal; timeoutMs?: number };

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.location) headers['X-Location-Id'] = String(options.location);
    const response = await fetch(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', signal: controller.signal, headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const failure = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
    if (!response.ok) {
      throw new RequestError(typeof failure.message === 'string' ? failure.message : `The request could not be completed (${response.status}).`,
        response.status, typeof failure.code === 'string' ? failure.code : undefined);
    }
    if (body === null) throw new RequestError('The response could not be verified.');
    return body as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('The connection was interrupted. Nothing has been confirmed as saved.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** API bound to a channel and, for the back office, to the selected location. */
export type Api = {
  channel: Channel;
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
};
export function createApi(channel: Channel, location: number | null): Api {
  const base = channel === 'kiosk' ? '/api/kiosk' : '/api/admin';
  return {
    channel,
    get: (path, signal) => request(`${base}${path}`, { location, signal }),
    post: (path, body = {}) => request(`${base}${path}`, { body, location }),
    patch: (path, body) => request(`${base}${path}`, { method: 'PATCH', body, location }),
  };
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.');
