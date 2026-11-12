import { createRoot } from 'react-dom/client';
import { Button } from '@neyra/ui';
import type { ChatMessage } from '@neyra/contracts';
import '@neyra/ui/tokens.css';
const greeting: ChatMessage = { role: 'assistant', content: 'Нейра: каркас приложения' };
createRoot(document.getElementById('root')!).render(<main><p>{greeting.content}</p><Button disabled>Чат появится позже</Button></main>);
