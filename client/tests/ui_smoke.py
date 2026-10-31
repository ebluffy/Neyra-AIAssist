"""UI smoke with a simulated native IPC boundary; real WS contracts are pytest tests."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

INIT = r'''
const callbacks = new Map(), listeners = new Map(); let next = 1;
const profile = {id:'2eb0cd23-9508-44e1-b3ee-86ad429a5451',name:'Локальный стенд',url:'http://127.0.0.1:8787',session_id:'b3aef0b1-2ee1-4224-9888-1992bb964414'};
let settings = {schema_version:1,device_id:'c1554031-4193-4cf8-bfde-e64b858ee332',device_name:'Тестовый ПК',profiles:[profile],permissions:{enabled:false,allow_web:true,web_domains:[],system:true,apps:[]},theme:'dark',graphics_mode:'auto',character_enabled:false};
window.testCalls=[];
window.emitNative=(name,payload)=>{for(const id of listeners.get(name)??[])callbacks.get(id)?.({event:name,id,payload});};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event,id)=>listeners.get(event)?.delete(id)};
window.__TAURI_INTERNALS__={transformCallback:(cb)=>{let id=next++;callbacks.set(id,cb);return id;},invoke:async(cmd,args={})=>{
window.testCalls.push({cmd,args});
if(cmd==='plugin:event|listen'){if(!listeners.has(args.event))listeners.set(args.event,new Set());listeners.get(args.event).add(args.handler);return args.handler;}
if(cmd==='plugin:event|unlisten')return;
if(cmd==='load_settings')return {settings,data_root:'/tmp/Neyra'};
if(cmd==='save_settings'){settings=args.settings;return;}
if(cmd==='api'){if(window.failApi)throw 'Сервер недоступен';if(args.path==='/openapi.json')return {info:{version:'1.1.0'}};if(args.path==='/v1/plugins')return {data:{plugins:[{id:'example',name:'Пример',enabled:false,lifecycle:'resident'}]}};return {data:{status:'ok',api_version:'1.1.0'}};}
if(cmd==='connect'){setTimeout(()=>window.emitNative('desktop-event',{type:'hello'}),10);return;}
if(cmd==='bridge_message'&&args.kind==='history'){window.emitNative('desktop-event',{type:'history',messages:[]});return;}
if(cmd==='bridge_message'&&args.kind==='devices'){window.emitNative('desktop-event',{type:'devices',devices:[{device_id:'pc2',name:'Ноутбук',tools:['client.open_url']}]});return;}
if(cmd==='chat'){setTimeout(()=>{window.emitNative('desktop-event',{type:'token',text:'Привет'});window.emitNative('desktop-event',{type:'done',text:'Привет'});},20);return;}
if(cmd==='stop'){window.emitNative('desktop-event',{type:'cancelled'});return;}
if(cmd==='applications')return ['/usr/bin/firefox','/usr/bin/steam'];
if(cmd==='audit_log')return [{time:Date.now(),tool:'client.open_url',status:'ok',confirmed:false}];
return;
}};
'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':1100,'height':820})
    errors=[]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(INIT)
    page.goto('http://127.0.0.1:1420')
    page.wait_for_load_state('networkidle')
    expect(page.get_by_role('heading',name='Сервер',exact=True)).to_be_visible()
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
    page.evaluate("window.emitNative('host-confirm',{call_id:'call-cancel',tool:'client.open_app',arguments:{path:'/opt/Other'},deadline_ms:Date.now()+30000})")
    expect(page.get_by_role('dialog')).to_be_visible()
    page.evaluate("window.emitNative('host-confirm-closed',{call_id:'call-cancel'})")
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.get_by_role('button',name='Stop',exact=True).click()
    page.get_by_role('button',name='Сервер',exact=True).click()
    page.get_by_label('Тема').select_option('light')
    page.screenshot(path='/tmp/neyra-desktop-light.png',full_page=True)
    page.set_viewport_size({'width':620,'height':760})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
    page.screenshot(path='/tmp/neyra-desktop-narrow.png',full_page=True)
    page.get_by_label('Тема').select_option('dark')
    page.screenshot(path='/tmp/neyra-desktop-dark.png',full_page=True)
    assert not errors,errors
    browser.close()
print('PASS: profiles, API failure, chat, device selector, local permissions, confirmation/Escape/host-confirm-closed, Stop, audit, dark/light/narrow. Native boundary simulated.')
