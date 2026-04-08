from __future__ import annotations
import os, re, threading, time, hashlib, json, logging
from datetime import datetime, timedelta, timezone
import requests as http_requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)
load_dotenv()
app = Flask(__name__)
_PROJECT_ID = os.environ.get('FIREBASE_PROJECT_ID', '')
FIREBASE_CONFIG = {
    'apiKey':            os.environ.get('FIREBASE_API_KEY'),
    'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN'),
    'databaseURL':       os.environ.get('FIREBASE_DATABASE_URL'),
    'projectId':         _PROJECT_ID,
    'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET', f'{_PROJECT_ID}.appspot.com'),
    'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
    'appId':             os.environ.get('FIREBASE_APP_ID', ''),
}
DB_URL = (os.environ.get('FIREBASE_DATABASE_URL') or '').rstrip('/')
_PHASE_RE = re.compile(r'^L\d+$')
def _detect_phases(device_data: dict) -> list[str]:
    keys: set[str] = set()
    for src in [device_data.get('RealTime') or {}, (device_data.get('meta') or {}).get('sensors') or {}]:
        if isinstance(src, dict): keys.update(k for k in src if _PHASE_RE.match(k))
    return sorted(keys, key=lambda x: int(x[1:])) or ['L1']
def _fb(method: str, path: str, **kw):
    try:
        r = http_requests.request(method, f'{DB_URL}/{path}.json', timeout=6, **kw)
        return r.json() if r.ok else None
    except Exception: return None
fb_get    = lambda p:    _fb('GET',    p)
fb_put    = lambda p, d: _fb('PUT',    p, json=d) is not None
fb_patch  = lambda p, d: _fb('PATCH',  p, json=d) is not None
fb_delete = lambda p:    _fb('DELETE', p) is not None
def normalize(raw: dict | None) -> dict | None:
    if not raw: return None
    try:
        phases = sorted([k for k in raw if _PHASE_RE.match(k)], key=lambda x: int(x[1:]))
        if not phases: return None
        def g(p, k):
            try: return float((raw.get(p) or {}).get(k, 0))
            except: return 0.0
        V  = [g(p, 'Voltage (V)')          for p in phases]
        I  = [g(p, 'Current (A)')            for p in phases]
        P  = [g(p, 'Power (W)')              for p in phases]
        F  = [g(p, 'Frequency (Hz)')         for p in phases]
        S  = [g(p, 'Apparent Power (kVA)')   for p in phases]
        Q  = [g(p, 'Reactive Power (kVAR)')  for p in phases]
        E  = [g(p, 'Active Energy (kWh)')    for p in phases]
        PF = [g(p, 'Power Factor')           for p in phases]
        d  = max(sum(1 for v in V if v > 0), 1)
        return {
            'Voltage': sum(V)/d, 'Current': sum(I), 'Power': sum(P), 'Frequency': sum(F)/d,
            'Apparent': sum(S), 'Reactive': sum(Q), 'Energy': sum(E), 'PowerFactor': sum(PF)/d,
            'Phase1': g(phases[0], 'Phase Angle (°)'),
            'EnergyApparent': sum(g(p, 'Apparent Energy (kVAh)')  for p in phases),
            'EnergyReactive': sum(g(p, 'Reactive Energy (kVARh)') for p in phases),
        }
    except: return None
_WIB = timezone(timedelta(hours=7))
def _ts_now() -> str: return datetime.now(_WIB).strftime('%H:%M:%S %d/%m/%Y')
def validate_device_name(name: str) -> tuple[bool, str]:
    if not name or not isinstance(name, str): return False, 'Nama harus berupa text'
    name = name.strip()
    if not name:        return False, 'Nama tidak boleh kosong'
    if len(name) < 2:   return False, 'Nama minimal 2 karakter' 
    if len(name) > 100: return False, 'Nama maksimal 100 karakter'
    if any(c in name for c in '/.$#[]'): return False, 'Karakter tidak diizinkan: / . $ # [ ]'
    return True, ''
def validate_phase_key(phase: str) -> bool: return bool(_PHASE_RE.match(phase))
_capture_lock  = threading.Lock()
_capture_state = {
    'active': False, 'device_id': None, 'device_name': None,
    'session_id': None, 'session_name': None, 'interval': 3,
    'count': 0, 'started_at': None, 'enabled_phases': None,
    '_thread': None, '_stop_event': None, '_wake_event': None, '_finalizing': False,
}
def _data_hash(raw): return hashlib.md5(json.dumps(raw, sort_keys=True).encode()).hexdigest() if raw else None
_hourly_stop = threading.Event()
_device_hourly_hash = {}

