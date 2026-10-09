export type CoreRestartWaitResult = 'online' | 'timeout' | 'no_downtime'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function probeAuthStatus(): Promise<'up' | 'down'> {
  try {
    const r = await fetch('/v1/dashboard/auth/status', { headers: { Accept: 'application/json' } })
    if (!r.ok) return 'down'
    const text = await r.text()
    if (text.trimStart().startsWith('<')) return 'down'
    const j = JSON.parse(text) as { ok?: boolean }
    return j?.ok === true ? 'up' : 'down'
  } catch {
    return 'down'
  }
}

/**
 * Wait until the core process has actually gone down and come back.
 * Avoids a false "online" if POST /v1/system/restart was a no-op (old PID still serving).
 */
export async function waitForCoreRestart(opts?: {
  timeoutMs?: number
  intervalMs?: number
}): Promise<CoreRestartWaitResult> {
  const timeoutMs = opts?.timeoutMs ?? 90_000
  const intervalMs = opts?.intervalMs ?? 1000
  const deadline = Date.now() + timeoutMs
  let sawOffline = false

  while (Date.now() < deadline) {
    await sleep(intervalMs)
    const state = await probeAuthStatus()
    if (state === 'down') {
      sawOffline = true
      continue
    }
    if (sawOffline) return 'online'
  }

  return sawOffline ? 'timeout' : 'no_downtime'
}
