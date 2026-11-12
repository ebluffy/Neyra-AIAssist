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
  const invalidUrl = !!profile && !validServerUrl(profile.url);
  const connect = (action: () => void) => {
    if (invalidUrl) { document.getElementById('server-url')?.focus(); return; }
    action();
  };
  return <section aria-labelledby="server-title">
    <h1 id="server-title">Сервер и устройства</h1>
    <p>Профили хранятся на этом ПК. Токены хранятся в системном хранилище секретов.</p>
    {connected && <p className="hint" id="profile-locked">Чтобы изменить профиль, название, адрес или токен, отключитесь от сервера.</p>}
    {busy && <p className="hint" id="server-busy" role="status">Выполняется запрос… Дождитесь его завершения.</p>}
    <label>Профиль<select name="server-profile" autoComplete="off" aria-describedby={connected ? 'profile-locked' : busy ? 'server-busy' : undefined} value={profileId} disabled={busy || connected} onChange={event => onProfile(event.target.value)}><option value="">Выберите сервер</option>{settings.profiles.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    <button type="button" disabled={busy || connected || settings.profiles.length >= 12} onClick={() => { const created = newProfile(); onAdd(created); }}>Добавить профиль</button>
    {profile && <>
      <label>Название<input name="server-name" type="text" autoComplete="off" aria-describedby={connected ? 'profile-locked' : undefined} value={profile.name} maxLength={80} disabled={connected} onChange={event => onPatch({ name: event.target.value })} /></label>
      <label>Адрес сервера<input id="server-url" name="server-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} aria-invalid={invalidUrl} aria-describedby={invalidUrl ? 'server-url-error' : connected ? 'profile-locked' : undefined} value={profile.url} disabled={connected} onChange={event => onPatch({ url: event.target.value })} placeholder="https://server.example…" />
        {invalidUrl && <span className="field-error" id="server-url-error" role="alert">Укажите HTTPS-адрес без логина, пароля, параметров и фрагмента. HTTP доступен только для localhost, 127.0.0.1 или [::1].</span>}
      </label>
      <label>Токен<input name="server-token" type="password" autoComplete="off" spellCheck={false} aria-describedby={connected ? 'token-hint profile-locked' : 'token-hint'} value={token} disabled={connected} onChange={event => onToken(event.target.value)} placeholder="Токен сервера…" /></label>
      <p className="hint" id="token-hint">Оставьте поле пустым, чтобы использовать сохранённый токен.</p>
      <div className="actions">
        <button type="button" disabled={busy || connected} onClick={() => connect(onCheck)}>{busy ? 'Проверяю…' : 'Проверить подключение'}</button>
        <button type="button" className="primary" disabled={busy || connected} onClick={() => connect(onConnect)}>Подключить</button>
        <button type="button" disabled={busy || !connected} onClick={onDisconnect}>Отключить</button>
      </div>
    </>}
    <h2>Куда отправлять действия</h2>
    {!connected && <p className="hint" id="devices-locked">Подключитесь к серверу, чтобы выбрать ПК и обновить список устройств.</p>}
    <label>ПК для действий<select name="action-device" autoComplete="off" aria-describedby={!connected ? 'devices-locked' : undefined} value={target} disabled={!connected} onChange={event => onTarget(event.target.value)}><option value="">Этот ПК</option>{devices.map(device => <option key={device.device_id} value={device.device_id}>{device.name} · {device.device_id.slice(0, 8)}</option>)}</select></label>
    <div className="actions">
      <button type="button" onClick={onRefreshDevices} disabled={!connected || busy}>Обновить устройства</button>
      <button type="button" disabled={!connected || busy || !target} onClick={onDisconnectDevice}>Отключить выбранный ПК</button>
    </div>
  </section>;
}
