'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Hash,
  LockKeyhole,
  Menu,
  MessageSquare,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { buildChatStorageKey, resolveTabKey } from '../../../lib/chat-id';
import { AppSidebar, type AppSidebarUser } from '../layout/app-sidebar';
import { Button, IconButton } from '../ui';
import {
  api,
  channelLabel,
  type ActivityData,
  type Catalog,
  type Channel,
  type Guild,
  type GuildDetail,
  type Member,
} from './data';
import { useCatalog } from './use-catalog';
import { Empty, Failure, Loading, Unavailable } from './shared';
import { History, type HistoryViewMode } from './history';
import { PersonDrawer } from './person-drawer';
import s from './channels.module.css';

function GuildIcon({ guild }: { guild: Guild }) {
  const [failed, setFailed] = useState(false);
  return guild.icon_url && !failed ? (
    <img
      src={guild.icon_url}
      alt=""
      referrerPolicy="no-referrer"
      className={s.guildIcon}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className={s.guildIcon} aria-hidden="true">
      {(guild.name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

export function MemberCard({ member, onClick }: { member: Member; onClick: () => void }) {
  const cleanUsername = member.username?.replace(/^@/, '');
  return (
    <button type="button" className={s.memberItem} onClick={onClick}>
      <div className="w-7 h-7 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center text-xs font-semibold shrink-0">
        {(member.display_name || member.username || '?').charAt(0).toUpperCase()}
      </div>
      <div className={s.memberInfo}>
        <div className={s.memberPrimary}>
          <span className={s.memberNameText}>{member.display_name || cleanUsername || 'Без имени'}</span>
          {Boolean(member.is_bot) && <span className={s.botBadge}>bot</span>}
        </div>
        <div className={s.memberSecondary}>
          {cleanUsername ? `@${cleanUsername}` : member.discord_id}
        </div>
      </div>
    </button>
  );
}

export function ChannelsView({
  userId,
  user,
}: {
  userId?: string;
  user?: AppSidebarUser | null;
} = {}) {
  const router = useRouter();
  const [guild, setGuild] = useState<Guild | null>(null);
  const [offset, setOffset] = useState(0);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const currentUser: AppSidebarUser = user || {
    id: userId || 'admin',
    name: 'Администратор',
    email: 'admin@neyra.ai',
    role: 'admin',
  };

  const list = useCatalog<Catalog<Guild>>(`${api}/guilds?limit=200&offset=${offset}`);

  useEffect(() => {
    if (list.data?.items) {
      setGuilds((previous) =>
        offset === 0
          ? list.data!.items
          : Array.from(new Map([...previous, ...list.data!.items].map((item) => [item.id, item])).values())
      );
    }
  }, [list.data, offset]);

  function refresh() {
    setOffset(0);
    setGuilds([]);
    list.retry();
  }

  return (
    <div className={s.shell}>
      {/* Unified Persistent App Sidebar */}
      <AppSidebar
        activeSection="channels"
        user={currentUser}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onSelectThread={(threadId) => {
          try {
            window.sessionStorage.setItem(buildChatStorageKey(currentUser.id, resolveTabKey(window)), threadId);
          } catch {}
          router.push('/chat');
        }}
      />

      <div className={s.mainLayout}>
        {/* Top Header Bar */}
        <header className={s.topBar}>
          <div className={s.topBarLeft}>
            <IconButton
              aria-label="Открыть меню"
              icon={<Menu size={18} />}
              className="lg:hidden"
              onClick={() => setMobileSidebarOpen(true)}
            />
            {guild && (
              <IconButton
                aria-label="Все серверы"
                tooltip="Все серверы"
                icon={<ArrowLeft size={18} />}
                onClick={() => setGuild(null)}
              />
            )}
            <div className={s.titleArea}>
              <p className={s.eyebrow}>Discord · {guild ? 'Сервер' : 'Каналы и серверы'}</p>
              <h1 className={s.guildTitle}>{guild?.name || (guild ? guild.id : 'Каналы')}</h1>
            </div>
          </div>

          <div className={s.topBarRight}>
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-[var(--text-subtle)] border border-[var(--border)] px-2 py-0.5 rounded-[var(--radius-sm)]">
              <LockKeyhole size={12} />
              Только для администратора
            </span>
            {!guild && (
              <IconButton aria-label="Обновить серверы" tooltip="Обновить список" icon={<RefreshCw size={15} />} onClick={refresh} />
            )}
          </div>
        </header>

        {guild ? (
          <GuildScreen key={guild.id} guild={guild} />
        ) : (
          <main className={s.overviewContent}>
            <div className={s.overviewHeader}>
              <h2 className={s.overviewTitle}>Подключённые серверы</h2>
              <p className={s.overviewSubtitle}>
                Каналы, участники и история общения с Нейрой за пределами личного чата.
              </p>
            </div>

            {list.loading ? (
              <Loading />
            ) : list.error ? (
              <Failure message={list.error} retry={list.retry} />
            ) : list.data?.available === false ? (
              <Unavailable />
            ) : !guilds.length ? (
              <Empty
                title="Серверов пока нет"
                text="Здесь появятся Discord-серверы, подключённые к Нейре."
              />
            ) : (
              <div className={s.grid}>
                {guilds.map((item) => (
                  <button
                    type="button"
                    className={s.card}
                    key={item.id}
                    onClick={() => setGuild(item)}
                  >
                    <div className={s.cardTop}>
                      <GuildIcon guild={item} />
                      <h2>{item.name || item.id}</h2>
                      <ArrowUpRight
                        size={16}
                        className="ml-auto shrink-0 text-[var(--text-subtle)]"
                      />
                    </div>
                    {item.description && (
                      <p className="text-xs text-[var(--text-muted)] line-clamp-2 mb-4">
                        {item.description}
                      </p>
                    )}
                    <div className={s.counts}>
                      <div>
                        <strong>{item.counts?.channels ?? item.channel_count ?? '—'}</strong>
                        <span>каналов</span>
                      </div>
                      <div>
                        <strong>{item.counts?.members ?? item.member_count ?? '—'}</strong>
                        <span>участников</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {!guild &&
              list.data?.available !== false &&
              list.data?.items.length === 200 &&
              (list.data.total == null || guilds.length < list.data.total) && (
                <div className={s.pager}>
                  <Button
                    variant="secondary"
                    disabled={list.loading}
                    onClick={() => setOffset((value) => value + 200)}
                  >
                    Загрузить серверы
                  </Button>
                </div>
              )}
          </main>
        )}
      </div>
    </div>
  );
}

function GuildScreen({ guild }: { guild: Guild }) {
  const detail = useCatalog<GuildDetail>(`${api}/guilds/${encodeURIComponent(guild.id)}`);
  return detail.loading ? (
    <Loading />
  ) : detail.error ? (
    <Failure message={detail.error} retry={detail.retry} />
  ) : detail.data ? (
    <GuildContent guild={guild} detail={detail.data} />
  ) : null;
}

function GuildContent({ guild, detail }: { guild: Guild; detail: GuildDetail }) {
  const [channel, setChannel] = useState('');
  const [person, setPerson] = useState('');
  const [selected, setSelected] = useState<Member | null>(null);
  const [offset, setOffset] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersPanelOpen, setMembersPanelOpen] = useState(true);
  const [mode, setMode] = useState<HistoryViewMode>('turns');

  // Load catalog members
  const catalog = useCatalog<Catalog<Member>>(
    `${api}/members?guild_id=${encodeURIComponent(guild.id)}&limit=200&offset=${offset}`
  );

  useEffect(() => {
    if (catalog.data?.items) {
      setMembers((previous) =>
        offset === 0
          ? catalog.data!.items
          : Array.from(
              new Map([...previous, ...catalog.data!.items].map((m) => [m.discord_id, m])).values()
            )
      );
    }
  }, [catalog.data, offset]);

  // Load activity summary (channels with dialogues, people who wrote to Neyra)
  const activity = useCatalog<ActivityData>(
    `${api}/activity?guild_id=${encodeURIComponent(guild.id)}`
  );

  const knownMembers = members.length ? members : detail.members;

  // Filter channels: ONLY show channels where activity.channels has messages > 0!
  const activeChannelMap = new Map<string, number>();
  if (activity.data?.channels) {
    for (const ac of activity.data.channels) {
      if (ac.messages > 0) {
        activeChannelMap.set(ac.channel_id, ac.messages);
      }
    }
  }

  // Filter detail.channels to only those with messages > 0
  const activeChannels: Array<Channel & { messages: number }> = [];
  for (const ch of detail.channels) {
    const count = activeChannelMap.get(ch.id);
    if (count != null && count > 0) {
      activeChannels.push({ ...ch, messages: count });
    }
  }

  // Also include any active channels from activity not in detail.channels
  if (activity.data?.channels) {
    for (const ac of activity.data.channels) {
      if (ac.messages > 0 && !activeChannels.some((c) => c.id === ac.channel_id)) {
        activeChannels.push({
          id: ac.channel_id,
          name: channelLabel(ac.channel_id),
          type: 'text',
          parent_id: null,
          messages: ac.messages,
        });
      }
    }
  }

  // People who actually wrote to Neyra
  const activePersonMap = new Map<string, number>();
  if (activity.data?.people) {
    for (const p of activity.data.people) {
      if (p.messages > 0) {
        activePersonMap.set(p.person_id, p.messages);
      }
    }
  }

  // Split members into: 1. Писали Нейре (in activity.people desc by messages), 2. Остальные участники
  const activeMembers: Array<Member & { messageCount: number }> = [];
  const otherMembers: Member[] = [];

  for (const m of knownMembers) {
    if (m.person_id && activePersonMap.has(m.person_id)) {
      activeMembers.push({
        ...m,
        messageCount: activePersonMap.get(m.person_id)!,
      });
    } else {
      otherMembers.push(m);
    }
  }
  // Sort active members descending by message count
  activeMembers.sort((a, b) => b.messageCount - a.messageCount);

  function handleSelectChannel(chId: string) {
    setChannel(chId);
    if (chId) {
      setMode('chronological');
    } else {
      setMode('turns');
    }
  }

  const selectedChannelName = channel
    ? detail.channels.find((c) => c.id === channel)?.name
      ? detail.channels.find((c) => c.id === channel)!.name
      : channelLabel(channel)
    : 'Вся история';

  return (
    <div className={s.guildWorkspace}>
      {/* 1. LEFT COLUMN: CHANNELS WITH DIALOGUES */}
      <aside className={s.channelColumn} aria-label="Каналы сервера с диалогами">
        <div className={s.channelColumnHeader}>
          <h2 className={s.columnHeading}>Каналы ({activeChannels.length})</h2>
        </div>

        <div className={s.channelList}>
          {/* All History item */}
          <button
            type="button"
            className={s.channelItem}
            data-active={!channel}
            onClick={() => handleSelectChannel('')}
          >
            <MessageSquare size={15} className="shrink-0 text-[var(--text-muted)]" />
            <div className={s.channelItemText}>
              <span className={s.channelName}>Вся история</span>
              <span className={s.channelBadge}>Диалоги серверов и веба</span>
            </div>
          </button>

          {/* Active channels only (messages > 0) */}
          {activity.loading ? (
            <div className="p-3 text-xs text-[var(--text-subtle)]">Загрузка каналов…</div>
          ) : activity.data?.available === false ? (
            <div className="p-3 text-xs text-[var(--text-subtle)]">Нет данных об активности</div>
          ) : activeChannels.length === 0 ? (
            <div className="p-3 text-xs text-[var(--text-subtle)]">Нет каналов с диалогами</div>
          ) : (
            activeChannels.map((item) => (
              <button
                type="button"
                key={item.id}
                className={s.channelItem}
                data-active={channel === item.id}
                onClick={() => handleSelectChannel(item.id)}
              >
                <Hash size={15} className="shrink-0 text-[var(--text-muted)]" />
                <div className={s.channelItemText}>
                  <span className={s.channelName}>{item.name || item.id}</span>
                  <span className={s.channelBadge}>{item.messages} сообщ.</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* 2. CENTER COLUMN: READ-ONLY CHAT HISTORY */}
      <main className={s.chatColumn} aria-label="История сообщений">
        <div className={s.chatHeader}>
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold truncate flex items-center gap-1.5">
              {channel ? <Hash size={16} /> : <MessageSquare size={16} />}
              <span>{selectedChannelName}</span>
            </h2>

            {/* Mode switch tablist */}
            <div role="tablist" aria-label="Режим отображения истории" className={s.modeTabs}>
              <button
                role="tab"
                id="turns-tab"
                aria-controls="turns-panel"
                aria-selected={mode === 'turns'}
                className={s.modeTab}
                onClick={() => setMode('turns')}
              >
                По диалогам
              </button>
              <button
                role="tab"
                id="chronological-tab"
                aria-controls="chronological-panel"
                aria-selected={mode === 'chronological'}
                className={s.modeTab}
                onClick={() => setMode('chronological')}
              >
                Хронологически
              </button>
            </div>
          </div>

          {/* Toggle button for right members panel */}
          <IconButton
            aria-label="Участники сервера"
            tooltip="Список участников"
            icon={<Users size={16} />}
            variant={membersPanelOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMembersPanelOpen((prev) => !prev)}
          />
        </div>

        {/* Chat History Component */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <History
            guild={guild}
            channels={detail.channels}
            members={knownMembers}
            channel={channel}
            person={person}
            setChannel={setChannel}
            setPerson={setPerson}
            mode={mode}
            setMode={setMode}
          />
        </div>
      </main>

      {/* 3. RIGHT COLUMN: MEMBERS SIDEBAR (DISCORD-STYLE) */}
      <aside
        className={s.membersColumn}
        data-open={membersPanelOpen}
        aria-label="Участники сервера"
      >
        <div className={s.channelColumnHeader}>
          <h2 className={s.columnHeading}>
            Участники · {knownMembers.length}
          </h2>
          <IconButton
            aria-label="Скрыть участников"
            icon={<X size={15} />}
            size="sm"
            className="lg:hidden"
            onClick={() => setMembersPanelOpen(false)}
          />
        </div>

        <div className={s.memberList}>
          {/* Section 1: Писали Нейре */}
          {activeMembers.length > 0 && (
            <div>
              <h3 className={s.memberSectionTitle}>
                Писали Нейре — {activeMembers.length}
              </h3>
              <div className="space-y-0.5">
                {activeMembers.map((member) => (
                  <button
                    type="button"
                    key={member.discord_id}
                    className={s.memberItem}
                    onClick={() => setSelected(member)}
                  >
                    <div className="w-7 h-7 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center text-xs font-semibold shrink-0">
                      {(member.display_name || member.username || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className={s.memberInfo}>
                      <div className={s.memberPrimary}>
                        <span className={s.memberNameText}>
                          {member.display_name || member.username?.replace(/^@/, '') || 'Без имени'}
                        </span>
                        {Boolean(member.is_bot) && <span className={s.botBadge}>bot</span>}
                      </div>
                      <div className={s.memberSecondary}>
                        {member.username?.replace(/^@/, '') || member.discord_id}
                      </div>
                    </div>
                    <span className={s.memberCountBadge}>
                      {member.messageCount} сообщ.
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Section 2: Остальные участники */}
          <div>
            <h3 className={s.memberSectionTitle}>
              Остальные участники — {otherMembers.length}
            </h3>
            <div className="space-y-0.5">
              {otherMembers.map((member) => (
                <MemberCard
                  key={member.discord_id}
                  member={member}
                  onClick={() => setSelected(member)}
                />
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Person Detail Drawer / Dialog */}
      {selected && (
        <PersonDrawer
          key={selected.discord_id}
          member={selected}
          onClose={() => setSelected(null)}
          onHistory={() => {
            setPerson(selected.person_id || '');
            setChannel('');
            setMode('turns');
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
