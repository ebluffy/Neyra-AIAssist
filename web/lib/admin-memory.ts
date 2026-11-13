// Нормализация людей из ядра для админки: ядро отдаёт аккаунты объектами,
// а display_name может совпадать с UUID — в таблице это выглядело как
// «[object Object]» и дважды напечатанный идентификатор.

export interface MemoryAccountLike {
  platform?: unknown;
  handle?: unknown;
  platform_user_id?: unknown;
  [key: string]: unknown;
}

export interface MemoryPersonLike {
  id?: string;
  display_name?: string;
  names?: unknown[];
  accounts?: unknown[];
  discord_ids?: unknown[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRawId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

// Имя для первой колонки: никогда не UUID и не пустая строка.
export function personTitle(person: MemoryPersonLike): string {
  const id = text(person.id);
  const display = text(person.display_name);
  if (display && !isRawId(display) && display !== id) return display;
  const alias = (person.names ?? [])
    .map(text)
    .find(name => name && !isRawId(name) && name !== id && name !== display);
  if (alias) return alias;
  if (display && !isRawId(display)) return display;
  return 'Без имени';
}

// UUID показываем один раз и только если он не стал заголовком строки.
export function personIdLabel(person: MemoryPersonLike): string | null {
  const id = text(person.id);
  if (!id) return null;
  return id === personTitle(person) ? null : id;
}

// Псевдонимы без повторов, без UUID и без уже показанного заголовка.
export function personAliases(person: MemoryPersonLike): string[] {
  const title = personTitle(person);
  const id = text(person.id);
  const seen = new Set<string>([title, id].filter(Boolean));
  const out: string[] = [];
  for (const raw of person.names ?? []) {
    const name = text(raw);
    if (!name || isRawId(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// accounts: [{platform, handle|platform_user_id}] → "discord: user#1234".
export function accountLabels(accounts: unknown[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of accounts ?? []) {
    let label = '';
    if (typeof item === 'string') {
      label = item.trim();
    } else if (item && typeof item === 'object') {
      const account = item as MemoryAccountLike;
      const platform = text(account.platform) || 'аккаунт';
      const handle = text(account.handle) || text(account.platform_user_id);
      label = handle ? `${platform}: ${handle}` : platform;
    }
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export function discordLabels(person: MemoryPersonLike): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of person.discord_ids ?? []) {
    const value = text(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
