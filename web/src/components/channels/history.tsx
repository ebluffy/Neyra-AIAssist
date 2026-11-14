'use client';

import React, { useEffect, useId, useState } from 'react';
import { Bot, Hash, MessageSquare, Search } from 'lucide-react';
import { Avatar, Button, NeyraLogo } from '../ui';
import {
  api,
  channelLabel,
  cleanMessageText,
  groupMessagesByTurn,
  moscowDate,
  periodStart,
  read,
  type Catalog,
  type Channel,
  type Guild,
  type Member,
  type Message,
  type TurnBlock,
} from './data';
import { useCatalog } from './use-catalog';
import { Empty, Failure, Loading, Unavailable } from './shared';
import s from './channels.module.css';

interface Filters {
  guild: string;
  channel: string;
  person: string;
  q: string;
  period: string;
}

export type HistoryViewMode = 'turns' | 'chronological';

export function History({
  guild,
  channels,
  members,
  channel,
  person,
  setChannel,
  setPerson,
  mode,
  setMode,
}: {
  guild: Guild;
  channels: Channel[];
  members: Member[];
  channel: string;
  person: string;
  setChannel: (id: string) => void;
  setPerson: (id: string) => void;
  mode: HistoryViewMode;
  setMode: (mode: HistoryViewMode) => void;
}) {
  const [guildFilter, setGuildFilter] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('all');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const filters: Filters = { guild: guildFilter, channel, person, q: search, period };
  const key = JSON.stringify(filters);

  // Helper to resolve friendly channel name
  function getChannelTitle(id: string | null): string {
    if (!id) return 'Канал неизвестен';
    const found = channels.find((c) => c.id === id);
    if (found?.name) return `#${found.name}`;
    return channelLabel(id);
  }

  return (
    <>
      {/* Top Filter Bar */}
      <div className={s.filterBar}>
        <label className={s.filterField}>
          <span>Сервер:</span>
          <select
            className={s.filterSelect}
            aria-label="Сервер"
            value={guildFilter}
            onChange={(e) => {
              setGuildFilter(e.target.value);
              setChannel('');
            }}
          >
            <option value="">Все серверы и веб</option>
            <option value={guild.id}>{guild.name || guild.id}</option>
          </select>
        </label>

        <label className={s.filterField}>
          <span>Канал:</span>
          <select
            className={s.filterSelect}
            aria-label="Канал"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="">Все каналы</option>
            {channels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name ? `#${item.name}` : channelLabel(item.id)}
              </option>
            ))}
          </select>
        </label>

        <label className={s.filterField}>
          <span>Человек:</span>
          <select
            className={s.filterSelect}
            aria-label="Человек"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          >
            <option value="">Все участники</option>
            {members
              .filter(
                (item, index, list) =>
                  item.person_id && list.findIndex((other) => other.person_id === item.person_id) === index
              )
              .map((item) => (
                <option key={item.discord_id} value={item.person_id!}>
                  {item.display_name || item.username || item.discord_id}
                </option>
              ))}
          </select>
        </label>

        <label className={s.filterField}>
          <span>Период:</span>
          <select
            className={s.filterSelect}
            aria-label="Период"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="all">Всё время</option>
            <option value="today">Сегодня</option>
            <option value="7">7 дней</option>
            <option value="30">30 дней</option>
          </select>
        </label>

        <label className={s.filterField} style={{ flex: 1, minWidth: '160px' }}>
          <Search size={13} className="text-[var(--text-subtle)] shrink-0" />
          <input
            className={s.filterInput}
            style={{ width: '100%' }}
            type="search"
            value={query}
            aria-label="Поиск по тексту"
            placeholder="Поиск по тексту сообщений…"
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {/* Messages Timeline */}
      <Timeline key={key} filters={filters} mode={mode} getChannelTitle={getChannelTitle} />
    </>
  );
}

