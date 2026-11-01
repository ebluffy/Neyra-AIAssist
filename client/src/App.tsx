import { AboutPanel } from './components/AboutPanel';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { GearMenu } from './components/GearMenu';
import { HistoryPanel } from './components/HistoryPanel';
import { LiveVoice } from './components/LiveVoice';
import { PermissionCard } from './components/PermissionCard';
import { ServerPanel } from './components/ServerPanel';
import { SettingsSheet } from './components/SettingsSheet';
import { StatusPanel } from './components/StatusPanel';
import { VoicePanel } from './components/VoicePanel';
import { VoiceRecorder } from './components/VoiceRecorder';
import { ChevronLeft, ChevronRight, Plus, Settings } from 'lucide-react';
import { daypart } from './chat';
import { VoiceOrb } from './components/VoiceOrb';
import { CharacterPanel } from './CharacterPanel';
import { UpdatesPanel } from './UpdatesPanel';
import { CommandsScreen } from './screens/CommandsScreen';
import { DraftDialog } from './screens/DraftDialog';
import { PermissionsScreen } from './screens/PermissionsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useDesktop } from './useDesktop';

function osName(value: string): string {
  if (value === 'windows') return 'Windows';
  if (value === 'macos' || value === 'darwin') return 'macOS';
  if (value === 'linux') return 'Linux';
  return value || 'эта система';
}

