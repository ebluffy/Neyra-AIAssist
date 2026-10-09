const THEME_KEY = 'neyra_ui_theme'

export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

export function getThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return 'dark'
}

/** Resolved theme currently applied to the document. */
export function getStoredTheme(): Theme {
  const pref = getThemePreference()
  if (pref === 'system') return systemTheme()
  return pref
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.classList.toggle('light', theme === 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function setThemePreference(pref: ThemePreference): Theme {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* ignore */
  }
  const resolved = pref === 'system' ? systemTheme() : pref
  applyTheme(resolved)
  return resolved
}

export function initTheme(): Theme {
  const resolved = getStoredTheme()
  applyTheme(resolved)
  return resolved
}

export function toggleTheme(): Theme {
  const next: Theme = getStoredTheme() === 'light' ? 'dark' : 'light'
  setThemePreference(next)
  return next
}
