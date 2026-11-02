# Выпуск клиента Neyra

1. Один раз на компьютере владельца создайте ключ обновлений (не добавляйте ключ в Git):

   ```sh
   cd client
   npx tauri signer generate -w ~/.tauri/neyra.key
   ```

   Сохраните резервную копию закрытого ключа и пароль. Потеря ключа означает,
   что установленные клиенты нельзя будет обновить без переустановки.

2. Поместите **публичный** ключ из `~/.tauri/neyra.key.pub` в
   `client/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) и закоммитьте
   конфигурацию. Не используйте тестовый ключ из репозитория.

3. В настройках репозитория GitHub (`Settings` -> `Secrets and variables` ->
   `Actions`) добавьте секреты `TAURI_SIGNING_PRIVATE_KEY` (содержимое
   `~/.tauri/neyra.key`) и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (пароль от ключа).

4. Обновите одну и ту же версию в `client/package.json`,
   `client/src-tauri/tauri.conf.json`, `client/src-tauri/Cargo.toml` и
   `client/src-tauri/Cargo.lock`. Проверьте командой
   `node client/scripts/check-versions.mjs client-v<версия>` из корня репозитория.
   Закоммитьте изменения, создайте и отправьте тег:

   ```sh
   git tag client-v<версия>
   git push origin client-v<версия>
   ```

5. Проверьте успешное завершение всех заданий `Desktop release` в GitHub
   Actions и опубликованный релиз с установщиками, подписями и `latest.json`.
   Можно также вручную запустить workflow с уже созданным тегом через
   `workflow_dispatch`.

Тег с суффиксом, например `client-v0.2.0-beta.1`, публикуется как prerelease.
GitHub `releases/latest` не возвращает prerelease. По умолчанию клиент
использует стабильный канал; для бета-канала нужен отдельный rolling prerelease
`client-beta` с `latest.json` выбранного бета-релиза (ссылки на установщики
уже содержатся в манифесте).