export function App() {
  const app = useDesktop();
  const empty = app.messages.length === 0 && !app.partial;
  const turnBusy = app.thinking || app.partial.length > 0 || app.active;
  return <div className="shell" data-theme={app.theme}>
    <HistoryPanel open={app.historyOpen} threads={app.threads} activeId={app.activeId} onClose={() => app.setHistoryOpen(false)} onOpen={id => void app.openThread(id)} onNew={() => void app.newChat()} />
    <div className="stage">
      <div className="lead">
        <button type="button" className="icon history-toggle" aria-label={app.historyOpen ? 'Свернуть' : 'Развернуть'} aria-expanded={app.historyOpen} data-tip={app.historyOpen ? 'Свернуть' : 'Развернуть'} onClick={() => app.setHistoryOpen(open => !open)}>{app.historyOpen ? <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />}</button>
        {!app.historyOpen && <button type="button" className="icon plus" aria-label="Новый чат" data-tip="Новый чат" onClick={() => void app.newChat()}><Plus size={18} strokeWidth={1.75} aria-hidden="true" /></button>}
      </div>
      <div className="chrome">
        <button type="button" className="stop" onClick={() => void app.stop()}>Стоп</button>
        <div className="chrome-rest" inert={app.sheet ? true : undefined}>
          <span className="dot" data-on={app.connected ? 'true' : 'false'} role="status" data-tip={app.connected ? 'Подключено' : 'Нет подключения'} aria-label={app.connected ? 'Подключено' : 'Нет подключения'} />
          <div className="menu-anchor">
            <button type="button" className="icon" id="gear" aria-label="Меню" aria-haspopup="true" aria-expanded={app.menuOpen} aria-controls={app.menuOpen ? 'gear-menu' : undefined} onClick={() => app.setMenuOpen(open => !open)}><Settings size={18} strokeWidth={1.75} aria-hidden="true" /></button>
            <GearMenu open={app.menuOpen} onClose={app.closeMenu} onSettings={() => app.openSheet('settings')} version={app.appVersion} os={osName(app.platform)} />
          </div>
        </div>
      </div>
      <div className={empty && !app.liveOpen ? 'column is-empty' : 'column'}>
        {app.settings && !app.connected && <div className="offline" role="status"><p>Нет связи с сервером. Сообщения заработают после подключения.</p><button type="button" onClick={() => app.openSheet('server')}>Настройки сервера</button></div>}
        {app.error && !app.sheet && <div className="error" id="form-error" role="alert">{app.error}</div>}
        {!app.settings && <section className="greet"><h1>Запуск Neyra</h1><p>Загружаю локальные настройки…</p></section>}
        {app.settings && empty && !app.liveOpen && <div className="greet"><VoiceOrb state="idle" level={0.15} mini /><h1>{daypart(new Date().getHours())}</h1><p>Напишите сообщение или запишите голос.</p></div>}
        {app.settings && !empty && !app.liveOpen && <ChatView messages={app.messages} partial={app.partial} thinking={app.thinking} onCopy={app.copyText} onSpeak={value => void app.speak(value)} onRepeat={value => void app.sendContent(value)} turnBusy={turnBusy || app.recording || app.liveOpen} voiceBusy={turnBusy || app.recording || app.liveOpen} />}
        {app.liveOpen && <LiveVoice state={app.liveState} mode={app.voice.mode} level={app.micLevel} muted={app.muted} busy={app.busy} messages={app.messages} partial={app.partial} onMute={() => void app.toggleMute()} onSettings={() => app.openSheet('voice')} onEnd={() => void app.endLive()} />}
        {app.hostCall && <PermissionCard key={app.hostCall.call_id} call={app.hostCall} onAllow={() => void app.approve(true)} onReject={() => void app.approve(false)} />}
        {app.draft && <DraftDialog key={app.draft.draft_id} draft={app.draft} busy={app.busy} onSave={item => void app.decideDraft(true, item)} onReject={item => void app.decideDraft(false, item)} />}
        {!app.liveOpen && (app.recording
          ? <VoiceRecorder level={app.micLevel} busy={app.busy} onCancel={() => void app.cancelRecording()} onDone={() => void app.finishRecording()} />
          : <Composer text={app.text} connected={app.connected} busy={app.busy} turnBusy={turnBusy} liveBlocked={app.voice.mode === 'ptt'} onText={app.setText} onSend={() => void app.sendContent(app.text)} onRecord={() => void app.beginRecording()} onLive={() => void app.startLive()} onStop={() => void app.stop()} />)}
        {app.lastTrace !== undefined && !app.liveOpen && <details><summary>Модели последнего ответа</summary><pre>{JSON.stringify(app.lastTrace, null, 2)}</pre></details>}
      </div>
    </div>
    {app.sheet && app.settings && <SettingsSheet section={app.sheet} onSection={app.setSheet} onClose={app.closeSheet} onStop={() => void app.stop()} alert={app.error}>
      {app.sheet === 'server' && <ServerPanel settings={app.settings} profile={app.profile} profileId={app.profileId} token={app.token} connected={app.connected} busy={app.busy} devices={app.devices} target={app.target} onProfile={app.chooseProfile} onPatch={app.patchProfile} onAdd={app.addProfile} onToken={app.setToken} onTarget={app.setTarget} onCheck={() => void app.check()} onConnect={() => void app.connect()} onDisconnect={() => void app.disconnect()} onRefreshDevices={() => void app.refreshDevices()} onDisconnectDevice={() => void app.disconnectDevice()} />}
      {app.sheet === 'voice' && <VoicePanel voice={app.voice} root={app.root} busy={app.busy} shortcuts={app.shortcuts} voiceStatus={app.voiceStatus} onDraft={app.draftVoice} onSave={patch => void app.saveVoice(patch)} onRefresh={() => void app.refreshVoice()} />}
      {app.sheet === 'commands' && <CommandsScreen busy={app.busy} run={app.run} notify={app.notify} runLine={app.runLine} running={app.commandRunning} />}
      {app.sheet === 'permissions' && <PermissionsScreen settings={app.settings} setSettings={app.setSettings} saveSection={app.saveSection} pcAvailable={app.pcAvailable} busy={app.busy} run={app.run} notify={app.notify} backends={app.backends} />}
      {app.sheet === 'character' && <CharacterPanel />}
      {app.sheet === 'settings' && <SettingsScreen settings={app.settings} setSettings={app.setSettings} saveSection={app.saveSection} root={app.root} recoveries={app.recoveries} connected={app.connected} busy={app.busy} run={app.run} notify={app.notify} applyImported={app.setSettings} onTheme={theme => void app.setTheme(theme)} />}
      {app.sheet === 'status' && <StatusPanel busy={app.busy} profileId={app.profileId} status={app.status} plugins={app.plugins} onStatus={() => void app.refreshStatus()} onPlugins={() => void app.refreshPlugins()} onRestart={() => void app.restartCore()} onToggle={plugin => void app.togglePlugin(plugin)} />}
      {app.sheet === 'updates' && <UpdatesPanel />}
      {app.sheet === 'about' && <AboutPanel />}
    </SettingsSheet>}
    {app.notice && <p className={app.noticeSticky ? 'banner' : 'toast'} role="status">{app.notice}{app.noticeSticky && <button type="button" className="icon" aria-label="Закрыть сообщение" onClick={app.dismissNotice}>×</button>}</p>}
  </div>;
}
