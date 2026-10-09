import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  apiGet,
  clearSessionToken,
  clearToken,
  getSessionToken,
  getStoredApiToken,
  getToken,
  setSessionToken,
  setToken,
} from './client'

describe('api/client token storage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    clearToken()
    clearSessionToken()
  })

  afterEach(() => {
    clearToken()
    clearSessionToken()
  })

  it('keeps session in sessionStorage only', () => {
    setSessionToken('sess-abc')
    expect(getSessionToken()).toBe('sess-abc')
    expect(sessionStorage.getItem('neyra_dashboard_session')).toBe('sess-abc')
    expect(localStorage.getItem('neyra_api_token')).toBeNull()
    expect(getToken()).toBe('sess-abc')
  })

  it('does not write API token to localStorage', () => {
    setToken('mem-token')
    expect(getStoredApiToken()).toBe('mem-token')
    expect(localStorage.getItem('neyra_api_token')).toBeNull()
    expect(getToken()).toBe('mem-token')
  })

  it('prefers session over memory token', () => {
    setToken('mem')
    setSessionToken('sess')
    expect(getToken()).toBe('sess')
  })
})

describe('api/client ApiRequestError', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { message: 'Too many', code: 'rate_limited', trace_id: 'tr-1' },
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '12',
              'x-trace-id': 'tr-hdr',
            },
          },
        ),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses code, status, trace_id, retryAfter', async () => {
    try {
      await apiGet('/v1/x')
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiRequestError)
      const err = e as ApiRequestError
      expect(err.status).toBe(429)
      expect(err.code).toBe('rate_limited')
      expect(err.trace_id).toBeTruthy()
      expect(err.retryAfter).toBe(12)
      expect(err.message).toContain('Too many')
    }
  })
})
