import type { LucideIcon } from 'lucide-react'
import {
  BookOpenText,
  Brain,
  Gauge,
  PlugZap,
  Server,
  Settings,
  Webhook,
} from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
}

export type NavGroup = {
  id: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Обзор',
    items: [{ to: '/status', label: 'Статус', icon: Gauge }],
  },
  {
    id: 'work',
    label: 'Работа',
    items: [
      { to: '/modules', label: 'Модули', icon: PlugZap },
      { to: '/memory', label: 'Память', icon: Brain },
      { to: '/webhooks', label: 'Вебхуки', icon: Webhook },
    ],
  },
  {
    id: 'server',
    label: 'Сервер',
    items: [
      { to: '/system', label: 'Система', icon: Server },
      { to: '/settings', label: 'Настройки', icon: Settings },
    ],
  },
  {
    id: 'help',
    label: 'Справка',
    items: [{ to: '/api-docs', label: 'Документация', icon: BookOpenText }],
  },
]

export const FLAT_NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

export const TITLE_MAP: Array<{ match: (p: string) => boolean; title: string; crumbs?: string[] }> = [
  { match: (p) => p === '/status' || p.startsWith('/status/'), title: 'Статус', crumbs: ['Статус'] },
  { match: (p) => p === '/modules' || p.startsWith('/modules/'), title: 'Модули', crumbs: ['Модули'] },
  { match: (p) => p === '/memory' || p.startsWith('/memory/'), title: 'Память', crumbs: ['Память'] },
  { match: (p) => p === '/system' || p.startsWith('/system/') || p === '/backups' || p.startsWith('/backups/'), title: 'Система', crumbs: ['Система'] },
  { match: (p) => p === '/webhooks' || p.startsWith('/webhooks/'), title: 'Вебхуки', crumbs: ['Вебхуки'] },
  { match: (p) => p === '/settings' || p.startsWith('/settings/'), title: 'Настройки', crumbs: ['Настройки'] },
  { match: (p) => p === '/api-docs' || p.startsWith('/api-docs/'), title: 'Документация', crumbs: ['Документация'] },
  { match: (p) => p === '/__ui', title: 'UI kit', crumbs: ['UI kit'] },
]

export function titleForPath(pathname: string): { title: string; crumbs: string[] } {
  const item = TITLE_MAP.find((n) => n.match(pathname))
  if (!item) return { title: 'Не найдено', crumbs: ['404'] }
  return { title: item.title, crumbs: item.crumbs ?? [item.title] }
}
