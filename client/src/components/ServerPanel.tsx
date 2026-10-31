import { newProfile, validServerUrl, type Device, type Profile, type Settings } from '../types';

interface Props {
  settings: Settings;
  profile?: Profile;
  profileId: string;
  token: string;
  connected: boolean;
  busy: boolean;
  devices: Device[];
  target: string;
  onProfile: (id: string) => void;
  onPatch: (patch: Partial<Profile>) => void;
  onAdd: (profile: Profile) => void;
  onToken: (value: string) => void;
  onTarget: (value: string) => void;
  onCheck: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefreshDevices: () => void;
  onDisconnectDevice: () => void;
}

export function ServerPanel({ settings, profile, profileId, token, connected, busy, devices, target, onProfile, onPatch, onAdd, onToken, onTarget, onCheck, onConnect, onDisconnect, onRefreshDevices, onDisconnectDevice }: Props) {
  return <section aria-labelledby="server-title">
    <h1 id="server-title">Сервер и устройства</h1>
    <p>Профили хранятся на этом ПК. Токены — в системном хранилище секретов.</p>
    <label>Профиль<select value={profileId} disabled={busy || connected} onChange={event => onProfile(event.target.value)}><option value="">Выберите сервер</option>{settings.profiles.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    <button type="button" disabled={busy || connected || settings.profiles.length >= 12} onClick={() => { const created = newProfile(); onAdd(created); }}>Добавить профиль</button>
    {profile && <>
      <label>Название<input value={profile.name} maxLength={80} disabled={connected} onChange={event => onPatch({ name: event.target.value })} /></label>
      <label>Адрес сервера<input type="url" aria-invalid={!validServerUrl(profile.url)} value={profile.url} disabled={connected} onChange={event => onPatch({ url: event.target.value })} /></label>
      <label>Токен<input type="password" value={token} autoComplete="off" disabled={connected} onChange={event => onToken(event.target.value)} placeholder="Оставьте пустым, чтобы использовать сохранённый" /></label>
      <div className="actions">
        <button type="button" disabled={busy || connected} onClick={onCheck}>Проверить подключение</button>
        <button type="button" disabled={busy || connected} onClick={onConnect}>Подключить</button>
        <button type="button" disabled={busy || !connected} onClick={onDisconnect}>Отключить</button>
      </div>
    </>}
    <h2>Куда отправлять действия</h2>
    <label>ПК для действий<select value={target} disabled={!connected} onChange={event => onTarget(event.target.value)}><option value="">Этот ПК</option>{devices.map(device => <option key={device.device_id} value={device.device_id}>{device.name} · {device.device_id.slice(0, 8)}</option>)}</select></label>
    <div className="actions">
      <button type="button" onClick={onRefreshDevices} disabled={!connected || busy}>Обновить устройства</button>
      <button type="button" disabled={!connected || busy || !target} onClick={onDisconnectDevice}>Отключить выбранный ПК</button>
    </div>
  </section>;
}
