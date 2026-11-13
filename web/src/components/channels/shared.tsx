'use client';
import React from 'react';
import { Hash } from 'lucide-react';
import { Button } from '../ui';
import s from './channels.module.css';
export function Loading() {
  return <div role="status" aria-label="Загрузка" className={s.grid}>{[0,1,2].map(key => <div key={key} className={s.skeleton} />)}</div>;
}
export function Failure({message,retry}:{message:string;retry:()=>void}) {
  return <div role="alert" className={s.error}><p>{message}</p><Button variant="secondary" size="sm" onClick={retry}>Повторить</Button></div>;
}
export function Empty({title,text}:{title:string;text:string}) {
  return <div className={s.empty}><Hash size={28} strokeWidth={1} aria-hidden="true" /><h2>{title}</h2><p>{text}</p></div>;
}
export function Unavailable() {return <Empty title="Хаб памяти недоступен" text="Данные сейчас нельзя получить. Показания не заменены нулями." />;}
