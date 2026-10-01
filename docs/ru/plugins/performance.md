# Performance рекомендации

- Не держите тяжёлые синхронные циклы в resident plugin без sleep/backoff.
- Сокращайте payload в event bus и webhook отправках.
- Для webhook delivery отслеживайте latency и ошибки в `deliveries`.
- Ограничивайте размер входных сообщений и вложений.