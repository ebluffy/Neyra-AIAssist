import { Command } from 'cmdk'
import { Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStoredTheme, toggleTheme } from '../lib/theme'
import { FLAT_NAV } from '../shell/nav'

type Props = {
  controlledOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function CommandPalette({ controlledOpen, onOpenChange }: Props = {}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(open) : next
      if (controlledOpen === undefined) setInternalOpen(value)
      onOpenChange?.(value)
    },
    [controlledOpen, onOpenChange, open],
  )
  const [theme, setTheme] = useState(getStoredTheme)
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    const onCustom = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('neyra:open-command-palette', onCustom)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('neyra:open-command-palette', onCustom)
    }
  }, [setOpen])

  function go(to: string) {
    setOpen(false)
    navigate(to)
  }

  if (!open) return null

  return (
    <div
      aria-label="Закрыть палитру"
      className="cmdk-overlay"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
      role="presentation"
    >
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
            {FLAT_NAV.map(({ to, label, icon: Icon }) => (
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
