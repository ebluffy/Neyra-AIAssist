import { Command } from 'cmdk'
import {
  BookOpenText,
  Brain,
  DatabaseBackup,
  Gauge,
  Moon,
  PlugZap,
  Server,
  Settings,
  Sun,
  Webhook,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStoredTheme, toggleTheme } from '../lib/theme'

const NAV_ITEMS = [
  { to: '/status', label: 'Статус', icon: Gauge },
  { to: '/modules', label: 'Модули', icon: PlugZap },
  { to: '/memory', label: 'Память', icon: Brain },
  { to: '/system', label: 'Система', icon: Server },
  { to: '/backups', label: 'Бэкапы', icon: DatabaseBackup },
  { to: '/webhooks', label: 'Вебхуки', icon: Webhook },
  { to: '/settings', label: 'Настройки', icon: Settings },
  { to: '/api-docs', label: 'Документация', icon: BookOpenText },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState(getStoredTheme)
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function go(to: string) {
    setOpen(false)
    navigate(to)
  }

  if (!open) return null

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <Command
        className="cmdk-dialog"
        label="Командная палитра"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <Command.Input className="cmdk-input" placeholder="Перейти…" />
        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">Ничего не найдено</Command.Empty>
          <Command.Group>
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <Command.Item
                key={to}
                className="cmdk-item"
                onSelect={() => go(to)}
                value={`${label} ${to}`}
              >
                <Icon aria-hidden className="cmdk-item-icon" size={16} strokeWidth={1.75} />
                {label}
              </Command.Item>
            ))}
            <Command.Item
              className="cmdk-item"
              onSelect={() => {
                setTheme(toggleTheme())
                setOpen(false)
              }}
              value="тема theme dark light"
            >
              {theme === 'light' ? (
                <Moon aria-hidden className="cmdk-item-icon" size={16} strokeWidth={1.75} />
              ) : (
                <Sun aria-hidden className="cmdk-item-icon" size={16} strokeWidth={1.75} />
              )}
              Тема: {theme === 'light' ? 'светлая' : 'тёмная'}
            </Command.Item>
          </Command.Group>
        </Command.List>
        <div className="cmdk-hint">⌘K / Ctrl+K · Esc</div>
      </Command>
    </div>
  )
}
