import { beforeEach, describe, expect, it } from 'vitest';
import {
  UPLOAD_QUOTA_BYTES,
  UPLOAD_QUOTA_WINDOW_MS,
  UPLOAD_RATE_WINDOW_MS,
  UPLOAD_REQUESTS_PER_WINDOW,
  activeUploads,
  beginUpload,
  checkUploadQuota,
  checkUploadRateLimit,
  endUpload,
  recordUpload,
  resetUploadLimitsForTests,
  uploadQuotaUsed,
} from './upload-limits';

beforeEach(() => resetUploadLimitsForTests());

describe('upload rate limit', () => {
  it('counts uploads per user and frees the slot after the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < UPLOAD_REQUESTS_PER_WINDOW; i++) {
      expect(checkUploadRateLimit('user-1', now + i).ok).toBe(true);
    }
    const blocked = checkUploadRateLimit('user-1', now + UPLOAD_REQUESTS_PER_WINDOW);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkUploadRateLimit('user-2', now + UPLOAD_REQUESTS_PER_WINDOW).ok).toBe(true);
    expect(checkUploadRateLimit('user-1', now + UPLOAD_RATE_WINDOW_MS + 1).ok).toBe(true);
  });

  it('limits simultaneous uploads per user', () => {
    expect(beginUpload('user-1')).toBe(true);
    expect(beginUpload('user-1')).toBe(true);
    expect(beginUpload('user-1')).toBe(false);
    expect(activeUploads('user-1')).toBe(2);
    endUpload('user-1');
    expect(beginUpload('user-1')).toBe(true);
    endUpload('user-1');
    endUpload('user-1');
    expect(activeUploads('user-1')).toBe(0);
  });
});

describe('upload quota', () => {
  it('rejects an upload over the 24h quota and reports retry time', () => {
    const now = 2_000_000;
    recordUpload('user-1', UPLOAD_QUOTA_BYTES - 10, now);
    expect(checkUploadQuota('user-1', 5, now + 1).ok).toBe(true);
    const blocked = checkUploadQuota('user-1', 20, now + 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.remainingBytes).toBe(10);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('expires old usage by TTL so the quota is freed', () => {
    const now = 3_000_000;
    recordUpload('user-1', UPLOAD_QUOTA_BYTES, now);
    expect(uploadQuotaUsed('user-1', now + 1)).toBe(UPLOAD_QUOTA_BYTES);
    expect(checkUploadQuota('user-1', 1, now + 1).ok).toBe(false);
    expect(checkUploadQuota('user-1', 1, now + UPLOAD_QUOTA_WINDOW_MS + 1).ok).toBe(true);
  });
});
