const SIDEBAR_KEY = 'neyra_ui_sidebar_collapsed'
const DENSITY_KEY = 'neyra_ui_density'

export type Density = 'compact' | 'comfortable'

export function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export function setSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function getDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY)
    if (v === 'comfortable' || v === 'compact') return v
  } catch {
    /* ignore */
  }
  return 'compact'
}

export function setDensity(density: Density): void {
  try {
    localStorage.setItem(DENSITY_KEY, density)
  } catch {
    /* ignore */
  }
  document.documentElement.setAttribute('data-density', density)
}

export function initUiPrefs(): void {
  document.documentElement.setAttribute('data-density', getDensity())
}
