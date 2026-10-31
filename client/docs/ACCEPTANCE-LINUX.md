# Ручная приёмка desktop-клиента на CachyOS

Команда из корня репозитория:

```sh
bash client/scripts/acceptance-linux.sh
```

Скрипт рассчитан на Linux владельца (CachyOS, KDE Plasma, Wayland, NVIDIA). Он не отмечает шаги 5–8 в `docs/PLAN.md` и не публикует релиз.

## Что делает команда

1. Проверяет компилятор, Node, Rust ≥ 1.91, WebKitGTK 4.1, GTK 3, appindicator, librsvg, ALSA, D-Bus и `patchelf`. Если чего-то нет, печатает одну команду `sudo pacman -S --needed ...` и сборку не начинает. Сборка принимается на Node 20.19+ и на Node 22.12+. CI ставит Node 22. Ровно 22 на Arch: `paru -S nodejs-lts-jod` (AUR) или nvm.
2. Читает текущую сессию (Wayland или X11), NVIDIA, масштаб выходов (`kscreen-doctor`, иначе `wlr-randr` / `swaymsg` / `xrandr`), портал рабочего стола, Secret Service и файлы wake word.
3. Ставит npm-зависимости (`npm ci --ignore-scripts`, повторно только если нет `node_modules` или сменился lockfile) и собирает AppImage.
4. Печатает чеклист и запускает клиент. Текст чеклиста остаётся в `~/.local/state/neyra/acceptance-checklist.txt`. Терминал не закрывать: в нём stderr WebKit и портала.

Повторный снимок окружения без сборки:

```sh
bash client/scripts/acceptance-linux.sh --check-only
```

## Флаги

| Флаг | Зачем |
|---|---|
| `--dev` | `npm run tauri dev` вместо AppImage. Удобно смотреть UI, обновление файла так не проверить. |
| `--no-launch` | Собрать и показать чеклист, окно не открывать. |
| `--fresh` | Заново выполнить `npm ci`. |
| `--updater` | Локальный тест плагина обновлений: `cargo test --locked --test updater_chain`. Сеть GitHub не нужна. |
| `--updater-appimage` | То же плюс AppImage, подписанный тестовым ключом из `src-tauri/updater-test/`. Ключ в `tauri.conf.json` не записывается. |

FUSE 2 для обычного запуска AppImage: `sudo pacman -S --needed fuse2`. Без него скрипт ставит `APPIMAGE_EXTRACT_AND_RUN=1`.

## Куда смотреть

Папка данных — та же, что у клиента: указатель `~/.config/neyra/data-location.json`, иначе `~/Documents/Neyra` (или `~/.local/share/neyra`, если каталога Documents нет).

| Что | Где |
|---|---|
| Лог клиента | `<папка данных>/logs/client.log` (дальше `client.log.1` … `client.log.3`, порог 256 КБ). Токенов и звука там нет. |
| Ошибки окна | Терминал, из которого запущен скрипт. |
| Портал экрана | `journalctl --user -b -n 200 --no-pager \| grep -i portal` |
| STT, TTS, конверсия | Журнал сервера на той машине, где он запущен: `journalctl -u neyra -n 100 --no-pager` или его терминал. |

## Шаг 5. «Нейра»

Модели в репозитории нет. В `<папка данных>/wakeword/` лежат `melspectrogram.onnx`, `embedding_model.onnx`, свой классификатор и `wakeword.json` (`phrase` «Нейра», `language` `ru`, лицензия и источник). Английские модели openWakeWord клиент отвергает. Синтетические клипы без записи голоса: `server/scripts/wakeword_synth_dataset.py` на сервере (нужен серверный `.env`; скрипт приёмки его не запускает).

В окне: вкладка «Голос» → «Проверить модель». Дальше режимы «Слово «Нейра» и команда» и «Слушать всегда», half-duplex через колонки и перебивание только в режиме «Да, я в наушниках». Эхоподавления в клиенте нет: пока выбран «Нет», микрофон молчит, пока Нейра говорит.

## Шаг 6. Масштаб и Wayland

Скрипт показывает масштаб, который выставлен сейчас. 125% и 150% — это два разных прогона: Параметры системы → Экран и монитор, затем снова `--check-only`. Нужны два выхода. Клик по мишени на втором мониторе и у стыка мониторов должен попадать в то окно. На Wayland первый снимок и ввод спрашивают разрешение портала (`xdg-desktop-portal` и `xdg-desktop-portal-kde`). Глобальные хоткеи на Wayland не регистрируются, остаются кнопки.

## Шаг 7. Оверлей

Галочка «Персонаж на рабочем столе» в настройках не нажимается. Закройте клиент, в `settings/app.json` поставьте `"character_enabled": true`, запустите снова и нажмите «Показать окно». Заголовок окна — «Neyra character». На KDE Wayland «поверх окон» не гарантировано: правило KWin для этого заголовка. Свой `.vrm` кладётся в подкаталог `character`. Файл `client/tests/fixtures/neyra-test.vrm` годится только чтобы увидеть окно, это не модель для защиты. Windows этим скриптом не проверяется.

## Шаг 8. N → N+1

Локальный тест (`--updater`) гоняет настоящий плагин против HTTP на `127.0.0.1`: макет 0.1.0 и предложение 0.1.1, подпись тестовым ключом. Кнопка «Настройки → Обновления» этот адрес не читает. Она ходит только на GitHub:

- бета: `https://github.com/ebluffy/Neyra-AIAssist/releases/download/client-beta/latest.json`
- стабильный: `https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json`

Черновик GitHub по этим URL не отдаётся. Публичный ключ в `tauri.conf.json` — заготовка (minisign id `1AAFC11FB991FBB6`), приватной половины в репозитории нет. Пока нет своего ключа и файла `latest.json` на одном из этих адресов, кнопка в приложении не является прогоном N→N+1.

Когда будете делать настоящий draft:

1. Вне git: `cd client && npm run tauri -- signer generate -w "$HOME/neyra-updater.key"`. Файл ключа не коммитить.
2. Текст `.pub` записать в `plugins.updater.pubkey` и закоммитить только публичную половину.
3. Секреты GitHub `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Без них workflow `.github/workflows/client-release.yml` останавливается на preflight.
4. Одна версия в `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` и `src-tauri/Cargo.lock`. Проверка: `cd client && npm run check:versions`.
5. Тег `client-v<версия>` (для беты с суффиксом) или ручной запуск workflow «Desktop release (draft)». Workflow создаёт черновик и сам его не публикует.
6. После ручной публикации, для канала «Бета»: `gh release upload client-beta latest.json --clobber`. Стабильный канал читает только опубликованный GitHub Latest.
7. AppImage версии N лежит в каталоге, куда пользователь может писать (`~/Applications`). В клиенте: проверить → установить → перезапустить. Сверить адрес, токен, тему, разрешения, device id и что файл по тому же пути заменён.

Windows NSIS и SmartScreen сюда не входят. Подробный чеклист с вашими путями печатает сам скрипт.
