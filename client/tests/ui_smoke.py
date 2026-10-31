"""UI smoke with a simulated native IPC boundary; real WS contracts are pytest tests."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

INIT = r'''
const callbacks = new Map(), listeners = new Map(); let next = 1;
const profile = {id:'2eb0cd23-9508-44e1-b3ee-86ad429a5451',name:'Локальный стенд',url:'http://127.0.0.1:8787',session_id:'b3aef0b1-2ee1-4224-9888-1992bb964414'};
let settings = {schema_version:2,audit_days:30,device_id:'c1554031-4193-4cf8-bfde-e64b858ee332',device_name:'Тестовый ПК',profiles:[profile],permissions:{enabled:false,allow_web:true,web_domains:[],system:true,apps:[],shell:false,files:false,fs_roots:[],screen:false,screen_auto:false,input:false},theme:'dark',graphics_mode:'auto',character_enabled:false,voice:{mode:'ptt',vad_sensitivity:0.5,end_silence_ms:700,wake_threshold:0.5,barge_in:'off'}};
window.testCalls=[];let store=[];
window.emitNative=(name,payload)=>{for(const id of listeners.get(name)??[])callbacks.get(id)?.({event:name,id,payload});};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event,id)=>listeners.get(event)?.delete(id)};
window.__TAURI_INTERNALS__={transformCallback:(cb)=>{let id=next++;callbacks.set(id,cb);return id;},invoke:async(cmd,args={})=>{
window.testCalls.push({cmd,args});
if(cmd==='plugin:event|listen'){if(!listeners.has(args.event))listeners.set(args.event,new Set());listeners.get(args.event).add(args.handler);return args.handler;}
if(cmd==='plugin:event|unlisten')return;
if(cmd==='load_settings')return {settings,data_root:'/tmp/Neyra',recoveries:[{file:'settings/app.json',reason:'corrupt',quarantined:'app.json.corrupt-1',restored:'backup'}],screen_backend:true,input_backend:true};
if(cmd==='save_settings'){const p=args.settings.permissions;if(p.files&&!p.fs_roots.length)throw 'Сначала включите снимки экрана / добавьте папку';if(p.fs_roots.some(r=>r.includes('.ssh')))throw 'Эту папку нельзя разрешить';settings=args.settings;return;}
if(cmd==='api'){if(window.failApi)throw 'Сервер недоступен';if(args.path==='/openapi.json')return {info:{version:'1.1.0'}};if(args.path==='/v1/plugins')return {data:{plugins:[{id:'example',name:'Пример',enabled:false,lifecycle:'resident'}]}};return {data:{status:'ok',api_version:'1.1.0'}};}
if(cmd==='connect'){setTimeout(()=>window.emitNative('desktop-event',{type:'hello'}),10);return;}
if(cmd==='bridge_message'&&args.kind==='history'){window.emitNative('desktop-event',{type:'history',messages:[]});return;}
if(cmd==='bridge_message'&&args.kind==='devices'){window.emitNative('desktop-event',{type:'devices',devices:[{device_id:'pc2',name:'Ноутбук',tools:['client.open_url']}]});return;}
if(cmd==='chat'){if(args.text==='мой сайт')return {handled:true,command:'Мой сайт'};setTimeout(()=>{window.emitNative('desktop-event',{type:'token',text:'Привет'});window.emitNative('desktop-event',{type:'done',text:'Привет'});},20);return {handled:false};}
if(cmd==='stop'){window.emitNative('desktop-event',{type:'cancelled'});return;}
if(cmd==='applications')return ['/usr/bin/firefox','/usr/bin/steam'];
if(cmd==='update_state')return {settings:{schema_version:1,channel:'beta',auto_check:false},current_version:'0.1.0',endpoint:'https://example.invalid/latest.json',key_configured:true,install_kind:'appimage',pending_version:null};
if(cmd==='update_check')return {available:true,version:'0.1.1',notes:'Тест',date:null};
if(cmd==='character_state')return {enabled:false,settings:{schema_version:1,model:null,fps_limit:30,pause_fullscreen:true,pause_battery:true,always_on_top:true,click_through:true},capabilities:{transparent:'yes',always_on_top:'not_guaranteed',click_through:'yes',exclude_from_capture:'no',mechanism:'wayland-kde',notes:['Wayland не гарантирует always-on-top.']},models:[],overlay_open:false,renderer:'vrm',directory:'/tmp/Neyra/character'};
if(cmd==='audit_log')return [{time:Date.now(),tool:'client.open_url',status:'ok',confirmed:false}];
if(cmd==='voice_status')return {wake:{ready:false,dir:'/tmp/Neyra/wakeword',message:'Нет wakeword.json в папке wakeword'},live:false,dropped_frames:0};
if(cmd==='live_start'){if(settings.voice?.mode!=='wake')throw 'mode';setTimeout(()=>window.emitNative('desktop-event',{type:'live.started',mode:'wake'}),10);return;}
if(cmd==='live_stop'){window.emitNative('desktop-event',{type:'live.stopped'});return;}
const view=()=>({commands:store.map(c=>({file:c.file,command:c.command,hotkeys:[]})),errors:window.loadErrors??[],hotkeys_available:false,folder:'/tmp/Neyra/commands',max_commands:200});
if(cmd==='commands_list'){if(window.failCommands)throw 'Папка команд недоступна';return view();}
if(cmd==='command_save'){const file=args.file??('cmd-'+(store.length+1)+'.yaml');store=store.filter(c=>c.file!==file);store.push({file,command:args.command});return file;}
if(cmd==='command_get_yaml')return 'name: Из файла\ntriggers:\n  - phrase: из файла\nactions:\n  - tool: client.list_apps\n';
if(cmd==='command_save_yaml'){if(args.yaml.includes('BROKEN'))return {ok:false,error:{line:3,column:1,reason:'Нет обязательного поля «actions»'}};store.push({file:'yaml-1.yaml',command:{schema_version:1,name:'Из YAML',enabled:true,triggers:[{phrase:'из yaml'}],actions:[{tool:'client.list_apps',arguments:{}}],on_error:'stop',confirm:false,risk:'safe',speak:false}});return {ok:true,file:'yaml-1.yaml'};}
if(cmd==='command_delete'){store=store.filter(c=>c.file!==args.file);return;}
if(cmd==='command_set_enabled'){store=store.map(c=>c.file===args.file?{...c,command:{...c.command,enabled:args.enabled}}:c);return;}
if(cmd==='command_dry_run')return [{step:1,tool:'client.open_url',verdict:'confirm',message:'Потребуется карточка подтверждения'}];
if(cmd==='command_run'){setTimeout(()=>{window.emitNative('command-run',{run_id:'r',name:'Мой сайт',state:'started',total:1});window.emitNative('command-run',{run_id:'r',name:'Мой сайт',state:'step',step:1,total:1,tool:'client.open_url'});window.emitNative('command-run',{run_id:'r',name:'Мой сайт',state:'finished',reply:'Открываю'});},10);return;}
if(cmd==='command_run_phrase')return args.text==='привет'?{handled:false}:{handled:true,command:'Мой сайт'};
if(cmd==='draft_confirm'){store.push({file:'draft.yaml',command:{schema_version:1,name:'Режим игры',enabled:true,triggers:[{phrase:'режим игры'}],actions:[{tool:'client.open_app',arguments:{path:'/usr/bin/steam'}}],on_error:'stop',confirm:false,risk:'safe',speak:false}});return 'draft.yaml';}
if(cmd==='draft_reject')return;
if(cmd==='config_export')return {cancelled:false,commands:store.length,file:'neyra-config.json'};
if(cmd==='import_pick')return {cancelled:false,items:[{name:'Новая',status:'new',error:null},{name:'Мой сайт',status:'conflict',error:null},{name:'Плохая',status:'invalid',error:'Инструмент «client.shell_exec» недоступен'}],settings:{theme:'light',graphics_mode:'auto',audit_days:30},permissions:{allow_web:true,system:true,web_domains:['example.com'],apps:['/usr/bin/firefox']}};
if(cmd==='import_apply'){window.importArgs=args;return {report:{added:1,replaced:0,renamed:1,skipped:0},settings};}
if(cmd==='import_cancel')return;
if(cmd==='choose_data_root')return window.forceDataChoice?{cancelled:false,needs_choice:true,path:'/data/Neyra'}:{cancelled:false,path:'/data/Neyra',restart_required:true};
if(cmd==='confirm_data_root'){window.dataChoice=args.choice;return {cancelled:args.choice==='cancel',path:'/data/Neyra',restart_required:args.choice!=='cancel'};}
return;
}};
'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':1100,'height':820})
    errors=[]
    page.on('dialog', lambda d: d.accept())
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(INIT)
    page.goto('http://127.0.0.1:1420')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading',name='Сервер',exact=True)).to_be_visible()
    page.get_by_role('button',name='Настройки',exact=True).click()
    expect(page.get_by_text('Персонаж выключен. Включите его в настройках выше и сохраните.')).to_be_visible()
    expect(page.get_by_text('Wayland не гарантирует always-on-top.')).to_be_visible()
    page.get_by_role('button',name='Проверить обновления').click()
    expect(page.get_by_text('Доступна версия 0.1.1.')).to_be_visible()
    page.get_by_role('button',name='Сервер',exact=True).click()
    page.get_by_role('button',name='Проверить подключение').click()
    expect(page.get_by_text('Сервер доступен · API 1.1.0')).to_be_visible()
    page.evaluate('window.failApi=true')
    page.get_by_role('button',name='Проверить подключение').click()
    expect(page.get_by_role('alert')).to_contain_text('Сервер недоступен')
    page.evaluate('window.failApi=false')
    page.get_by_role('button',name='Подключить',exact=True).click()
    page.get_by_label('Сообщение',exact=True).fill('Привет, Нейра')
    page.get_by_role('button',name='Отправить',exact=True).click()
    expect(page.locator('article').last).to_contain_text('Привет')
    page.get_by_label('ПК для действий').select_option('pc2')
    page.get_by_role('button',name='Голос',exact=True).click()
    expect(page.get_by_role('button',name='Начать разговор')).to_be_disabled()
    page.get_by_label('Как начинать разговор').select_option('wake')
    page.get_by_role('button',name='Проверить модель').click()
    expect(page.get_by_text('Модель не готова: Нет wakeword.json')).to_be_visible()
    expect(page.get_by_text('Эхоподавления нет')).to_be_visible()
    page.get_by_role('button',name='Начать разговор').click()
    expect(page.locator('.live-state')).to_have_text('Жду слово «Нейра»')
    page.evaluate("window.emitNative('desktop-event',{type:'wake'})")
    expect(page.locator('.live-state')).to_have_text('Слушаю команду')
    page.evaluate("window.emitNative('desktop-event',{type:'voice.conversion',status:'passthrough',code:'timeout'})")
    expect(page.get_by_text('звучит исходный голос TTS')).to_be_visible()
    page.get_by_role('button',name='Пауза микрофона').click()
    expect(page.locator('.live-state')).to_have_text('Микрофон выключен')
    assert any(c['cmd']=='save_settings' and c['args']['settings'].get('voice',{}).get('mode')=='wake' for c in page.evaluate('window.testCalls'))
    page.get_by_role('button',name='Доступ к ПК',exact=True).click()
    page.get_by_label('Разрешить Нейре управлять этим ПК').check()
    page.get_by_role('button',name='Найти установленные приложения').click()
    expect(page.get_by_label('/usr/bin/firefox',exact=True)).to_be_visible()
    page.get_by_label('/usr/bin/firefox',exact=True).check()
    page.get_by_role('button',name='Обновить журнал').click()
    expect(page.locator('ol')).to_contain_text('client.open_url')
    page.evaluate("window.emitNative('host-confirm',{call_id:'call',tool:'client.open_app',arguments:{path:'/opt/Unknown App'},deadline_ms:Date.now()+30000})")
    expect(page.get_by_role('dialog')).to_be_visible()
    expect(page.get_by_role('button',name='Отклонить',exact=True)).to_be_focused()
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.on('dialog', lambda d: d.accept())
    page.get_by_label('Консоль (PowerShell, cmd, bash): каждая команда с подтверждением').check()
    expect(page.get_by_label('Консоль (PowerShell, cmd, bash): каждая команда с подтверждением')).to_be_checked()
    expect(page.get_by_label('Файлы в разрешённых папках', exact=False)).to_be_disabled()
    page.get_by_label('Новая разрешённая папка').fill('relative/path')
    page.get_by_role('button', name='Добавить папку').click()
    expect(page.get_by_role('alert')).to_contain_text('полный путь')
    page.get_by_label('Новая разрешённая папка').fill('/home/me/.ssh')
    page.get_by_role('button', name='Добавить папку').click()
    expect(page.get_by_role('alert')).to_contain_text('нельзя разрешить')
    page.get_by_label('Новая разрешённая папка').fill('/home/me/Documents')
    page.get_by_role('button', name='Добавить папку').click()
    expect(page.locator('ul.roots')).to_contain_text('/home/me/Documents')
    page.get_by_label('Файлы в разрешённых папках', exact=False).check()
    expect(page.get_by_label('Снимки без подтверждения')).to_be_disabled()
    page.get_by_label('Снимки экрана', exact=False).first.check()
    page.get_by_label('Мышь и клавиатура', exact=False).first.check()
    perms = page.evaluate('window.testCalls.filter(c=>c.cmd==="save_settings").at(-1).args.settings.permissions')
    assert perms['shell'] and perms['files'] and perms['screen'] and perms['input'] and not perms['screen_auto'], perms
    page.evaluate("window.emitNative('host-confirm',{call_id:'call-shell',tool:'client.shell_exec',arguments:{program:'git'},deadline_ms:Date.now()+30000,preview:'Команда: /usr/bin/git status\\nПапка: /home/me/Documents\\nТаймаут: 30 с'})")
    expect(page.get_by_role('dialog')).to_contain_text('Выполнить команду')
    expect(page.get_by_role('dialog')).to_contain_text('/usr/bin/git status')
    page.get_by_role('button', name='Отклонить', exact=True).click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    assert page.evaluate('window.testCalls.some(c=>c.cmd==="approve"&&c.args.callId==="call-shell"&&c.args.allow===false)')
    page.evaluate("window.emitNative('host-confirm',{call_id:'call-cancel',tool:'client.open_app',arguments:{path:'/opt/Other'},deadline_ms:Date.now()+30000})")
    expect(page.get_by_role('dialog')).to_be_visible()
    page.evaluate("window.emitNative('host-confirm-closed',{call_id:'call-cancel'})")
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.get_by_role('button',name='Stop',exact=True).click()
    # --- quick commands ---
    page.get_by_role('button',name='Команды',exact=True).click()
    expect(page.get_by_text('Команд пока нет')).to_be_visible()
    page.evaluate('window.failCommands=true')
    page.get_by_role('button',name='Обновить',exact=True).click()
    expect(page.get_by_role('alert').first).to_contain_text('Папка команд недоступна')
    page.evaluate('window.failCommands=false')
    page.get_by_role('button',name='Повторить').click()
    expect(page.get_by_text('Команд пока нет')).to_be_visible()
    page.get_by_role('button',name='Создать команду').click()
    expect(page.get_by_role('dialog',name='Новая команда')).to_be_visible()
    expect(page.get_by_role('button',name='Сохранить',exact=True)).to_be_disabled()
    page.get_by_label('Название',exact=True).fill('Мой сайт')
    page.get_by_label('Значение',exact=True).fill('мой сайт')
    page.get_by_label('Ссылка',exact=True).fill('https://example.com')
    page.get_by_role('button',name='Добавить шаг').click()
    page.get_by_label('Действие').nth(1).select_option('client.close_window')
    expect(page.get_by_label('Уровень риска')).to_be_disabled()
    page.get_by_role('button',name='Убрать шаг').nth(1).click()
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog',name='Новая команда')).not_to_be_visible()
    page.get_by_role('button',name='Создать команду').click()
    page.get_by_label('Название',exact=True).fill('Мой сайт')
    page.get_by_label('Значение',exact=True).fill('мой сайт')
    page.get_by_label('Ссылка',exact=True).fill('https://example.com')
    page.get_by_role('button',name='Сохранить',exact=True).click()
    expect(page.get_by_role('heading',name='Мой сайт')).to_be_visible()
    expect(page.get_by_text('Фраза: мой сайт')).to_be_visible()
    page.get_by_role('button',name='Проверить',exact=True).click()
    expect(page.get_by_label('Проверка команды Мой сайт')).to_contain_text('С подтверждением')
    page.get_by_role('button',name='Запустить',exact=True).click()
    expect(page.locator('.runline')).to_contain_text('готово · Открываю')
    page.get_by_label('Включена').uncheck()
    expect(page.get_by_role('button',name='Запустить',exact=True)).to_be_disabled()
    page.get_by_label('Включена').check()
    page.get_by_label('Проверить фразу без сервера').fill('привет')
    page.get_by_role('button',name='Выполнить фразу').click()
    expect(page.get_by_text('Такой команды нет')).to_be_visible()
    page.get_by_role('button',name='YAML',exact=True).first.click()
    page.get_by_label('Файл команды (YAML)').fill('name: x\nBROKEN')
    page.get_by_role('button',name='Сохранить',exact=True).click()
    expect(page.get_by_role('alert').last).to_contain_text('Строка 3, столбец 1: Нет обязательного поля «actions»')
    page.get_by_role('button',name='Отмена',exact=True).click()
    page.evaluate("window.emitNative('commands-changed',{commands:[],errors:[{file:'broken.yaml',line:4,column:2,reason:'Ошибка YAML',kept_previous:true}],hotkeys_available:true,folder:'/tmp/Neyra/commands',max_commands:200})")
    expect(page.get_by_text('broken.yaml, строка 4, столбец 2')).to_be_visible()
    expect(page.get_by_text('работает последняя рабочая версия')).to_be_visible()
    page.evaluate("window.emitNative('command-draft',{draft_id:'d1',exists:false,command:{schema_version:1,name:'Режим игры',enabled:true,triggers:[{phrase:'режим игры'}],actions:[{tool:'client.open_app',arguments:{path:'/usr/bin/steam'}}],on_error:'stop',confirm:false,risk:'safe',speak:false}})")
    expect(page.get_by_role('dialog',name='Сохранить команду на этом ПК?')).to_be_visible()
    expect(page.get_by_role('button',name='Отклонить',exact=True)).to_be_focused()
    page.get_by_role('button',name='Сохранить',exact=True).click()
    expect(page.get_by_role('dialog',name='Сохранить команду на этом ПК?')).not_to_be_visible()
    page.evaluate("window.emitNative('command-draft',{draft_id:'d2',exists:true,command:{schema_version:1,name:'Режим игры',enabled:true,triggers:[{phrase:'режим игры'}],actions:[{tool:'client.list_apps',arguments:{}}],on_error:'stop',confirm:false,risk:'safe',speak:false}})")
    expect(page.get_by_role('button',name='Сохранить',exact=True)).to_be_disabled()
    page.keyboard.press('Escape')
    page.evaluate("window.emitNative('command-run',{name:'Мой сайт',state:'failed',message:'Шаг 1 из 1: Доступ к ПК выключен'})")
    expect(page.get_by_role('alert').first).to_contain_text('Доступ к ПК выключен')
    page.get_by_role('button',name='Чат',exact=True).click()
    page.get_by_label('Сообщение',exact=True).fill('мой сайт')
    page.get_by_role('button',name='Отправить',exact=True).click()
    expect(page.locator('article').last).to_contain_text('Команда «Мой сайт» запущена на этом ПК.')
    # --- settings: recovery, export, import ---
    page.get_by_role('button',name='Настройки',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('восстановлена последняя рабочая копия')
    page.get_by_role('button',name='Экспортировать…').click()
    expect(page.get_by_text('Токены и журнал не включены')).to_be_visible()
    page.get_by_role('button',name='Импортировать…').click()
    expect(page.get_by_role('group',name='Предпросмотр импорта')).to_contain_text('Конфликт имён')
    expect(page.get_by_role('group',name='Предпросмотр импорта')).to_contain_text('client.shell_exec')
    page.get_by_label('Применить разрешения из файла (главный выключатель не включится)').check()
    expect(page.get_by_role('group',name='Предпросмотр импорта')).to_contain_text('example.com')
    expect(page.get_by_role('group',name='Предпросмотр импорта')).to_contain_text('/usr/bin/firefox')
    page.get_by_role('button',name='Применить импорт').click()
    expect(page.get_by_text('Импорт завершён: новых 1, заменено 0, переименовано 1, пропущено 0.')).to_be_visible()
    assert page.evaluate('window.importArgs.conflict')=='rename' and page.evaluate('window.importArgs.includePermissions') is True
    page.evaluate('window.forceDataChoice=true')
    page.get_by_role('button',name='Сменить папку данных…').click()
    expect(page.get_by_role('dialog',name='В папке уже есть данные Neyra')).to_be_visible()
    expect(page.get_by_role('button',name='Отмена',exact=True)).to_be_focused()
    page.keyboard.press('Escape')
    assert page.evaluate('window.dataChoice')=='cancel'
    expect(page.get_by_role('dialog',name='В папке уже есть данные Neyra')).not_to_be_visible()
    page.get_by_role('button',name='Сменить папку данных…').click()
    page.get_by_role('button',name='Использовать эти данные').click()
    assert page.evaluate('window.dataChoice')=='use_existing'
    expect(page.get_by_role('dialog',name='В папке уже есть данные Neyra')).not_to_be_visible()
    page.evaluate('window.forceDataChoice=false')
    page.get_by_role('button',name='Сменить папку данных…').click()
    page.get_by_label('Тема').select_option('light')
    page.screenshot(path='/tmp/neyra-desktop-light.png',full_page=True)
    page.get_by_role('button',name='Команды',exact=True).click()
    page.set_viewport_size({'width':620,'height':760})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
    page.screenshot(path='/tmp/neyra-desktop-narrow.png',full_page=True)
    page.get_by_role('button',name='Настройки',exact=True).click()
    page.get_by_label('Тема').select_option('dark')
    page.screenshot(path='/tmp/neyra-desktop-dark.png',full_page=True)
    assert not errors,errors
    browser.close()
print('PASS: profiles, API failure, chat, device selector, voice tab (wake mode, model status, live start/pause, conversion notice), local permissions, Contour 3-4 toggles/roots/preview card, confirmation/Escape/host-confirm-closed, Stop, audit, quick commands (empty/error/create/edit/YAML error/run/draft/local text), settings recovery/export/import, dark/light/narrow. Native boundary simulated.')