function Timeline({
  filters,
  mode,
  getChannelTitle,
}: {
  filters: Filters;
  mode: HistoryViewMode;
  getChannelTitle: (id: string | null) => string;
}) {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.guild) query.set('guild_id', filters.guild);
  if (filters.channel) query.set('channel_id', filters.channel);
  if (filters.person) query.set('person_id', filters.person);
  if (filters.q) query.set('q', filters.q);
  const [from] = useState(() => periodStart(filters.period));
  if (from) query.set('from', from);

  const url = `${api}/messages?${query}`;
  const result = useCatalog<Catalog<Message>>(url);
  const [extra, setExtra] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    return () => {
      controller.current?.abort();
    };
  }, []);

  const controller = React.useRef<AbortController | null>(null);

  if (result.loading) return <Loading />;
  if (result.error) return <Failure message={result.error} retry={result.retry} />;
  if (result.data?.available === false || unavailable) return <Unavailable />;

  // Filter out model_trace and sort chronologically
  const items = Array.from(
    new Map(
      [...(result.data?.items ?? []), ...extra]
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .map((item) => [item.id, item])
    ).values()
  ).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime() || a.id - b.id);

  const next = cursor === undefined ? result.data?.next_cursor : cursor;

  async function more() {
    setLoadingMore(true);
    setError(undefined);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await read<Catalog<Message>>(`${url}&cursor=${next}`, abort.signal);
      if (abort.signal.aborted) return;
      if (data.available === false) {
        setUnavailable(true);
        return;
      }
      setExtra((previous) => [...previous, ...data.items]);
      setCursor(data.next_cursor === next ? null : data.next_cursor ?? null);
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить историю.');
      }
    } finally {
      if (!abort.signal.aborted) setLoadingMore(false);
    }
  }

  if (!items.length) {
    return (
      <div className={s.messagesScroll}>
        <Empty title="Сообщений пока нет" text="Попробуйте другой канал, участника или период." />
      </div>
    );
  }

  if (mode === 'turns') {
    const turns = groupMessagesByTurn(items);
    return (
      <div className={s.messagesScroll} aria-label="Хронология сообщений по диалогам">
        {turns.map((turn) => (
          <TurnCard key={turn.turn_id} turn={turn} getChannelTitle={getChannelTitle} />
        ))}
        {error && <Failure message={error} retry={more} />}
        {next != null && (
          <div className={s.pager}>
            <Button variant="secondary" disabled={loadingMore} onClick={more}>
              {loadingMore ? 'Загрузка…' : 'Загрузить ещё'}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Chronological Mode
  return (
    <div className={s.messagesScroll} aria-label="Хронология сообщений">
      {items.map((item) => (
        <MessageCard key={item.id} message={item} getChannelTitle={getChannelTitle} />
      ))}
      {error && <Failure message={error} retry={more} />}
      {next != null && (
        <div className={s.pager}>
          <Button variant="secondary" disabled={loadingMore} onClick={more}>
            {loadingMore ? 'Загрузка…' : 'Загрузить ещё'}
          </Button>
        </div>
      )}
    </div>
  );
}

function TurnCard({
  turn,
  getChannelTitle,
}: {
  turn: TurnBlock;
  getChannelTitle: (id: string | null) => string;
}) {
  return (
    <div className={s.turnBlock}>
      {/* User message(s) */}
      {turn.userMessages.map((msg) => (
        <MessageCard key={msg.id} message={msg} getChannelTitle={getChannelTitle} />
      ))}

      {/* Assistant responses */}
      {turn.assistantMessages.length > 0 ? (
        turn.assistantMessages.map((msg) => (
          <MessageCard key={msg.id} message={msg} getChannelTitle={getChannelTitle} />
        ))
      ) : (
        <div className={s.noAnswerBadge}>Ответа нет</div>
      )}
    </div>
  );
}

function MessageCard({
  message,
  getChannelTitle,
}: {
  message: Message;
  getChannelTitle: (id: string | null) => string;
}) {
  const isAssistant = message.role === 'assistant';
  const cleanUsername = message.discord_username ? message.discord_username.replace(/^@/, '') : null;
  const channelTag = getChannelTitle(message.channel_id);

  return (
    <article className={s.msgRow}>
      {isAssistant ? (
        <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center shrink-0">
          <NeyraLogo size={18} />
        </div>
      ) : (
        <Avatar name={message.display_name || message.discord_username} size={32} />
      )}

      <div className={s.msgContent}>
        <div className={s.msgAuthorRow}>
          <span className={s.authorName}>
            {isAssistant ? 'Нейра' : message.display_name || cleanUsername || 'Пользователь'}
          </span>

          {isAssistant ? (
            <span className={s.botBadge}>bot</span>
          ) : (
            <>
              {cleanUsername && <span className={s.usernameHandle}>@{cleanUsername}</span>}
              {message.discord_id && <span className={s.digitalId}>{message.discord_id}</span>}
            </>
          )}

          <span className={s.channelTag}>{channelTag}</span>

          <time className={s.msgTime} dateTime={message.ts}>
            {moscowDate(message.ts)}
          </time>
        </div>

        <div className={s.msgText}>
          {isAssistant ? message.text : cleanMessageText(message.text)}
        </div>
      </div>
    </article>
  );
}
