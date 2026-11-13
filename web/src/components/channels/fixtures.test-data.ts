// Synthetic fixtures for isolated UI tests and screenshots. Never used by the application.
export const guilds = [{id:'guild-1',name:'Северная станция',icon_url:null,description:'Общее пространство для разговоров и идей.',counts:{channels:4,members:3}}, {id:'guild-2',name:'Мастерская',icon_url:null,description:'Проекты, эксперименты и немного музыки.',counts:{channels:2,members:12}}];
export const members = [
 {guild_id:'guild-1',discord_id:'100000000000000001',person_id:'person-1',display_name:'Алексей',username:'alex',is_bot:false},
 {guild_id:'guild-1',discord_id:'100000000000000002',person_id:'person-2',display_name:'Мария',username:'maria',is_bot:false},
 {guild_id:'guild-1',discord_id:'100000000000000003',person_id:'person-3',display_name:'Нейра',username:'neyra',is_bot:true},
];
export const channels = [
 {id:'category-1',name:'Общее',type:'category',parent_id:null},
 {id:'channel-1',name:'разговоры',type:'text',parent_id:'category-1'},
 {id:'channel-2',name:'идеи',type:'text',parent_id:'category-1'},
 {id:'channel-3',name:'голосовая',type:'voice',parent_id:null},
];
export const detail={guild:guilds[0],members,channels,counts:{channels:4,members:3}};
export const messages=[
 {id:3,ts:'2026-11-13T14:46:00Z',role:'assistant',person_id:'person-1',display_name:'Нейра',discord_id:null,discord_username:'neyra',channel_id:'web:old-chat',text:'Давайте начнём с небольшого прототипа. Соберём идеи, выберем одну и проверим её на простом примере. Так станет понятнее, что делать дальше.'},
 {id:2,ts:'2026-11-13T14:45:00Z',role:'user',person_id:'person-1',display_name:'Алексей',discord_id:'100000000000000001',discord_username:'alex',channel_id:'web:old-chat',text:'Нейра, с чего лучше начать наш новый проект?'},
 {id:1,ts:'2026-11-13T14:44:00Z',role:'model_trace',person_id:'person-1',display_name:null,discord_id:null,discord_username:null,channel_id:'channel-1',text:'PRIVATE_MODEL_TRACE'},
];
export const stats={person_id:'person-1',messages:42,turns:18,first_contact:'2026-11-01T10:00:00Z',last_contact:'2026-11-13T14:45:00Z',channels:[{channel_id:'channel-1',guild_id:'guild-1',messages:26,turns:10},{channel_id:'web:old-chat',guild_id:null,messages:16,turns:8}],days:[{date:'2026-11-07',messages:3},{date:'2026-11-08',messages:8},{date:'2026-11-09',messages:2},{date:'2026-11-10',messages:6},{date:'2026-11-11',messages:4},{date:'2026-11-12',messages:10},{date:'2026-11-13',messages:9}],available:true};