def _do_hourly_capture_device(device_id: str) -> None:
    try:
        raw = fb_get(f'devices/{device_id}/RealTime')
        if not raw or not isinstance(raw, dict): return
        
        h = _data_hash(raw)
        if _device_hourly_hash.get(device_id) == h:
            return
        _device_hourly_hash[device_id] = h
        
        now = datetime.now(_WIB)
        m   = (now.minute // 5) * 5
        key = f'{now.strftime("%H")}{str(m).zfill(2)}'
        date_str = now.strftime('%Y-%m-%d')
        ts  = f'{now.strftime("%H")}:{str(m).zfill(2)} {now.strftime("%d/%m/%Y")}'
        phases = sorted([k for k in raw if _PHASE_RE.match(k)], key=lambda x: int(x[1:])) or ['L1']
        def _w(ph: str) -> None:
            pd = raw.get(ph) or {}
            def f(k):
                try: return float(pd.get(k) or 0)
                except: return 0.0
            fb_put(f'devices/{device_id}/HourlyCapture/{date_str}/{ph}/{key}', {
                'date': date_str, 'key': key, 'timestamp': ts,
                'Voltage': f('Voltage (V)'), 'Current': f('Current (A)'), 'Power': f('Power (W)'),
                'Apparent': f('Apparent Power (kVA)'), 'Reactive': f('Reactive Power (kVAR)'),
                'Energy': f('Active Energy (kWh)'), 'Frequency': f('Frequency (Hz)'),
                'PowerFactor': f('Power Factor'), 'Phase1': f('Phase Angle (°)'),
            })
        ts_list = [threading.Thread(target=_w, args=(ph,), daemon=True) for ph in phases]
        for t in ts_list: t.start()
        for t in ts_list: t.join(timeout=8)
        
        all_hourly_dates = fb_get(f'devices/{device_id}/HourlyCapture') or {}
        if isinstance(all_hourly_dates, dict):
            old_dates = sorted([k for k in all_hourly_dates.keys() if '-' in k])
            for old_date in old_dates[:-30]:
                fb_delete(f'devices/{device_id}/HourlyCapture/{old_date}')

    except Exception: pass
def _do_day_capture_device(device_id: str) -> None:
    try:
        today  = datetime.now(_WIB).strftime('%Y-%m-%d')
        hourly = fb_get(f'devices/{device_id}/HourlyCapture/{today}') or {}
        phases = sorted([k for k in hourly if _PHASE_RE.match(k)], key=lambda x: int(x[1:]))
        for ph in phases:
            entries = [v for v in (hourly.get(ph) or {}).values() if isinstance(v, dict) and v.get('date') == today]
            if not entries: continue
            def avg(field: str) -> float:
                vals = [float(e[field]) for e in entries if field in e and e[field] is not None]
                return round(sum(vals) / len(vals), 4) if vals else 0.0
            fb_put(f'devices/{device_id}/DayCapture/{ph}/{today}', {
                'date': today, 'sampleCount': len(entries),
                'Voltage': avg('Voltage'), 'Current': avg('Current'), 'Power': avg('Power'),
                'Apparent': avg('Apparent'), 'Reactive': avg('Reactive'), 'Energy': avg('Energy'),
                'Frequency': avg('Frequency'), 'PowerFactor': avg('PowerFactor'), 'Phase1': avg('Phase1'),
            })
            all_days = fb_get(f'devices/{device_id}/DayCapture/{ph}') or {}
            for old in sorted(all_days)[:-30]:
                fb_delete(f'devices/{device_id}/DayCapture/{ph}/{old}')
    except Exception: pass
def _chain_capture_and_day(device_id: str) -> None:
    _do_hourly_capture_device(device_id)
    time.sleep(3)
    _do_day_capture_device(device_id)
def _do_hourly_capture_all() -> None:
    try:
        for did, dd in (fb_get('devices') or {}).items():
            if isinstance(dd, dict):
                threading.Thread(target=_chain_capture_and_day, args=(did,), daemon=True).start()
    except Exception: pass
def _hourly_worker() -> None:
    INTERVAL = 300
    now = datetime.now(_WIB)
    ns  = now.replace(minute=((now.minute // 5) + 1) * 5 % 60, second=0, microsecond=0)
    if ns <= now: ns += timedelta(hours=1)
    if not _hourly_stop.wait(timeout=(ns - now).total_seconds()):
        _do_hourly_capture_all()
    while not _hourly_stop.is_set():
        if _hourly_stop.wait(timeout=INTERVAL): break
        _do_hourly_capture_all()
threading.Thread(target=_hourly_worker, daemon=True).start()
def _do_capture_io(device_id, session_id, sched_ts, interval, last_hash, last_change, enabled_phases):
    try:
        raw = fb_get(f'devices/{device_id}/RealTime')
        h   = _data_hash(raw); now = time.time()
        if h != last_hash[0]: last_hash[0] = h; last_change[0] = now
        stale   = (now - last_change[0]) if last_change[0] else float('inf')
        offline = raw is None or normalize(raw) is None or stale > max(interval * 2, 6)
        ts  = datetime.fromtimestamp(sched_ts, tz=_WIB).strftime('%H:%M:%S %d/%m/%Y')
        key = f'capture_{int(sched_ts * 1000)}'
        all_ph = sorted([k for k in (raw or {}) if _PHASE_RE.match(k)], key=lambda x: int(x[1:])) or ['L1']
        phases = ([p for p in all_ph if p in enabled_phases] or enabled_phases) if enabled_phases else all_ph
        def _w(ph: str) -> None:
            pd = {} if offline else ((raw or {}).get(ph) if isinstance((raw or {}).get(ph), dict) else {})
            def f(k):
                try: return float((pd or {}).get(k) or 0)
                except: return 0.0
            fb_put(f'devices/{device_id}/History/{ph}/{session_id}/{key}', {
                'timestamp': ts, 'offline': offline,
                'Voltage': f('Voltage (V)'), 'Current': f('Current (A)'), 'Power': f('Power (W)'),
                'Apparent': f('Apparent Power (kVA)'), 'Reactive': f('Reactive Power (kVAR)'),
                'Energy': f('Active Energy (kWh)'), 'Frequency': f('Frequency (Hz)'),
                'PowerFactor': f('Power Factor'), 'Phase1': f('Phase Angle (°)'),
                'EnergyApparent': f('Apparent Energy (kVAh)'), 'EnergyReactive': f('Reactive Energy (kVARh)'),
            })
        ts_list = [threading.Thread(target=_w, args=(ph,), daemon=True) for ph in phases]
        for t in ts_list: t.start()
        for t in ts_list: t.join(timeout=8)
        with _capture_lock: _capture_state['count'] += 1
    except Exception: pass
def _capture_worker(stop: threading.Event, wake: threading.Event) -> None:
    stop.wait(3.5)
    last_hash: list = [None]; last_change: list = [None]; nxt = time.time()
    while not stop.is_set():
        if stop.wait(timeout=min(max(0., nxt - time.time()), 0.2)): break
        if wake.is_set():
            wake.clear()
            with _capture_lock: nxt = time.time() + _capture_state['interval']
            continue
        if time.time() < nxt: continue
        with _capture_lock:
            if not _capture_state['active']: break
            sid = _capture_state['session_id']; did = _capture_state['device_id']
            iv  = float(_capture_state['interval']); ep = _capture_state.get('enabled_phases')
        sched = nxt; nxt += iv
        threading.Thread(target=_do_capture_io, args=(did, sid, sched, iv, last_hash, last_change, ep), daemon=True).start()
def _start_thread() -> None:
    se, we = threading.Event(), threading.Event()
    t = threading.Thread(target=_capture_worker, args=(se, we), daemon=True)
    t.start()
    _capture_state.update({'_thread': t, '_stop_event': se, '_wake_event': we})
def _finalize_bg(sid, did, count, se, th, enabled_phases) -> None:
    try:
        if se: se.set()
        if th and th.is_alive(): th.join(timeout=5)
        time.sleep(1.5)
        if sid and did:
            phases  = enabled_phases or _detect_phases(fb_get(f'devices/{did}') or {})
            payload = {'endTime': _ts_now(), 'recordCount': count}
            ts_list = [threading.Thread(target=fb_patch, args=(f'devices/{did}/History/{ph}/{sid}/_meta', payload), daemon=True) for ph in phases]
            for t in ts_list: t.start()
            for t in ts_list: t.join(timeout=8)
    except Exception: pass
    finally:
        with _capture_lock: _capture_state['_finalizing'] = False
def _stop_and_respond() -> None:
    with _capture_lock:
        if not _capture_state['active']: return
        _capture_state.update({'active': False, '_finalizing': True})
        sid = _capture_state['session_id']; did = _capture_state['device_id']
        cnt = _capture_state['count'];      se  = _capture_state.get('_stop_event')
        th  = _capture_state.get('_thread'); ep = _capture_state.get('enabled_phases')
        _capture_state.update({
            'device_id': None, 'device_name': None, 'session_id': None, 'session_name': None,
            'count': 0, 'started_at': None, 'enabled_phases': None,
            '_thread': None, '_stop_event': None, '_wake_event': None,
        })
    threading.Thread(target=_finalize_bg, args=(sid, did, cnt, se, th, ep), daemon=True).start()
@app.route('/')
def index(): return render_template('index.html', firebase_config=FIREBASE_CONFIG)
@app.route('/health', methods=['GET'])
def health(): return jsonify({"status": "ok", "message": "Service is alive"}), 200
@app.route('/api/config')
def get_config(): return jsonify(FIREBASE_CONFIG)
@app.route('/api/devices')
def list_devices():
    devices = []
    for did, dd in (fb_get('devices') or {}).items():
        if not isinstance(dd, dict): continue
        meta    = dd.get('meta') or {}
        sensors = meta.get('sensors') or {}
        detected = _detect_phases(dd)
        phases = []
        for ph in detected:
            s = sensors.get(ph) or {} if isinstance(sensors, dict) else {}
            phases.append({'phase': ph, 'name': s.get('name', ph), 'properties': s.get('properties', []), 'enabled': s.get('enabled', True)})
        devices.append({'id': did, 'name': meta.get('name', did), 'online': meta.get('online', False),
                        'lastSeen': meta.get('lastSeen', '---'), 'phases': phases, 'phaseCount': len(phases)})
    return jsonify(sorted(devices, key=lambda d: d['id']))
@app.route('/api/devices/<device_id>/init-sensors', methods=['POST'])
def init_device_sensors(device_id: str):
    dd = fb_get(f'devices/{device_id}') or {}
    detected = _detect_phases(dd); count = 0
    for ph in detected:
        if fb_get(f'devices/{device_id}/meta/sensors/{ph}') is None:
            if fb_put(f'devices/{device_id}/meta/sensors/{ph}',
                      {'name': ph, 'phase': ph, 'properties': [], 'enabled': True,
                       'created_at': _ts_now(), 'updated_at': _ts_now()}):
                count += 1
    return jsonify({'ok': True, 'initialized': count, 'device_id': device_id, 'phases': detected})
@app.route('/api/devices/<device_id>/rename', methods=['POST'])
def rename_device(device_id: str):
    name = ((request.get_json(silent=True) or {}).get('name') or '').strip()
    ok, err = validate_device_name(name)
    if not ok: return jsonify({'ok': False, 'error': err}), 400
    if fb_patch(f'devices/{device_id}/meta', {'name': name}):
        return jsonify({'ok': True, 'name': name, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan ke Firebase'}), 500
@app.route('/api/devices/<device_id>/sensors/<phase>/rename', methods=['POST'])
def rename_sensor(device_id: str, phase: str):
    phase = phase.upper()
    if not validate_phase_key(phase): return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    name = ((request.get_json(silent=True) or {}).get('name') or '').strip()
    ok, err = validate_device_name(name)
    if not ok: return jsonify({'ok': False, 'error': err}), 400
    cur  = fb_get(f'devices/{device_id}/meta/sensors/{phase}') or {}
    data = {'name': name, 'phase': phase, 'properties': cur.get('properties', []),
            'enabled': cur.get('enabled', True), 'created_at': cur.get('created_at', _ts_now()), 'updated_at': _ts_now()}
    if fb_patch(f'devices/{device_id}/meta/sensors/{phase}', data):
        return jsonify({'ok': True, 'name': name, 'phase': phase, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan ke Firebase'}), 500
@app.route('/api/devices/<device_id>/sensors/<phase>/init', methods=['POST'])
def init_sensor(device_id: str, phase: str):
    phase = phase.upper()
    if not validate_phase_key(phase): return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    ex = fb_get(f'devices/{device_id}/meta/sensors/{phase}')
    if ex: return jsonify({'ok': True, 'exists': True, 'sensor': ex})
    data = {'name': f'Phase {phase[1:]}', 'phase': phase, 'properties': [], 'enabled': True, 'created_at': _ts_now()}
    if fb_put(f'devices/{device_id}/meta/sensors/{phase}', data):
        return jsonify({'ok': True, 'sensor': data, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal membuat sensor'}), 500
@app.route('/api/devices/<device_id>/sensors/<phase>/enabled', methods=['POST'])
def set_phase_enabled(device_id: str, phase: str):
    phase = phase.upper()
    if not validate_phase_key(phase): return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    enabled = bool((request.get_json(silent=True) or {}).get('enabled', True))
    if fb_patch(f'devices/{device_id}/meta/sensors/{phase}', {'enabled': enabled, 'updated_at': _ts_now()}):
        return jsonify({'ok': True, 'phase': phase, 'enabled': enabled})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan'}), 500
@app.route('/api/devices/<device_id>/hourly-capture', methods=['POST'])
def trigger_hourly_capture(device_id: str):
    threading.Thread(target=_chain_capture_and_day, args=(device_id,), daemon=True).start()
    return jsonify({'ok': True, 'device_id': device_id, 'triggered_at': _ts_now()})
@app.route('/api/hourly-capture/trigger-all', methods=['POST'])
def trigger_hourly_all():
    threading.Thread(target=_do_hourly_capture_all, daemon=True).start()
    return jsonify({'ok': True, 'triggered_at': _ts_now()})
@app.route('/api/capture/status')
def capture_status():
    with _capture_lock:
        s = _capture_state
        return jsonify({
            'active': s['active'], 'device_id': s['device_id'], 'device_name': s['device_name'],
            'session_id': s['session_id'], 'session_name': s['session_name'], 'interval': s['interval'],
            'count': s['count'], 'started_at': s['started_at'], 'finalizing': s.get('_finalizing', False),
        })
@app.route('/api/capture/start', methods=['POST'])
def capture_start():
    body  = request.get_json(silent=True) or {}
    did   = (body.get('deviceId')    or '').strip()
    dname = (body.get('deviceName')  or '').strip()
    sname = (body.get('sessionName') or '').strip() or f'Rekaman {_ts_now()}'
    iv    = max(1, int(body.get('interval', 3)))
    hints = sorted([p for p in (body.get('phases') or []) if _PHASE_RE.match(p)], key=lambda x: int(x[1:]))
    if not did: return jsonify({'ok': False, 'error': 'deviceId harus diisi'}), 400
    with _capture_lock:
        if _capture_state['active'] or _capture_state.get('_finalizing'):
            return jsonify({'ok': False, 'error': 'Capture sudah berjalan atau sedang finalisasi'}), 409
        sid    = f'session_{int(time.time() * 1000)}'
        now_s  = _ts_now()
        phases = hints or ['L1']
        ep     = hints or None
        _capture_state.update({
            'active': True, 'device_id': did, 'device_name': dname or did,
            'session_id': sid, 'session_name': sname, 'interval': iv,
            'count': 0, 'started_at': now_s, 'enabled_phases': ep,
        })
        meta = {
            'id': sid, 'name': sname, 'deviceId': did, 'deviceName': dname or did,
            'startTime': now_s, 'startTimestamp': int(time.time() * 1000),
            'endTime': None, 'recordCount': 0, 'phaseNames': {ph: ph for ph in phases},
        }
        def _meta_bg():
            try:
                sensors = ((fb_get(f'devices/{did}') or {}).get('meta') or {}).get('sensors') or {}
                meta['phaseNames'] = {ph: (sensors.get(ph) or {}).get('name', ph) for ph in phases}
            except: pass
            for ph in phases: fb_put(f'devices/{did}/History/{ph}/{sid}/_meta', meta)
        threading.Thread(target=_meta_bg, daemon=True).start()
        def _energy_bg():
            try:
                fb_put(f'devices/{did}/Commands/resetEnergy', {'command': True, 'timestamp': int(time.time()*1000)})
                time.sleep(5); fb_delete(f'devices/{did}/Commands/resetEnergy')
            except: pass
        threading.Thread(target=_energy_bg, daemon=True).start()
        _start_thread()
    return jsonify({'ok': True, 'session_id': sid, 'session_name': sname, 'device_id': did})
@app.route('/api/capture/stop', methods=['POST'])
def capture_stop():
    with _capture_lock:
        if not _capture_state['active']: return jsonify({'ok': False, 'error': 'Tidak ada capture aktif'}), 400
    _stop_and_respond()
    return jsonify({'ok': True})
@app.route('/api/capture/interval', methods=['POST'])
def capture_interval():
    iv = max(1, int((request.get_json(silent=True) or {}).get('interval', 3)))
    with _capture_lock:
        _capture_state['interval'] = iv
        ev = _capture_state.get('_wake_event')
        if ev: ev.set()
    return jsonify({'ok': True, 'interval': iv})
if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
