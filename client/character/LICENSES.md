# Character assets — license research (§3b.6 step 0)

Research date: 2026-10-31. Code of Desktop Mate is **not** copied. Behaviour notes only (transparent overlay, always-on-top, click-through except avatar, idle, cursor look, sit-on-window where OS allows, lip-sync with TTS).

## Desktop Mate (Steam app 3301060, Infiniteloop)

| Ассет | Источник | Автор | Лицензия | Можно ли распространять в Neyra |
|---|---|---|---|---|
| Модели / анимации / контент приложения | Steam EULA / ToS Desktop Mate | Infiniteloop Co., Ltd. (+ IP holders для DLC) | Контент только в рамках App; запрещены reproduction / secondary use / redistribution / reverse engineering beyond ToS | **Нет** |
| Официальные DLC-персонажи | Paid content terms | Rights holders + Infiniteloop | Лицензия только покупателю; отдельные условия правообладателя | **Нет** |
| Идеи поведения / UX | Публичные описания + community notes (без копирования кода) | — | Идеи не копируют ассеты | Да (только идеи) |

Вывод: **ассеты Desktop Mate в репозиторий и сборку не кладём.** Окно персонажа — собственная реализация.

Источники (проверено 2026-10-31):
- https://store.steampowered.com/eula/3301060_eula_0
- https://store.steampowered.com/app/3301060/Desktop_Mate/
- https://steamcommunity.com/app/3301060/discussions/0/783166243925445755/ (VRM/MOD policy)

## Кандидаты на модель по умолчанию (не Desktop Mate)

| Ассет | Источник + URL условий | Автор | Лицензия | Можно ли распространять |
|---|---|---|---|---|
| β Ver AvatarSample_3 (и 1/2/4) | VRoid FAQ CC0 samples — https://vroid.pixiv.help/hc/en-us/articles/4402614652569-Do-VRoid-Studio-s-sample-models-come-with-conditions-of-use · AvatarSample_3 — https://vroid.pixiv.help/hc/ja/articles/360014900113 (проверено 2026-10-31) | pixiv / VRoid | **CC0** (+ ToS Studio/Hub при экспорте) | **Да**, при CC0 + ToS экспорта. Файл **не** вшит: владелец экспортирует VRM в `Documents/Neyra/character/` |
| AvatarSample_A/B/C | VRoid preset conditions — https://vroid.pixiv.help/hc/en-us/articles/4402394424089 (проверено 2026-10-31) | pixiv / VRoid | Отдельные conditions of use (не CC0) | Только если conditions явно разрешают redistribution в стороннем приложении |
| Пользовательский `.vrm` | VRoid Hub license flags — https://hub.vroid.com/en/license · Hub/VRM FAQ — https://vroid.pixiv.help/hc/en-us/articles/360016417013 (проверено 2026-10-31) | Автор модели | Embedded VRM + Hub Redistribution/Alteration/Avatar use | Только Redistribution=Allow **и** подтверждение пользователя; иначе локально без бандла |
| Mixamo animations | Adobe Mixamo FAQ/terms — https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html · Adobe General Terms https://www.adobe.com/legal/terms.html (проверено 2026-10-31; сверить актуальный redistrib перед бандлом) | Adobe | Mixamo / Adobe terms (account required) | Не бандлить, пока redistribution для embedding в приложение не подтверждён; локальный retarget пользователем допустим |

## Решение для бета

1. Персонаж **выключен по умолчанию** (`character_enabled: false` в `settings/app.json`).
2. 3D-движок не грузится, пока персонаж выключен.
3. В сборку **не** входят чужие бинарные `.vrm`/анимации до явного выбора владельцем CC0/разрешённого ассета.
4. В `Documents/Neyra/character/` при первом запуске копируется этот `LICENSES.md` и `README.txt` с инструкцией положить разрешённый `.vrm`.
5. Рекомендуемый default после получения файла: **β Ver AvatarSample_3 (CC0)**.

## Поведение (идеи, не код Desktop Mate)

Прозрачное always-on-top окно; click-through вне меша; idle; взгляд на курсор; посадка на край окна где есть геометрия ОС; drag; lip-sync по амплитуде TTS; состояния слушаю/думаю/говорю; исключение из Contour 4 screenshots.
