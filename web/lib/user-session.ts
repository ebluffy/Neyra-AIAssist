import { getAuth } from './auth';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    const user = session?.user;
    if (!user || typeof user.id !== 'string') return null;
    return {
      id: user.id,
      email: String(user.email || ''),
      name: String(user.name || ''),
      role: String(user.role || 'user'),
    };
  } catch {
    return null;
  }
}
