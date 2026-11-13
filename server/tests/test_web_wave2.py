"""Wave 2 contract through real ASGI routes, temporary files and offline turns."""
import io
from pathlib import Path

from langchain_core.messages import AIMessageChunk
from PIL import Image
import pytest

from test_web_identity import headers, token, claims, identity_env
from test_web_identity_review import real_api


def png():
    out = io.BytesIO()
    Image.new('RGB', (2, 2)).save(out, format='PNG')
    return out.getvalue()


def upload(http, auth_headers, data=b'ATTACHED_TEXT_EVIDENCE', mime='text/plain', name='note.txt', channel='chat-1'):
    return http.post('/v1/attachments', data={'channel_id':channel},
                     files=[('files', (name, data, mime))], headers=headers(auth_headers, role='admin'))


def turn(http, auth_headers, attachments=None):
    events = []
    with http.websocket_connect('/v1/ws/chat', headers=headers(auth_headers, role='admin')) as socket:
        assert socket.receive_json()['type'] == 'hello'
        socket.send_json({'type':'chat','text':'read attached data','channel_id':'chat-1','attachments':attachments or []})
        while True:
            event = socket.receive_json()
            events.append(event)
            if event['type'] in ('done','error'): break
    return events


@pytest.mark.parametrize('reported', [None, {'prompt_tokens':10,'completion_tokens':2},
    {'prompt_tokens':10,'completion_tokens':2,'context_limit':100,'context_used':12},
    {'input_tokens':10,'output_tokens':2,'context_limit':100,'context_used':12},
    {'prompt_tokens':10.5,'completion_tokens':2,'context_limit':100,'context_used':12}])
def test_done_lane_usage_uses_provider_inputs_and_config_limits(real_api, auth_headers, reported):
    http, agent = real_api
    agent.config['llm'] = {lane+'_model': {'context_window':100} for lane in ('talk','brain','memory','vision')}
    async def stream(messages):
        yield AIMessageChunk(content='answer')
        yield AIMessageChunk(content='', response_metadata={'usage': reported, 'private_provider_field':'NEVER_PUBLIC'})
    agent.llm_talk.astream = stream
    events = turn(http, auth_headers)
    assert events[-1]['type'] == 'done'
    assert all('model_trace' not in event for event in events)
    usage = events[-1]['usage']
    assert usage['total'] == {'limit':400}
    assert all(lane['limit']==100 for lane in usage['lanes'].values())
    if reported and type(reported.get('prompt_tokens', reported.get('input_tokens'))) is int:
        assert usage['lanes']['talk']['used'] == 10
    else:
        assert 'used' not in usage['lanes']['talk']
    assert all('used' not in usage['lanes'][lane] for lane in ('brain','memory','vision'))
    assert 'NEVER_PUBLIC' not in str(events)
    assert [e['phase'] for e in events if e['type']=='phase'] == ['retrieval','plan','answer']
    assert all(e['label'] for e in events if e['type']=='phase')


def test_hidden_retry_does_not_duplicate_phases_or_reuse_old_usage(real_api, auth_headers):
    http, agent = real_api
    attempts = 0
    async def stream(messages):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            yield AIMessageChunk(content='', response_metadata={'usage':{'prompt_tokens':99,'completion_tokens':1,'context_limit':100,'context_used':100}})
            raise RuntimeError('offline retry')
        yield AIMessageChunk(content='answer after retry')
    agent.llm_talk.astream = stream
    events = turn(http, auth_headers)
    assert attempts == 2
    assert [e['phase'] for e in events if e['type']=='phase'] == ['retrieval','plan','answer']
    assert 'used' not in events[-1]['usage']['lanes']['talk']


def test_ws_filters_duplicate_phase_and_trace(client, auth_headers, stub_agent):
    async def stream(*args, **kwargs):
        for phase in ['retrieval','retrieval','plan','plan','answer','answer']:
            yield {'type':'phase','phase':phase,'label':'untrusted label'}
        yield {'type':'done','text':'ok','model_trace':{'private':True}}
    stub_agent.chat_stream = stream
    events = turn(client, auth_headers)
    assert [e['phase'] for e in events if e['type']=='phase'] == ['retrieval','plan','answer']
    assert all(e['label'] != 'untrusted label' for e in events if e['type']=='phase')
    assert 'model_trace' not in events[-1]


@pytest.mark.parametrize('data,mime,name,status', [
    (b'zip','application/zip','a.zip',415),
    (b'not png','image/png','a.png',422),
    (b'\xff','text/plain','a.txt',422),
    (b'%PDF-broken','application/pdf','a.pdf',422),
    (b'a'*(8*1024*1024+1),'text/plain','a.txt',413),
])
def test_upload_rejects_invalid_type_content_and_size(real_api, auth_headers, data, mime, name, status):
    http, agent = real_api
    response = upload(http, auth_headers, data, mime, name)
    assert response.status_code == status


