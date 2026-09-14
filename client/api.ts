export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => ({ error: 'The server did not return a valid response.' }));
  if (!response.ok) throw new ApiError(body.error || 'The request could not be completed.', response.status);
  return body as T;
}
export const mutate = <T = unknown>(path: string, body: unknown, method = 'POST') => api<T>(path, { method, body: JSON.stringify(body) });
