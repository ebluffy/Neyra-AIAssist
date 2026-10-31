# Character assets — license research (§3b.6 step 0)

Research date: 2026-10-31. Code of Desktop Mate is **not** copied. Behaviour notes only (transparent overlay, always-on-top, click-through except avatar, idle, cursor look, sit-on-window where OS allows, lip-sync with TTS).

## Desktop Mate (Steam app 3301060, Infiniteloop)

| Ассет | Источник | Автор | Лицензия | Можно ли распространять в Neyra |
|---|---|---|---|---|
| Модели / анимации / контент приложения | Steam EULA / ToS Desktop Mate | Infiniteloop Co., Ltd. (+ IP holders для DLC) | Контент только в рамках App; запрещены reproduction / secondary use / redistribution / reverse engineering beyond ToS | **Нет** |
| Официальные DLC-персонажи | Paid content terms | Rights holders + Infiniteloop | Лицензия только покупателю; отдельные условия правообладателя | **Нет** |
| Идеи поведения / UX | Публичные описания + community notes (например обзор поведения без копирования кода) | — | Идеи не копируют ассеты | Да (только идеи) |

Вывод: **ассеты Desktop Mate в репозиторий и сборку не кладём.** Окно персонажа — собственная реализация.

Источники:
- https://store.steampowered.com/eula/3301060_eula_0
- https://store.steampowered.com/app/3301060/Desktop_Mate/
- Steam discussion: policy on VRM/MOD (developer: unrestricted VRM loading not planned; IP licensing)

## Кандидаты на модель по умолчанию (не Desktop Mate)

| Ассет | Источник | Автор | Лицензия | Можно ли распространять |
|---|---|---|---|---|
| β Ver AvatarSample_3 (и 1/2/4) | VRoid Studio sample / VRoid Hub sample pages | pixiv / VRoid | **CC0** (по FAQ VRoid; при использовании `.vroid` — ToS VRoid Studio; при `.vrm` с Hub — ToS Hub) | **Да**, при соблюдении CC0 + ToS экспорта. Файл **не** вшит в эту поставку: владелец экспортирует VRM в `Documents/Neyra/character/` |
| AvatarSample_A/B/C | VRoid Studio presets | pixiv / VRoid | Отдельные conditions of use (не CC0) — читать FAQ перед бандлом | Только если conditions явно разрешают redistribution в стороннем приложении |
| Пользовательский `.vrm` | VRoid Hub / собственная модель | Автор модели | Embedded VRM license + Hub flags (Redistribution / Alteration / Avatar use) | Только если Redistribution=Allow (или эквивалент) **и** пользователь подтвердил; иначе только локальная загрузка без бандла |
| Mixamo animations | Adobe Mixamo | Adobe | Mixamo terms (account required; check current redistribution for app embedding) | Не бандлить, пока terms не подтверждены письменно; допустим retarget пользователем локально |

## Решение для бета

1. Персонаж **выключен по умолчанию** (`character_enabled: false`).
2. 3D-движок не грузится, пока персонаж выключен.
3. В сборку **не** входят чужие бинарные `.vrm`/анимации до явного выбора владельцем CC0/разрешённого ассета.
4. В `Documents/Neyra/character/` при первом запуске копируется этот `LICENSES.md` и `README.txt` с инструкцией положить разрешённый `.vrm`.
5. Рекомендуемый default после получения файла: **β Ver AvatarSample_3 (CC0)**.

## Поведение (идеи, не код Desktop Mate)

Прозрачное always-on-top окно; click-through вне меша; idle; взгляд на курсор; посадка на край окна где есть геометрия ОС; drag; lip-sync по амплитуде TTS; состояния слушаю/думаю/говорю; исключение из Contour 4 screenshots.
