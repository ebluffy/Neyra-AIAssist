/** Optional SPA navigation guard (e.g. dirty Settings). */

type SyncBlocker = () => boolean
type LeaveAsk = () => Promise<boolean>

let syncBlocker: SyncBlocker | null = null
let leaveAsk: LeaveAsk | null = null
let bypassOnce = false

/** Register a sync guard that returns true if leaving is OK. */
export function setNavigationBlocker(next: SyncBlocker | null): void {
  syncBlocker = next
}

/**
 * Register an async leave confirm (DangerConfirm / soft dialog).
 * When set, sync allowNavigation returns false if dirty; callers must use tryAllowNavigation.
 */
export function setLeaveAsk(ask: LeaveAsk | null): void {
  leaveAsk = ask
}

/** One-shot bypass after the user confirmed leave in a dialog. */
export function allowNextNavigation(): void {
  bypassOnce = true
}

/** Sync check — returns false when a leave-ask is registered (must use tryAllowNavigation). */
export function allowNavigation(): boolean {
  if (bypassOnce) {
    bypassOnce = false
    return true
  }
  if (leaveAsk) {
    try {
      // Probe: if sync blocker says clean, allow; otherwise block until async confirm.
      if (syncBlocker) return syncBlocker()
      return false
    } catch {
      return true
    }
  }
  if (!syncBlocker) return true
  try {
    return syncBlocker()
  } catch {
    return true
  }
}

/** Prefer this for NavLink / ⌘K / programmatic leave when dirty forms may be open. */
export async function tryAllowNavigation(): Promise<boolean> {
  if (bypassOnce) {
    bypassOnce = false
    return true
  }
  if (leaveAsk) {
    try {
      if (syncBlocker && syncBlocker()) return true
    } catch {
      return true
    }
    const ok = await leaveAsk()
    if (ok) allowNextNavigation()
    return ok
  }
  return allowNavigation()
}
