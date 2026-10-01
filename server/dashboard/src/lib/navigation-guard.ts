/** Optional SPA navigation guard (e.g. dirty Settings). */

type Blocker = () => boolean

let blocker: Blocker | null = null

/** Register a guard that returns true if leaving the current screen is OK. */
export function setNavigationBlocker(next: Blocker | null): void {
  blocker = next
}

/** Returns false when navigation should be cancelled. */
export function allowNavigation(): boolean {
  if (!blocker) return true
  try {
    return blocker()
  } catch {
    return true
  }
}
