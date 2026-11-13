'use client';
import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Avatar, Button, IconButton } from '../ui';
import { api, channelLabel, moscowDate, type Member, type Stats } from './data';
import { useCatalog } from './use-catalog';
import { Empty, Failure, Loading, Unavailable } from './shared';
import s from './channels.module.css';
export function PersonDrawer({member,onClose,onHistory}:{member:Member;onClose:()=>void;onHistory:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const person = useCatalog<Stats>(member.person_id ? `${api}/users/${encodeURIComponent(member.person_id)}/stats` : null);
  useEffect(() => {
    const node=dialog.current;
    const previous=document.activeElement;
    node?.showModal();
    return () => {node?.close(); if (previous instanceof HTMLElement) previous.focus();};
  }, []);
  const stats=person.data;
  const days=stats?.days ?? [];
  const max=Math.max(1,...days.map(day=>day.messages));
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="person-title" onCancel={onClose} onClick={event=>{if(event.target===event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) onClose();}}>
    <div className={s.drawer}>
      <div className={s.drawerHead}><h2 id="person-title">Участник сервера</h2><IconButton aria-label="Закрыть участника" tooltipSide="left" icon={<X size={18}/>} onClick={onClose}/></div>
      <div className={s.profile}><Avatar name={member.display_name || member.username} size={52}/><div><h3>{member.display_name || member.username || 'Без имени'}</h3><div className={s.username}>{member.username?.replace(/^@/,'') || 'Имя пользователя неизвестно'}{Boolean(member.is_bot)&&<span className={s.bot}>bot</span>}</div></div></div>
      <dl className={s.detail}><div><dt>Discord ID</dt><dd>{member.discord_id}</dd></div><div><dt>Person ID</dt><dd>{member.person_id || 'Не связан с памятью'}</dd></div></dl>
      <Button variant="secondary" className="w-full" disabled={!member.person_id} onClick={onHistory}>Показать историю</Button>
      <h3 className={s.sectionTitle}>Активность</h3>
      {!member.person_id ? <Empty title="Нет связи с памятью" text="Статистика появится после идентификации участника."/> : person.loading ? <Loading/> : person.error ? <Failure message={person.error} retry={person.retry}/> : stats?.available===false ? <Unavailable/> : stats && <>
        <div className={s.stats}><div className={s.stat}><strong>{stats.messages}</strong><span>сообщений всего</span></div><div className={s.stat}><strong>{stats.turns}</strong><span>ходов</span></div></div>
        <dl className={`${s.detail} mt-6`}><div><dt>Первый контакт · МСК</dt><dd>{moscowDate(stats.first_contact)}</dd></div><div><dt>Последний контакт · МСК</dt><dd>{moscowDate(stats.last_contact)}</dd></div></dl>
        <h3 className={s.sectionTitle}>Сообщения по дням</h3>
        {days.length ? <><div role="img" aria-label={days.map(day=>`${day.date}: ${day.messages}`).join('; ')} className={s.barChart}>{days.map(day=><div key={day.date} className={s.bar} title={`${day.date}: ${day.messages}`} style={{height:`${day.messages/max*100}%`}}/>)}</div><div className={s.chartRange}><span>{days[0].date}</span><span>{days.at(-1)?.date}</span></div></> : <p className={s.muted}>Нет данных по дням.</p>}
        <h3 className={s.sectionTitle}>Каналы</h3><ul className={s.channelStats}>{stats.channels.map((channel,index)=><li key={`${channel.channel_id}-${index}`}><span>{channelLabel(channel.channel_id)}</span><span>{channel.messages}</span></li>)}</ul>
      </>}
    </div>
  </dialog>;
}
