'use client';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Hash, LockKeyhole, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { resetChatId, resolveTabKey } from '../../../lib/chat-id';
import { Avatar, Button, IconButton, NeyraLogo } from '../ui';
import { api, type Catalog, type Guild, type GuildDetail, type Member } from './data';
import { useCatalog } from './use-catalog';
import { Empty, Failure, Loading, Unavailable } from './shared';
import { History } from './history';
import { PersonDrawer } from './person-drawer';
import s from './channels.module.css';
function GuildIcon({guild}:{guild:Guild}) {
  const [failed,setFailed]=useState(false);
  return guild.icon_url&&!failed ? <img src={guild.icon_url} alt="" referrerPolicy="no-referrer" className={s.guildIcon} onError={()=>setFailed(true)}/> : <div className={s.guildIcon} aria-hidden="true">{(guild.name || '?').charAt(0).toUpperCase()}</div>;
}
export function MemberCard({member,onClick}:{member:Member;onClick:()=>void}) {
  return <button type="button" className={`${s.card} ${s.member}`} onClick={onClick}>
    <Avatar name={member.display_name || member.username} size={36}/><span className={s.memberText}>
      <span className={s.memberName}>{member.display_name || member.username || 'Без имени'}{Boolean(member.is_bot)&&<span className={s.bot}>bot</span>}</span>
      <span className={`${s.username} block`}>{member.username?.replace(/^@/,'') || 'Имя пользователя неизвестно'}</span>
      <span className={`${s.id} block`}>{member.discord_id}</span>
    </span>
  </button>;
}
export function ChannelsView({userId}:{userId?:string} = {}) {
  const router=useRouter();
  const [guild,setGuild]=useState<Guild|null>(null);
  const [offset,setOffset]=useState(0);
  const [guilds,setGuilds]=useState<Guild[]>([]);
  const list=useCatalog<Catalog<Guild>>(`${api}/guilds?limit=200&offset=${offset}`);
  useEffect(()=>{if(list.data?.items)setGuilds(previous=>offset===0?list.data!.items:Array.from(new Map([...previous,...list.data!.items].map(item=>[item.id,item])).values()));},[list.data,offset]);
  function refresh(){setOffset(0);setGuilds([]);list.retry();}
  return <div className={s.shell}>
    <nav className={s.rail} aria-label="Разделы">
      <IconButton aria-label="На главную" icon={<NeyraLogo size={22}/>} onClick={()=>router.push('/')}/>
      <IconButton aria-label="Новый чат" icon={<Plus size={18}/>} onClick={()=>{if(userId)resetChatId(window.sessionStorage,resolveTabKey(window),userId);router.push('/chat');}}/>
      <IconButton aria-label="Каналы" variant="secondary" aria-current="page" icon={<Hash size={18}/>} onClick={()=>setGuild(null)}/>
    </nav>
    <main className={s.main}>
      <header className={s.heading}>
        {guild&&<IconButton aria-label="Все серверы" icon={<ArrowLeft size={20}/>} onClick={()=>setGuild(null)}/>}
        <div className={s.headingText}><p className={s.eyebrow}>Discord · {guild?'Сервер':'Обзор'}</p><h1 className={s.title}>{guild?.name || (guild ? guild.id : 'Каналы')}</h1>
          {!guild&&<p className={s.subtitle}>Серверы, участники и история общения с Нейрой.<br/>Всё, что происходит за пределами личного чата.</p>}
        </div>
        <span className={s.meta}><LockKeyhole size={12}/>Только для администратора</span>
        {!guild&&<IconButton aria-label="Обновить серверы" icon={<RefreshCw size={16}/>} onClick={refresh}/>}
      </header>
      {guild ? <GuildScreen key={guild.id} guild={guild}/> : list.loading ? <Loading/> : list.error ? <Failure message={list.error} retry={list.retry}/> : list.data?.available===false ? <Unavailable/> : !guilds.length ? <Empty title="Серверов пока нет" text="Здесь появятся Discord-серверы, подключённые к Нейре."/> : <div className={s.grid}>
        {guilds.map(item=><button type="button" className={s.card} key={item.id} onClick={()=>setGuild(item)}>
          <div className={s.cardTop}><GuildIcon guild={item}/><h2>{item.name || item.id}</h2><ArrowUpRight size={16} className="ml-auto shrink-0 text-[var(--text-subtle)]"/></div>
          {item.description&&<p className={`${s.muted} mb-5`}>{item.description}</p>}
          <div className={s.counts}><div><strong>{item.counts?.channels ?? item.channel_count ?? '—'}</strong><span>каналов</span></div><div><strong>{item.counts?.members ?? item.member_count ?? '—'}</strong><span>известных участников</span></div></div>
        </button>)}
      </div>}
      {!guild && list.data?.available!==false && list.data?.items.length===200 && (list.data.total==null || guilds.length<list.data.total) && <div className={s.pager}><Button variant="secondary" disabled={list.loading} onClick={()=>setOffset(value=>value+200)}>Загрузить серверы</Button></div>}
    </main>
  </div>;
}
function GuildScreen({guild}:{guild:Guild}) {
  const detail=useCatalog<GuildDetail>(`${api}/guilds/${encodeURIComponent(guild.id)}`);
  return detail.loading ? <Loading/> : detail.error ? <Failure message={detail.error} retry={detail.retry}/> : detail.data ? <GuildContent guild={guild} detail={detail.data}/> : null;
}
function GuildContent({guild,detail}:{guild:Guild;detail:GuildDetail}) {
  const [tab,setTab]=useState('members');
  const [channel,setChannel]=useState('');
  const [person,setPerson]=useState('');
  const [selected,setSelected]=useState<Member|null>(null);
  const [offset,setOffset]=useState(0);
  const [members,setMembers]=useState<Member[]>([]);
  const catalog=useCatalog<Catalog<Member>>(`${api}/members?guild_id=${encodeURIComponent(guild.id)}&limit=200&offset=${offset}`);
  useEffect(()=>{
    if(catalog.data?.items)setMembers(previous=>offset===0?catalog.data!.items:Array.from(new Map([...previous,...catalog.data!.items].map(member=>[member.discord_id,member])).values()));
  },[catalog.data,offset]);
  const knownMembers=members.length?members:detail.members;
  return <div className={s.split}>
    <aside className={s.channelList} aria-label="Каналы сервера"><h2>КАНАЛЫ · {detail.counts.channels}</h2>
      <button type="button" className={s.channel} data-active={tab==='history'&&!channel} onClick={()=>{setChannel('');setTab('history');}}><MessageSquare size={15}/><span>Вся история<small>Все серверы и веб</small></span></button>
      {detail.channels.map(item=><button type="button" key={item.id} className={s.channel} data-active={channel===item.id} onClick={()=>{setChannel(item.id);setTab('history');}}><Hash size={15} className="shrink-0"/><span>{item.name || item.id}<small>{item.type || 'Тип неизвестен'}{item.parent_id?` · ${detail.channels.find(parent=>parent.id===item.parent_id)?.name || item.parent_id}`:''}</small></span></button>)}
    </aside>
    <section className="min-w-0">
      <div role="tablist" aria-label="Данные сервера" className={s.tabs}><button role="tab" id="members-tab" aria-controls="members-panel" className={s.tab} aria-selected={tab==='members'} onClick={()=>setTab('members')}>Участники · {detail.counts.members}</button><button role="tab" id="history-tab" aria-controls="history-panel" className={s.tab} aria-selected={tab==='history'} onClick={()=>setTab('history')}>История</button></div>
      {tab==='members' ? <div role="tabpanel" id="members-panel" aria-labelledby="members-tab">
        {catalog.error ? <Failure message={catalog.error} retry={catalog.retry}/> : catalog.data?.available===false ? <Unavailable/> : catalog.loading&&offset===0 ? <Loading/> : !knownMembers.length ? <Empty title="Участников пока нет" text="Каталог заполнится, когда Нейра увидит участников сервера."/> : <div className={s.memberGrid}>{knownMembers.map(member=><MemberCard key={member.discord_id} member={member} onClick={()=>setSelected(member)}/>)}</div>}
        {catalog.data && catalog.data.available!==false && catalog.data.items.length===200 && (catalog.data.total==null || members.length<catalog.data.total)&&<div className={s.pager}><Button variant="secondary" disabled={catalog.loading} onClick={()=>setOffset(value=>value+200)}>Загрузить участников</Button></div>}
        {catalog.loading&&offset>0&&<p role="status" className={s.muted}>Загрузка участников…</p>}
      </div> : <div role="tabpanel" id="history-panel" aria-labelledby="history-tab"><History guild={guild} channels={detail.channels} members={knownMembers} channel={channel} person={person} setChannel={setChannel} setPerson={setPerson}/></div>}
    </section>
    {selected&&<PersonDrawer key={selected.discord_id} member={selected} onClose={()=>setSelected(null)} onHistory={()=>{setPerson(selected.person_id || '');setChannel('');setTab('history');setSelected(null);}}/>}
  </div>;
}
