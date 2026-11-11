import { describe, expect, it } from 'vitest';
import { acceptLiveRun, validServerUrl, formatError, newProfile, absolutePath, meterLevel, liveLabel, settleLiveStart, conversionNotice, unwrapApi, defaultVoice, emptyAudioDevices } from './types';
describe('allowed folders', () => {
  it('accepts only absolute paths', () => { expect(absolutePath('/home/me/Docs')).toBe(true); expect(absolutePath('C:\\Users\\me')).toBe(true); for (const v of ['Docs', '~/Docs', '..\\x', '']) expect(absolutePath(v)).toBe(false); });
});
describe('server profiles', () => {
  it('rejects non-TLS remote servers and embedded secrets', () => { for (const value of ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=x', 'file:///tmp/server']) expect(validServerUrl(value)).toBe(false); });
  it('allows local development and a proxy prefix', () => { expect(validServerUrl('http://127.0.0.1:8787')).toBe(true); expect(validServerUrl('https://neyra.example/api')).toBe(true); });
  it('creates independent private profile sessions', () => { const a = newProfile(); const b = newProfile(); expect(a.id).not.toBe(b.id); expect(a.session_id).not.toBe(b.session_id); });
  it('does not stringify internal errors', () => { expect(formatError(new Error('secret'))).not.toContain('secret'); });
  it('explains unavailable credential storage without suggesting a file fallback', () => {
    expect(formatError('credential_store_unavailable')).toContain('Secret Service/keyring');
    expect(formatError('credential_store_unavailable')).toContain('Токен не сохранён в файл');
    expect(formatError('token_missing')).toBe('Сначала сохраните токен.');
  });
  it('explains a blocked export and identifies the command', () => {
    expect(formatError('export_contains_token:command:1')).toBe('Экспорт отменён: сохранённый токен найден в команде №1. Удалите токен из команды или настроек и повторите экспорт.');
    expect(formatError('export_contains_token:settings')).toBe('Экспорт отменён: сохранённый токен найден в настройках или разрешениях. Удалите токен из команды или настроек и повторите экспорт.');
  });
});
describe('live voice labels', () => {
  it('clamps the mic meter', () => { expect(meterLevel(-100)).toBe(0); expect(meterLevel(0)).toBe(1); expect(meterLevel(-35)).toBeCloseTo(0.5); });
  it('says what the mic waits for', () => { expect(liveLabel('idle', 'wake')).toContain('Нейра'); expect(liveLabel('idle', 'always')).toBe('Слушаю'); });
  it('stops a mic that starts after the conversation ended', async () => {
    let epoch = 4;
    const atUnmute = epoch;
    const calls: string[] = [];
    epoch += 1;
    const opened = await settleLiveStart(atUnmute, epoch, async () => { calls.push('live_stop'); });
    expect(opened).toBe(false);
    expect(calls).toEqual(['live_stop']);
    expect(await settleLiveStart(epoch, epoch, async () => { calls.push('live_stop'); })).toBe(true);
    expect(calls).toEqual(['live_stop']);
  });
  it('never hides a conversion fallback', () => { expect(conversionNotice('passthrough', 'timeout')).toContain('исходный голос'); expect(conversionNotice('stopped', 'bad_output')).toContain('остановлена'); expect(conversionNotice(undefined)).toBe(''); });
});
describe('server envelope', () => {
  it('reads the payload rust returns unchanged', () => {
    expect(unwrapApi<{ plugins: { id: string }[] }>({ ok: true, trace_id: 't', data: { plugins: [{ id: 'example' }] } }).plugins[0].id).toBe('example');
    expect(unwrapApi<{ status: string }>({ ok: true, trace_id: 't', data: { status: 'ok' } }).status).toBe('ok');
    expect(unwrapApi<{ info: { version: string } }>({ info: { version: '1.1.0' } }).info.version).toBe('1.1.0');
  });
  it('drops events from a live run that already ended', () => {
    const started = acceptLiveRun(0, { type: 'live.started', run: 2 });
    expect(started).toEqual({ current: 2, accept: true });
    expect(acceptLiveRun(started.current, { type: 'live.stopped', run: 1 }).accept).toBe(false);
    expect(acceptLiveRun(started.current, { type: 'listening', run: 2 }).accept).toBe(true);
    expect(acceptLiveRun(started.current, { type: 'token' }).accept).toBe(true);
  });
});
describe('audio devices types', () => {
  it('initializes default voice with empty input and output devices', () => {
    expect(defaultVoice.input_device).toBe('');
    expect(defaultVoice.output_device).toBe('');
  });
  it('provides empty audio devices fallback', () => {
    expect(emptyAudioDevices).toEqual({
      input_devices: [],
      output_devices: [],
      default_input: null,
      default_output: null,
    });
  });
});
