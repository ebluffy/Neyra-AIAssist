import { useSyncExternalStore } from 'react'

const THEME_KEY = 'neyra_ui_theme'

export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'dark'
}

export function getThemePreference(): ThemePreference {
  return readPreference()
}

/** Resolved theme currently applied to the document. */
export function getStoredTheme(): Theme {
  const pref = readPreference()
  if (pref === 'system') return systemTheme()
  return pref
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

function applyResolved(): Theme {
  const resolved = getStoredTheme()
  applyTheme(resolved)
  return resolved
}

let mediaBound = false
function ensureMediaListener(): void {
  if (mediaBound || typeof window === 'undefined') return
  if (typeof window.matchMedia !== 'function') return
  mediaBound = true
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = () => {
    if (readPreference() === 'system') {
      applyResolved()
      emit()
    }
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
  else mq.addListener(onChange)
}

export function setThemePreference(pref: ThemePreference): Theme {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* ignore */
  }
  ensureMediaListener()
  const resolved = applyResolved()
  emit()
  return resolved
}

export function initTheme(): Theme {
  ensureMediaListener()
  return applyResolved()
}

export function toggleTheme(): Theme {
  const next: Theme = getStoredTheme() === 'light' ? 'dark' : 'light'
  return setThemePreference(next)
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  ensureMediaListener()
  return () => {
    listeners.delete(listener)
  }
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, () => 'dark' as ThemePreference)
}

export function useResolvedTheme(): Theme {
  return useSyncExternalStore(subscribe, getStoredTheme, () => 'dark' as Theme)
}