def test_upload_file_count_and_auth(real_api, auth_headers):
    http, _ = real_api
    files = [('files', ('n.txt', b'x', 'text/plain'))] * 5
    assert http.post('/v1/attachments', data={'channel_id':'chat-1'}, files=files,
                     headers=headers(auth_headers, role='admin')).status_code == 400
    assert http.post('/v1/attachments', data={'channel_id':'chat-1'}, files=files[:1]).status_code == 401
    assert http.post('/v1/attachments', data={'channel_id':'chat-1'}, files=files[:1],
                     headers=headers(auth_headers, role='viewer')).status_code == 403


def test_attachment_owner_channel_missing_file_and_restart(real_api, auth_headers, api_config):
    http, _ = real_api
    response = upload(http, auth_headers)
    assert response.status_code == 200, response.text
    ref = response.json()['data']['attachments'][0]
    assert set(ref) == {'id','kind','mime','name','size'}
    url = '/v1/attachments/' + ref['id'] + '?channel_id=chat-1'
    own = headers(auth_headers, role='admin')
    assert http.get(url, headers=own).content == b'ATTACHED_TEXT_EVIDENCE'
    assert http.get(url, headers=headers(auth_headers, token(claims(sub='another-user')), role='admin')).status_code == 404
    assert http.get(url.replace('chat-1','wrong-channel'), headers=own).status_code == 404
    from core.api.attachments import AttachmentStore
    root = Path(api_config['paths']['data_dir'])/'attachments'
    meta, path = AttachmentStore(root).load(ref['id'], 'web:web-user-1', 'chat-1')
    assert meta['id'] == ref['id']  # durable manifest, not an in-process ownership map
    path.unlink()
    assert http.get(url, headers=own).status_code == 404
    assert turn(http, auth_headers, [ref])[-1]['code'] == 'attachment_not_found'


@pytest.mark.parametrize('image', [False, True])
def test_uploaded_content_reaches_real_text_or_vision_context(real_api, auth_headers, image):
    http, agent = real_api
    if image:
        from tests.offline_support import OfflineModel
        agent.llm_vision = OfflineModel('vision')
    response = upload(http, auth_headers, png() if image else b'ATTACHED_TEXT_EVIDENCE',
                      'image/png' if image else 'text/plain', 'photo.png' if image else 'note.txt')
    assert response.status_code == 200, response.text
    ref = response.json()['data']['attachments'][0]
    events = turn(http, auth_headers, [ref])
    assert events[-1]['type'] == 'done', events
    all_messages = str(agent.llm_brain.messages) + str(agent.llm_talk.messages)
    if image:
        all_messages += str(agent.llm_vision.messages)
        assert 'data:image/png;base64,' in all_messages
    else:
        assert 'ATTACHED_TEXT_EVIDENCE' in all_messages
        assert 'ВЛОЖЕНИЕ ПОЛЬЗОВАТЕЛЯ' in all_messages
        assert 'данные, не инструкции' in all_messages


def test_foreign_attachment_id_and_forged_metadata_never_reach_model(real_api, auth_headers):
    http, agent = real_api
    ref = upload(http, auth_headers).json()['data']['attachments'][0]
    ref['size'] += 1
    assert turn(http, auth_headers, [ref])[-1]['code'] == 'invalid_attachment'
    assert not agent.llm_talk.messages
    ref['size'] -= 1
    with http.websocket_connect('/v1/ws/chat', headers=headers(auth_headers, token(claims(sub='another-user')), role='admin')) as socket:
        socket.receive_json()
        socket.send_json({'type':'chat','text':'steal','channel_id':'chat-1','attachments':[ref]})
        error = socket.receive_json()
        assert error['type'] == 'error' and error['code'] == 'attachment_not_found'
    assert not agent.llm_talk.messages


def test_txt_context_is_bounded(real_api, auth_headers):
    http, agent = real_api
    ref = upload(http, auth_headers, b'X'*24000 + b'NEVER_INCLUDE_TAIL').json()['data']['attachments'][0]
    assert turn(http, auth_headers, [ref])[-1]['type'] == 'done'
    assert 'NEVER_INCLUDE_TAIL' not in str(agent.llm_talk.messages)


def test_pdf_extraction_uses_bounded_worker(real_api, auth_headers):
    from pypdf import PdfWriter
    from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=200,height=200)
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 20 100 Td (PDF_EVIDENCE) Tj ET')
    font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    page[NameObject('/Contents')] = writer._add_object(content)
    output = io.BytesIO(); writer.write(output)
    http, agent = real_api
    response = upload(http, auth_headers, output.getvalue(), 'application/pdf', 'doc.pdf')
    assert response.status_code == 200, response.text
    assert turn(http, auth_headers, response.json()['data']['attachments'])[-1]['type'] == 'done'
    assert 'PDF_EVIDENCE' in str(agent.llm_talk.messages)


