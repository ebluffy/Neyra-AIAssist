export type Environment = Record<string, string | undefined>;
export function readDatabaseUrl(env: Environment = process.env): string {
  const value = env.DATABASE_URL;
  if (!value) throw new Error('Не задана DATABASE_URL для базы сайта.');
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch { throw new Error('DATABASE_URL должна быть корректным PostgreSQL URL.'); }
  return value;
}
export function readAuthEnv(env: Environment = process.env) {
  const databaseUrl = readDatabaseUrl(env);
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('Задайте BETTER_AUTH_SECRET длиной не менее 32 символов.');
  const baseURL = env.BETTER_AUTH_URL;
  try {
    if (!baseURL) throw new Error();
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new Error('Задайте BETTER_AUTH_URL — HTTP(S) origin сайта.'); }
  return { databaseUrl, secret, baseURL: baseURL! };
}
