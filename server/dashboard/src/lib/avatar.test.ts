import { describe, expect, it } from 'vitest'
import { avatarSrc } from './avatar'

describe('avatarSrc', () => {
  it('adds size=64 to Discord CDN URLs without size', () => {
    expect(avatarSrc('https://cdn.discordapp.com/avatars/1/a.png')).toBe(
      'https://cdn.discordapp.com/avatars/1/a.png?size=64',
    )
  })

  it('forces size=64 even when Discord already sent a larger size', () => {
    expect(avatarSrc('https://cdn.discordapp.com/avatars/1/a.png?size=1024')).toBe(
      'https://cdn.discordapp.com/avatars/1/a.png?size=64',
    )
  })

  it('leaves non-Discord hosts untouched', () => {
    const url = 'https://example.com/pic.png?size=1024'
    expect(avatarSrc(url)).toBe(url)
  })

  it('returns invalid strings as-is', () => {
    expect(avatarSrc('not a url')).toBe('not a url')
  })

  it('returns undefined for empty', () => {
    expect(avatarSrc('')).toBeUndefined()
    expect(avatarSrc(null)).toBeUndefined()
    expect(avatarSrc(undefined)).toBeUndefined()
  })
})
