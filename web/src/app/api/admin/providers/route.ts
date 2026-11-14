import { requireAdmin } from '../../../../../lib/admin-guard';
import { readProviders, type ProvidersPayload } from '../../../../../lib/admin-providers';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FALLBACK_PROVIDERS: ProvidersPayload = {
  providers: [
    {
      name: 'openai',
      label: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
      kind: 'openai',
      builtin: true,
      has_key: false,
      key_source: 'none',
      lanes: ['talk', 'brain'],
      probe: null,
    },
    {
      name: 'anthropic',
      label: 'Anthropic',
      base_url: 'https://api.anthropic.com/v1',
      kind: 'anthropic',
      builtin: true,
      has_key: false,
      key_source: 'none',
      lanes: ['coding'],
      probe: null,
    },
    {
      name: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      kind: 'openrouter',
      builtin: true,
      has_key: false,
      key_source: 'none',
      lanes: [],
      probe: null,
    },
  ],
  presets: [
    { id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', kind: 'openai', needs_key: true, hint: 'sk-proj-...' },
    { id: 'anthropic', label: 'Anthropic', base_url: 'https://api.anthropic.com/v1', kind: 'anthropic', needs_key: true, hint: 'sk-ant-...' },
    { id: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', kind: 'openrouter', needs_key: true, hint: 'sk-or-...' },
    { id: 'groq', label: 'Groq', base_url: 'https://api.groq.com/openai/v1', kind: 'openai', needs_key: true, hint: 'gsk_...' },
    { id: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', kind: 'openai', needs_key: true, hint: 'sk-...' },
    { id: 'ollama', label: 'Ollama (локальный)', base_url: 'http://localhost:11434/v1', kind: 'openai', needs_key: false, hint: 'Не требует ключа' },
    { id: 'vllm', label: 'vLLM (локальный)', base_url: 'http://localhost:8000/v1', kind: 'openai', needs_key: false, hint: 'Не требует ключа' },
    { id: 'custom', label: 'Кастомный OpenAI-совместимый', base_url: '', kind: 'openai', needs_key: true, hint: 'Любой совместимый эндпоинт' },
  ],
  lanes: ['talk', 'brain', 'coding', 'vision'],
};

// Список провайдеров и каталог пресетов. Ключи приходят только флагом.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const result = await readProviders();
  if (result.state !== 'ok' || !result.data) {
    return jsonOk(FALLBACK_PROVIDERS);
  }
  return jsonOk(result.data);
}
