import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GUILD_LIST_SPEC,
  MEMBER_SPEC,
  MESSAGE_SPEC,
  buildCoreQuery,
  discordCoreStatus,
  discordFailure,
  discordPersonMap,
  fillDiscordPersonIds,
  readDiscordGuild,
  readDiscordMessages,
} from './admin-discord';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('buildCoreQuery', () => {
  it('passes only known keys and normalizes dates', () => {
    const parsed = buildCoreQuery(
      new URLSearchParams('guild_id=g1&from=2026-11-10T10:00:00%2B03:00&unknown=drop&limit=2'),
      MESSAGE_SPEC,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const query = new URLSearchParams(parsed.query.slice(1));
    expect(query.get('guild_id')).toBe('g1');
    expect(query.get('limit')).toBe('2');
    expect(query.get('unknown')).toBeNull();
    expect(query.get('from')).toBe('2026-11-10T07:00:00.000Z');
  });

  it('clamps integers instead of trusting the client', () => {
    const high = buildCoreQuery(new URLSearchParams('limit=9999&offset=-5'), GUILD_LIST_SPEC);
    expect(high.ok && new URLSearchParams(high.query.slice(1)).get('limit')).toBe('200');
    expect(high.ok && new URLSearchParams(high.query.slice(1)).get('offset')).toBe('0');

    const low = buildCoreQuery(new URLSearchParams('limit=0'), GUILD_LIST_SPEC);
    expect(low.ok && new URLSearchParams(low.query.slice(1)).get('limit')).toBe('1');
  });

  it('rejects broken numbers and dates', () => {
    expect(buildCoreQuery(new URLSearchParams('limit=abc'), GUILD_LIST_SPEC)).toMatchObject({ ok: false });
    expect(buildCoreQuery(new URLSearchParams('from=вчера'), MESSAGE_SPEC)).toMatchObject({ ok: false });
  });

  it('trims text and caps its length', () => {
    const parsed = buildCoreQuery(new URLSearchParams(`q=${'x'.repeat(300)}`), MEMBER_SPEC);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(new URLSearchParams(parsed.query.slice(1)).get('q')?.length).toBe(120);
  });

  it('returns an empty query when nothing is set', () => {
    expect(buildCoreQuery(new URLSearchParams(''), MEMBER_SPEC)).toEqual({ ok: true, query: '' });
  });
});

describe('core calls', () => {
  it('builds the guild path with encoded id and query', async () => {
    vi.stubEnv('NEYRA_API_URL', 'http://core.test');
    vi.stubEnv('NEYRA_SERVICE_KEY', 'test-key');
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (target: string | URL | Request) => {
      url = String(target);
      return new Response(JSON.stringify({ ok: true, data: { guild: {}, channels: [], members: [], counts: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const result = await readDiscordGuild('g/1', '?member_limit=10');
    expect(url).toBe('http://core.test/v1/admin/discord/guilds/g%2F1?member_limit=10');
    expect(result.state).toBe('ok');
  });

  it('forwards the messages cursor and limit', async () => {
    vi.stubEnv('NEYRA_API_URL', 'http://core.test');
    vi.stubEnv('NEYRA_SERVICE_KEY', 'test-key');
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (target: string | URL | Request) => {
      url = String(target);
      return new Response(JSON.stringify({ ok: true, data: { items: [], total: 0, next_cursor: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await readDiscordMessages('?guild_id=g1&cursor=42&limit=10');
    expect(url).toBe('http://core.test/v1/admin/discord/messages?guild_id=g1&cursor=42&limit=10');
  });
});

describe('discord person links', () => {
  it('maps discord ids from person accounts and keeps a member id when it is already set', async () => {
    vi.stubEnv('NEYRA_API_URL', 'http://core.test');
    vi.stubEnv('NEYRA_SERVICE_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: {
        people: [
          { id: 'p1', discord_ids: ['d1'], accounts: [{ platform: 'discord', platform_user_id: 'd2', person_id: 'p1' }] },
          { id: 'p2', discord_ids: [], accounts: [{ platform: 'web', platform_user_id: 'd1', person_id: 'p2' }] },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const map = await discordPersonMap();
    expect(map.get('d1')).toBe('p1');
    expect(map.get('d2')).toBe('p1');

    const filled = fillDiscordPersonIds([
      { guild_id: 'g', discord_id: 'd1', person_id: null, username: 'a', display_name: 'A', is_bot: 0, first_seen: '', last_seen: '' },
      { guild_id: 'g', discord_id: 'd2', person_id: 'explicit', username: 'b', display_name: 'B', is_bot: 0, first_seen: '', last_seen: '' },
      { guild_id: 'g', discord_id: 'd3', person_id: null, username: 'c', display_name: 'C', is_bot: 0, first_seen: '', last_seen: '' },
    ], map);
    expect(filled.map((member) => member.person_id)).toEqual(['p1', 'explicit', null]);
  });

  it('returns an empty map when the core is unavailable', async () => {
    vi.stubEnv('NEYRA_API_URL', '');
    vi.stubEnv('NEYRA_SERVICE_KEY', '');
    const map = await discordPersonMap();
    expect(map.size).toBe(0);
  });
});

describe('error mapping', () => {
  it('keeps 400/404 and turns outages into 502/503', () => {
    expect(discordCoreStatus({ state: 'error', data: null, status: 400 })).toBe(400);
    expect(discordCoreStatus({ state: 'error', data: null, status: 404 })).toBe(404);
    expect(discordCoreStatus({ state: 'unavailable', data: null })).toBe(502);
    expect(discordCoreStatus({ state: 'unconfigured', data: null })).toBe(503);
  });

  it('returns a JSON error body the admin UI can show', async () => {
    const response = discordFailure({ state: 'error', data: null, status: 404, message: 'Сервер не найден' }, 'fallback');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found', message: 'Сервер не найден' });
  });
});
