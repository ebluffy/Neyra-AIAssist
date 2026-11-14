# @neyra/contracts
Zod + TypeScript, без DOM. Сборка tsc → dist.
ChatRequest/WsChatMessage — целевой v2 по web-v2 §9/§15: model, attachments, stop пока НЕ поддержаны ядром базы P0; не отправлять до P1.
WS-события основаны на /v1/ws/chat; memory search/recall/write/add и desktop manifest — на Python-моделях базы. Capture events — native bridge.
Это стартовое подмножество контрактов, не полный клиент API. Identity и memory scope проверяются сервером, не схемами.
