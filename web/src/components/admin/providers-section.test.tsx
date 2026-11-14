// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProvidersSection } from './providers-section';
import type { ProviderPreset, ProvidersPayload } from '../../../lib/admin-providers';

vi.mock('../../lib/ui-sounds', () => ({
  playButtonClickSound: vi.fn(),
}));

const openaiPreset: ProviderPreset = {
  id: 'openai',
  label: 'OpenAI',
  type: 'llm',
  type_label: 'LLM',
  base_url: 'https://api.openai.com/v1',
  kind: 'openai',
  needs_key: true,
  hint: 'Официальный API OpenAI',
  docs_url: 'https://platform.openai.com/docs',
  fields: [],
};

const deepgramTtsPreset: ProviderPreset = {
  id: 'deepgram-tts',
  label: 'Deepgram TTS',
  type: 'tts',
  type_label: 'Текст → речь',
  base_url: 'https://api.deepgram.com/v1',
  kind: 'openai',
  needs_key: true,
  hint: 'Озвучка Deepgram',
  docs_url: 'https://developers.deepgram.com/docs/tts',
  fields: [
    {
      key: 'model',
      label: 'Голос / модель',
      kind: 'text',
      required: false,
      placeholder: 'flux-polina-ru',
      help: '',
      default: 'flux-polina-ru',
      options: [],
      max_length: 200,
    },
    {
      key: 'expressivity',
      label: 'Выразительность',
      kind: 'number',
      required: false,
      placeholder: '',
      help: '',
      default: 0,
      options: [],
      max_length: 200,
      min: -2,
      max: 2,
    },
    {
      key: 'sample_rate',
      label: 'Частота',
      kind: 'select',
      required: false,
      placeholder: '',
      help: '',
      default: '24000',
      options: [
        { value: '24000', label: '24 кГц' },
        { value: '16000', label: '16 кГц' },
      ],
      max_length: 200,
    },
  ],
};

const yandexSttPreset: ProviderPreset = {
  id: 'yandex-stt',
  label: 'Yandex SpeechKit STT',
  type: 'stt',
  type_label: 'Речь → текст',
  base_url: 'https://stt.api.cloud.yandex.net/speech/v1',
  kind: 'openai',
  needs_key: true,
  hint: 'Распознавание речи Yandex Cloud',
  docs_url: 'https://yandex.cloud/ru/docs/speechkit/stt',
  fields: [
    {
      key: 'folder_id',
      label: 'Folder ID',
      kind: 'text',
      required: true,
      placeholder: 'b1g…',
      help: 'Идентификатор каталога',
      default: '',
      options: [],
      max_length: 200,
    },
    {
      key: 'language',
      label: 'Язык',
      kind: 'select',
      required: false,
      placeholder: '',
      help: '',
      default: 'ru-RU',
      options: [{ value: 'ru-RU', label: 'Русский' }],
      max_length: 200,
    },
  ],
};

const customPreset: ProviderPreset = {
  ...openaiPreset,
  id: 'custom',
  label: 'Свой провайдер',
  type: 'llm',
  base_url: '',
  hint: 'Свободное имя и адрес',
  docs_url: '',
};

