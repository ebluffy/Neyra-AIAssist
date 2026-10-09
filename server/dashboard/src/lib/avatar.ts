/** Normalize avatar URLs for ops UI thumbnails (Discord CDN → size=64). */
export function avatarSrc(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const isDiscord =
      host === 'cdn.discordapp.com' ||
      host === 'media.discordapp.net' ||
      host.endsWith('.discordapp.com') ||
      host.endsWith('.discordapp.net')
    if (!isDiscord) return url
    u.searchParams.set('size', '64')
    return u.toString()
  } catch {
    return url
  }
}