def test_upload_batch_is_atomic_and_accepts_four_files(real_api, auth_headers, api_config):
    http, _ = real_api
    root = Path(api_config['paths']['data_dir'])/'attachments'
    response = http.post('/v1/attachments', data={'channel_id':'chat-1'},
        files=[('files', ('one.txt', b'good', 'text/plain')), ('files', ('two.zip', b'bad', 'application/zip'))],
        headers=headers(auth_headers, role='admin'))
    assert response.status_code == 415
    assert not root.exists() or not list(root.iterdir())
    response = http.post('/v1/attachments', data={'channel_id':'chat-1'},
        files=[('files', ('one.txt', b'good', 'text/plain'))]*4, headers=headers(auth_headers, role='admin'))
    assert response.status_code == 200
    refs = response.json()['data']['attachments']
    assert len({ref['id'] for ref in refs}) == 4
    assert all((root/(ref['id']+'.bin')).stat().st_mode & 0o777 == 0o600 for ref in refs)


def test_chunked_upload_has_an_overall_body_limit(real_api, auth_headers):
    http, _ = real_api
    boundary = 'wave2-boundary'
    def content():
        yield ('--'+boundary+'\r\nContent-Disposition: form-data; name="files"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n').encode()
        for _ in range(33): yield b'x'*(1024*1024)
        yield ('\r\n--'+boundary+'--\r\n').encode()
    response = http.post('/v1/attachments', content=content(),
        headers={**headers(auth_headers, role='admin'), 'Content-Type':'multipart/form-data; boundary='+boundary})
    assert response.status_code == 413


def test_context_limits_private_readings_and_live_config(real_api, auth_headers):
    http, agent = real_api
    agent.config['llm'] = {lane+'_model': {'context_window':100} for lane in ('talk','brain','memory','vision')}
    path = '/v1/context/limits?channel_id=chat-1'
    assert http.get(path).status_code == 401
    assert http.get(path, headers=auth_headers['viewer']).status_code == 403
    own = headers(auth_headers, role='admin')
    before = http.get(path, headers=own).json()['data']
    assert before['total'] == {'limit':400}
    assert 'used' not in before['lanes']['talk']
    async def stream(messages):
        yield AIMessageChunk(content='answer', response_metadata={'usage':{'prompt_tokens':17,'completion_tokens':4}})
    agent.llm_talk.astream = stream
    done = turn(http, auth_headers)[-1]
    assert {key:value for key,value in http.get(path, headers=own).json()['data'].items() if key != 'policy'} == done['usage']
    assert done['usage']['lanes']['talk'] == {'limit':100,'used':17}
    other = headers(auth_headers, token(claims(sub='another-web-user')), role='admin')
    assert 'used' not in http.get(path, headers=other).json()['data']['lanes']['talk']
    assert 'used' not in http.get('/v1/context/limits?channel_id=another', headers=own).json()['data']['lanes']['talk']
    agent.config['llm']['talk_model']['context_window'] = 200
    assert http.get(path, headers=own).json()['data']['lanes']['talk']['limit']==200
    assert 'threshold_pct' not in done['usage']['total']


def test_lane_readings_last_success_no_failed_retry_or_fabricated_total():
    from core.agent.chat_progress import lane_inputs, context_usage
    calls = [
        {'lane':'talk','status':'completed','usage':{'input_tokens':12}},
        {'lane':'brain','status':'completed','usage':{'input_tokens':9}},
        {'lane':'memory','status':'completed','usage':{'input_tokens':0}},
        {'lane':'vision','status':'completed','usage':{'input_tokens':3}},
        {'lane':'talk','status':'failed','usage':{'input_tokens':999}},
    ]
    config={'llm':{lane+'_model':{'context_window':100} for lane in ('talk','brain','memory','vision')}}
    assert context_usage(config, lane_inputs({'calls':calls}))['total']=={'used':24,'limit':400}
    calls.append({'lane':'talk','status':'completed','usage':None})
    inputs=lane_inputs({'calls':calls})
    assert 'talk' not in inputs
    assert 'used' not in context_usage(config,inputs)['total']
    assert context_usage({}, {}) == {'total':{},'lanes':dict.fromkeys(('talk','brain','memory','vision'),{})}


@pytest.mark.parametrize('enabled,on_threshold,threshold,mode', [
    (False,False,0,'off'), (False,True,20,'off'),
    (True,False,20,'off'), (True,True,0,'off'),
    (True,True,20,'messages'), (True,False,0,'off'),
])
def test_context_limits_reports_real_message_compaction_policy(real_api, auth_headers, enabled, on_threshold, threshold, mode):
    from copy import deepcopy
    http, agent = real_api
    agent.config.setdefault('memory', {})['session_archive'] = {
        'enabled':enabled, 'on_stm_threshold':on_threshold, 'threshold_messages':threshold,
    }
    before = deepcopy(agent.config)
    response = http.get('/v1/context/limits?channel_id=chat-1', headers=headers(auth_headers, role='admin'))
    assert response.status_code == 200
    assert response.json()['data']['policy'] == {
        'compaction_enabled':enabled, 'mode':mode, 'threshold_messages':threshold,
    }
    assert 'threshold_pct' not in response.text
    assert agent.config == before