function payload(): ProvidersPayload {
  return {
    providers: [
      {
        name: 'openai',
        label: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        kind: 'openai',
        builtin: true,
        preset: 'openai',
        provider_type: 'llm',
        provider_type_label: 'LLM',
        fields: {},
        needs_key: true,
        has_key: true,
        key_source: 'vault',
        lanes: ['talk'],
        probe: { state: 'open', models: 12, message: 'отвечает', checked_ago_seconds: 4 },
      },
    ],
    presets: [openaiPreset, deepgramTtsPreset, yandexSttPreset, customPreset],
    lanes: ['talk', 'brain', 'memory', 'vision'],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/admin/providers' && method === 'GET') {
      return Response.json({ ok: true, data: payload() });
    }
    if (method === 'PUT' && url.endsWith('/secret')) {
      return Response.json({ ok: true, data: { provider: payload().providers[0] } });
    }
    if (method === 'PUT') {
      return Response.json({
        ok: true,
        data: { provider: { ...payload().providers[0], name: 'deepgram-tts', label: 'Deepgram TTS' } },
      });
    }
    return Response.json({ ok: true, data: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ProvidersSection', () => {
  it('делит каталог на подключённые и доступные карточки', async () => {
    render(<ProvidersSection />);

    expect(await screen.findByText('Подключённые')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('Доступные')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Подключить Deepgram TTS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Подключить Yandex SpeechKit STT' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Подключить OpenAI' })).toBeNull();
  });

  it('показывает только поля выбранного пресета и подставляет значения', async () => {
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить Deepgram TTS' }));

    const model = screen.getByLabelText(/Голос \/ модель/) as HTMLInputElement;
    expect(model.value).toBe('flux-polina-ru');
    expect(screen.getByLabelText(/Выразительность/)).toBeTruthy();
    expect(screen.getByLabelText(/Частота/)).toBeTruthy();
    expect(screen.queryByLabelText(/Folder ID/)).toBeNull();
    expect(screen.queryByText('Base URL')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Имя и адрес/ }));
    expect(screen.getByLabelText('Base URL')).toBeTruthy();
  });

  it('не отправляет без обязательного ключа', async () => {
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить Deepgram TTS' }));
    fireEvent.click(screen.getByRole('button', { name: /^Подключить$/ }));

    expect(await screen.findByText(/Вставьте API-ключ/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('требует folder_id и отправляет вид, пресет и поля', async () => {
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить Yandex SpeechKit STT' }));

    fireEvent.change(screen.getByLabelText(/API-ключ/), { target: { value: 'yandex-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: /^Подключить$/ }));
    expect(await screen.findByText('Заполните «Folder ID».')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Folder ID/), { target: { value: 'b1g-test' } });
    fireEvent.click(screen.getByRole('button', { name: /^Подключить$/ }));

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
      expect(puts.length).toBe(2);
    });
    const providerCall = fetchMock.mock.calls.find(
      ([url, init]) => init?.method === 'PUT' && !String(url).endsWith('/secret'),
    );
    const body = JSON.parse(String(providerCall?.[1]?.body));
    expect(body).toMatchObject({
      preset: 'yandex-stt',
      provider_type: 'stt',
      fields: { folder_id: 'b1g-test', language: 'ru-RU' },
    });
    expect(JSON.stringify(body)).not.toContain('yandex-secret-key');
    expect(await screen.findByText(/Yandex SpeechKit STT подключён вместе с ключом/)).toBeTruthy();
  });

  it('фильтр по виду скрывает чужие карточки', async () => {
    render(<ProvidersSection />);
    expect(await screen.findByRole('button', { name: 'Подключить Deepgram TTS' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Текст → речь/ }));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.getByRole('button', { name: 'Подключить Deepgram TTS' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Подключить Yandex SpeechKit STT' })).toBeNull();
  });

  it('редактирует подключённого провайдера вместе с видом', async () => {
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Настроить/ }));

    expect(screen.getByText('Настройка «openai»')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/API-ключ/), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
      expect(puts.length).toBe(2);
    });
    const providerCall = fetchMock.mock.calls.find(
      ([url, init]) => init?.method === 'PUT' && !String(url).endsWith('/secret'),
    );
    const body = JSON.parse(String(providerCall?.[1]?.body));
    expect(body).toMatchObject({ preset: 'openai', provider_type: 'llm' });
  });

  it('показывает ошибку ядра и не теряет каталог', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: false, message: 'ядро недоступно' }, { status: 503 }));
    render(<ProvidersSection />);

    expect((await screen.findByRole('alert')).textContent).toContain('ядро недоступно');
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeTruthy();
  });
});
