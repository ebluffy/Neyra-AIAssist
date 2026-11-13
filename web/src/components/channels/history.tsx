'use client';
import React, { useEffect, useState } from 'react';
import { Avatar, Button } from '../ui';
import { api, channelLabel, moscowDate, periodStart, read, type Channel, type Guild, type Member, type Message, type Catalog } from './data';
import { useCatalog } from './use-catalog';
import { Empty, Failure, Loading, Unavailable } from './shared';
import s from './channels.module.css';
interface Filters {guild:string;channel:string;person:string;q:string;period:string}
export function History({guild,channels,members,channel,person,setChannel,setPerson}:{guild:Guild;channels:Channel[];members:Member[];channel:string;person:string;setChannel:(id:string)=>void;setPerson:(id:string)=>void}) {
  const [guildFilter,setGuildFilter]=useState('');
  const [query,setQuery]=useState('');
  const [search,setSearch]=useState('');
  const [period,setPeriod]=useState('all');
  useEffect(()=>{const timer=setTimeout(()=>setSearch(query.trim()),250);return()=>clearTimeout(timer);},[query]);
  const filters:Filters={guild:guildFilter,channel,person,q:search,period};
  const key=JSON.stringify(filters);
  return <>
    <div className={s.tools}>
      <label className={s.field}>Сервер<select className={s.input} value={guildFilter} onChange={event=>{setGuildFilter(event.target.value);setChannel('');}}><option value="">Все серверы и веб</option><option value={guild.id}>{guild.name || guild.id}</option></select></label>
      <label className={s.field}>Канал<select className={s.input} value={channel} onChange={event=>setChannel(event.target.value)}><option value="">Все каналы</option>{channels.map(item=><option key={item.id} value={item.id}>{item.name || channelLabel(item.id)}</option>)}</select></label>
      <label className={s.field}>Человек<select className={s.input} value={person} onChange={event=>setPerson(event.target.value)}><option value="">Все участники</option>{members.filter((item,index,list)=>item.person_id && list.findIndex(other=>other.person_id===item.person_id)===index).map(item=><option key={item.discord_id} value={item.person_id!}>{item.display_name || item.username || item.discord_id}</option>)}</select></label>
      <label className={s.field}>Период<select className={s.input} value={period} onChange={event=>setPeriod(event.target.value)}><option value="all">Всё время</option><option value="today">Сегодня</option><option value="7">7 дней</option><option value="30">30 дней</option></select></label>
      <label className={s.field}>Поиск по тексту<input className={s.input} type="search" value={query} placeholder="Найти сообщение…" maxLength={200} onChange={event=>setQuery(event.target.value)}/></label>
    </div>
    <p className={`${s.muted} mb-6`}>Время — МСК. По умолчанию история всех серверов, включая старые сообщения из веба.</p>
    <Timeline key={key} filters={filters}/>
  </>;
}
function Timeline({filters}:{filters:Filters}) {
  const query=new URLSearchParams({limit:'100'});
  if(filters.guild)query.set('guild_id',filters.guild);
  if(filters.channel)query.set('channel_id',filters.channel);
  if(filters.person)query.set('person_id',filters.person);
  if(filters.q)query.set('q',filters.q);
  const [from]=useState(()=>periodStart(filters.period));
  if(from)query.set('from',from);
  const url=`${api}/messages?${query}`;
  const result=useCatalog<Catalog<Message>>(url);
  const [extra,setExtra]=useState<Message[]>([]);
  const [cursor,setCursor]=useState<number|null|undefined>(undefined);
  const [loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState<string>();
  const [unavailable,setUnavailable]=useState(false);
  useEffect(()=>{return()=>{controller.current?.abort();};},[]);
  const controller=React.useRef<AbortController|null>(null);
  if(result.loading)return <Loading/>;
  if(result.error)return <Failure message={result.error} retry={result.retry}/>;
  if(result.data?.available===false || unavailable)return <Unavailable/>;
  const items=Array.from(new Map([...(result.data?.items ?? []),...extra].filter(item=>item.role==='user'||item.role==='assistant').map(item=>[item.id,item])).values()).sort((a,b)=>new Date(a.ts).getTime()-new Date(b.ts).getTime() || a.id-b.id);
  const next=cursor===undefined?result.data?.next_cursor:cursor;
  async function more() {
    setLoadingMore(true);setError(undefined);
    const abort=new AbortController();controller.current=abort;
    try {
      const data=await read<Catalog<Message>>(`${url}&cursor=${next}`,abort.signal);
      if(abort.signal.aborted)return;
      if(data.available===false){setUnavailable(true);return;}
      setExtra(previous=>[...previous,...data.items]);setCursor(data.next_cursor===next?null:data.next_cursor ?? null);
    } catch(error) {if(!abort.signal.aborted)setError(error instanceof Error?error.message:'Не удалось загрузить историю.');}
    finally {if(!abort.signal.aborted)setLoadingMore(false);}
  }
  return <>
    {!items.length ? <Empty title="Сообщений пока нет" text="Попробуйте другой канал, участника или период."/> : <div className={s.history} aria-label="Хронология сообщений">{items.map(item=><article key={item.id} className={s.message}>
      <div className={s.author}><Avatar name={item.role==='assistant'?'Нейра':item.display_name || item.discord_username} size={28}/><div className={s.authorText}><span className={s.memberName}>{item.role==='assistant'?'Нейра':item.display_name || item.discord_username || 'Без имени'}</span>{item.discord_username&&<div className={s.username}>{item.discord_username.replace(/^@/,'')}</div>}{item.discord_id&&<div className={s.id}>{item.discord_id}</div>}<div className={s.messageChannel}>{channelLabel(item.channel_id)}</div></div></div>
      <div><div className={`${s.body} ${item.role==='user'?s.userBody:''}`}>{item.text}</div><time className={s.time} dateTime={item.ts}>{moscowDate(item.ts)}</time></div>
    </article>)}</div>}
    {error&&<Failure message={error} retry={more}/>}
    {next!=null&&<div className={s.pager}><Button variant="secondary" disabled={loadingMore} onClick={more}>{loadingMore?'Загрузка…':'Загрузить ещё'}</Button></div>}
  </>;
}
