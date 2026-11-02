import type { VoiceSettings, VoiceStatus } from '../types';

interface Props {
  voice: VoiceSettings;
  root: string;
  busy: boolean;
  shortcuts: boolean;
  voiceStatus?: VoiceStatus;
  onDraft: (patch: Partial<VoiceSettings>) => void;
  onSave: (patch: Partial<VoiceSettings>) => void;
  onRefresh: () => void;
}

export function VoicePanel({ voice, root, busy, shortcuts, voiceStatus, onDraft, onSave, onRefresh }: Props) {
  return <section className="voice" aria-labelledby="voice-title">
    <h1 id="voice-title">Голос</h1>
    <p>STT и TTS работают на сервере. На этом ПК только микрофон, воспроизведение и детектор слова «Нейра». Аудио не сохраняется.</p>
    <p>Голосовое сообщение — кнопка микрофона у поля ввода. Разговор голосом включается только кнопкой волны рядом с ним.</p>
    <p>{shortcuts ? 'Push-to-talk: удерживайте Ctrl+Alt+Space. Стоп: Ctrl+Alt+Escape или кнопка «Стоп» справа сверху.' : 'Глобальные хоткеи недоступны: используйте кнопки записи и Стоп.'}</p>
    <h2>Режим</h2>
    <label>Как начинать разговор<select value={voice.mode} disabled={busy} onChange={event => onSave({ mode: event.target.value as VoiceSettings['mode'] })}><option value="ptt">Push-to-talk: кнопка или хоткей</option><option value="wake">Слово «Нейра» и команда</option><option value="always">Слушать всегда</option></select></label>
    <label>Чувствительность к речи: {Math.round(voice.vad_sensitivity * 100)}%<input type="range" min={0} max={1} step={0.05} value={voice.vad_sensitivity} disabled={busy} onChange={event => onDraft({ vad_sensitivity: Number(event.target.value) })} onPointerUp={() => onSave({})} onKeyUp={() => onSave({})} /></label>
    <label>Пауза, после которой фраза закончена<select value={voice.end_silence_ms} disabled={busy} onChange={event => onSave({ end_silence_ms: Number(event.target.value) })}><option value={500}>0,5 с</option><option value={700}>0,7 с</option><option value={1000}>1 с</option><option value={1500}>1,5 с</option></select></label>
    <label>Перебивать Нейру голосом<select value={voice.barge_in} disabled={busy} onChange={event => onSave({ barge_in: event.target.value as VoiceSettings['barge_in'] })}><option value="off">Нет: микрофон молчит, пока Нейра говорит</option><option value="headphones">Да, я в наушниках</option></select></label>
    <p>{voice.barge_in === 'off' ? 'Эхоподавления нет: пока Нейра говорит, микрофон выключен, чтобы она не слышала сама себя. Перебить можно кнопкой Стоп или Ctrl+Alt+Escape.' : 'Работает только в наушниках. Через колонки Нейра услышит свой голос и перебьёт сама себя: эхоподавления нет.'}</p>
    <h2>Слово «Нейра»</h2>
    <label>Порог срабатывания: {Math.round(voice.wake_threshold * 100)}%<input type="range" min={0.05} max={0.99} step={0.01} value={voice.wake_threshold} disabled={busy} onChange={event => onDraft({ wake_threshold: Number(event.target.value) })} onPointerUp={() => onSave({})} onKeyUp={() => onSave({})} /></label>
    <button type="button" disabled={busy} onClick={onRefresh}>Проверить модель</button>
    {voiceStatus && (voiceStatus.wake.ready ? <p role="status">Модель готова: {voiceStatus.wake.model} · {voiceStatus.wake.license}</p> : <p role="status">Модель не готова: {voiceStatus.wake.message}</p>)}
    <p>Модель лежит локально в папке <span className="path">{voiceStatus?.wake.dir ?? `${root}/wakeword`}</span>: melspectrogram.onnx, embedding_model.onnx, модель «Нейра» и wakeword.json. Английские модели openWakeWord не подходят.</p>
  </section>;
}
