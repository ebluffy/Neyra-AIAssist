import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStoredTheme, getThemePreference, initTheme, setThemePreference } from './theme'

describe('theme preference', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('stores system and resolves via matchMedia', () => {
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })
    vi.stubGlobal('matchMedia', matchMedia)
    setThemePreference('system')
    expect(getThemePreference()).toBe('system')
    expect(getStoredTheme()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    vi.unstubAllGlobals()
  })

  it('persists explicit dark/light', () => {
    setThemePreference('dark')
    expect(getThemePreference()).toBe('dark')
    expect(getStoredTheme()).toBe('dark')
    setThemePreference('light')
    expect(getStoredTheme()).toBe('light')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
