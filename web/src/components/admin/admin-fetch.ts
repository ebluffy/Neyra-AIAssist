// Единый клиент админского API. mutationGate на сервере требует
// Content-Type: application/json для POST/PUT/PATCH/DELETE, поэтому кнопки
// без тела всё равно отправляют `{}` и явный заголовок.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return fetch(url, init);

  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const body = init.body ?? '{}';
  return fetch(url, { ...init, method, headers, body });
}
