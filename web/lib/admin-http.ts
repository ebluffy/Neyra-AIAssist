// Единый формат ответов админского API: {ok:true,data} | {ok:false,error,message}.
// Клиент не показывает сырые тексты БД — только эти сообщения.

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ ok: false, error, message }, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ActionErrorText {
  status: number;
  error: string;
  message: string;
}

export function describeActionError(error: string): ActionErrorText {
  if (error === 'self') {
    return { status: 409, error, message: 'Нельзя применить действие к своему аккаунту.' };
  }
  if (error === 'last-admin') {
    return { status: 409, error, message: 'Это последний администратор: сначала назначьте другого.' };
  }
  if (error === 'not-found') {
    return { status: 404, error, message: 'Запись не найдена.' };
  }
  return { status: 500, error: 'db', message: 'Не удалось сохранить изменение. Попробуйте ещё раз.' };
}
