from flask import Flask, render_template, jsonify, request
import os, threading, time
from datetime import datetime
import requests as http_requests
from dotenv import load_dotenv

load_dotenv()
app = Flask(__name__)

FIREBASE_CONFIG = {
    'apiKey':            os.environ.get('FIREBASE_API_KEY'),
    'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN'),
    'databaseURL':       os.environ.get('FIREBASE_DATABASE_URL'),
    'projectId':         os.environ.get('FIREBASE_PROJECT_ID'),
    'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET',
                            f"{os.environ.get('FIREBASE_PROJECT_ID','')}.appspot.com"),
    'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID',''),
    'appId':             os.environ.get('FIREBASE_APP_ID',''),
}
DB_URL = os.environ.get('FIREBASE_DATABASE_URL','').rstrip('/')

# ── Firebase REST helpers ─────────────────────────────────────────────────────
def fb_get(path):
    try:
        r = http_requests.get(f"{DB_URL}/{path}.json", timeout=6)
        return r.json() if r.ok else None
    except Exception as e:
        print(f"[FB GET] {path} — {e}"); return None

def fb_put(path, data):
    try:
        r = http_requests.put(f"{DB_URL}/{path}.json", json=data, timeout=6)
        return r.ok
    except Exception as e:
        print(f"[FB PUT] {path} — {e}"); return False

def fb_patch(path, data):
    try:
        r = http_requests.patch(f"{DB_URL}/{path}.json", json=data, timeout=6)
        return r.ok
    except Exception as e:
        print(f"[FB PATCH] {path} — {e}"); return False

def fb_delete(path):
    try:
        r = http_requests.delete(f"{DB_URL}/{path}.json", timeout=6)
        return r.ok
    except Exception as e:
        print(f"[FB DELETE] {path} — {e}"); return False

# ── Normalize PZEM data ───────────────────────────────────────────────────────
def normalize(raw):
    if not raw: return None
    try:
        return {
            'Voltage':        float(raw.get('V1',    0) or 0),
            'Current':        float(raw.get('A1',    0) or 0),
            'Power':         (float(raw.get('P_SUM', 0) or 0)) * 1000,
            'Frequency':      float(raw.get('FREQ',  0) or 0),
            'Apparent':       float(raw.get('S_SUM', 0) or 0),
            'Reactive':       float(raw.get('Q_SUM', 0) or 0),
            'Energy':         float(raw.get('WH',    0) or 0),
            'PowerFactor':    float(raw.get('PF_SUM',0) or 0),
            'Phase1':         float(raw.get('PHASE1',0) or 0),
            'EnergyApparent': float(raw.get('SH',    0) or 0),
            'EnergyReactive': float(raw.get('QH',    0) or 0),
        }
    except Exception: return None

def _ts_now():
    return datetime.now().strftime('%H:%M:%S %d/%m/%Y')

# ── Capture state ─────────────────────────────────────────────────────────────
_capture_lock  = threading.Lock()
_capture_state = {
    'active': False, 'device_id': None,
    'session_id': None, 'session_name': None,
    'interval': 3, 'count': 0, 'started_at': None,
    '_thread': None, '_stop_event': None, '_wake_event': None,
}

def _capture_worker(stop_event, wake_event):
    import hashlib, json as _json
    last_raw_hash = None; last_change_time = None
    next_capture  = time.time()

    while not stop_event.is_set():
        sleep_for = max(0.0, next_capture - time.time())
        if stop_event.wait(timeout=min(sleep_for, 0.2)): break
        if wake_event.is_set():
            wake_event.clear()
            with _capture_lock: interval = _capture_state['interval']
            next_capture = time.time() + interval; continue
        if time.time() < next_capture: continue

        with _capture_lock:
            if not _capture_state['active']: break
            session_id = _capture_state['session_id']
            device_id  = _capture_state['device_id']
            interval   = _capture_state['interval']
        next_capture += interval

        try:
            raw  = fb_get(f'devices/{device_id}/RealTime')
            data = normalize(raw)
            raw_hash = hashlib.md5(_json.dumps(raw, sort_keys=True).encode()).hexdigest() if raw else None
            now  = time.time()

            if raw_hash != last_raw_hash:
                last_raw_hash = raw_hash; last_change_time = now

            stale_seconds   = (now - last_change_time) if last_change_time else float('inf')
            stale_threshold = max(interval * 2, 6)
            device_offline  = (
                data is None
                or (data['Voltage']==0 and data['Current']==0 and data['Power']==0)
                or stale_seconds > stale_threshold
            )

            src = data if (data and not device_offline) else None
            record = {
                'timestamp': _ts_now(), 'offline': device_offline,
                'Voltage':        src['Voltage']        if src else 0,
                'Current':        src['Current']        if src else 0,
                'Power':          src['Power']          if src else 0,
                'Apparent':       src['Apparent']       if src else 0,
                'Reactive':       src['Reactive']       if src else 0,
                'Energy':         src['Energy']         if src else 0,
                'Frequency':      src['Frequency']      if src else 0,
                'PowerFactor':    src['PowerFactor']    if src else 0,
                'Phase1':         src['Phase1']         if src else 0,
                'EnergyApparent': src['EnergyApparent'] if src else 0,
                'EnergyReactive': src['EnergyReactive'] if src else 0,
            }
            key = f"capture_{int(time.time()*1000)}"
            fb_put(f"devices/{device_id}/History/{session_id}/{key}", record)
            with _capture_lock: _capture_state['count'] += 1

            now = time.time()
            if next_capture < now:
                missed = int((now - next_capture) / interval) + 1
                next_capture += missed * interval
        except Exception as e:
            print(f"[CaptureWorker] {e}")

    print("[CaptureWorker] Thread exiting.")

def _start_thread():
    se = threading.Event(); we = threading.Event()
    t  = threading.Thread(target=_capture_worker, args=(se, we), daemon=True)
    t.start()
    _capture_state.update({'_thread': t, '_stop_event': se, '_wake_event': we})

def _stop_thread_and_finalize():
    se = _capture_state.get('_stop_event')
    if se: se.set()
    th = _capture_state.get('_thread')
    if th and th.is_alive(): th.join(timeout=5)
    sid = _capture_state['session_id']
    did = _capture_state['device_id']
    if sid and did:
        fb_patch(f"devices/{did}/History/{sid}/_meta",
                 {'endTime': _ts_now(), 'recordCount': _capture_state['count']})
    _capture_state.update({
        'active': False, 'device_id': None, 'session_id': None,
        'session_name': None, 'count': 0, 'started_at': None,
        '_thread': None, '_stop_event': None, '_wake_event': None,
    })

# ── Routes — pages ────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', firebase_config=FIREBASE_CONFIG)

@app.route('/api/config')
def get_config():
    return jsonify(FIREBASE_CONFIG)

# ── Device endpoints ──────────────────────────────────────────────────────────
@app.route('/api/devices')
def list_devices():
    raw = fb_get('devices') or {}
    devices = []
    for device_id, device_data in raw.items():
        if not isinstance(device_data, dict): continue
        meta = device_data.get('meta', {}) or {}
        devices.append({
            'id':       device_id,
            'name':     meta.get('name', device_id),
            'online':   meta.get('online', False),
            'lastSeen': meta.get('lastSeen', '---'),
        })
    devices.sort(key=lambda d: d['id'])
    return jsonify(devices)

@app.route('/api/devices/<device_id>/rename', methods=['POST'])
def rename_device(device_id):
    body     = request.get_json(silent=True) or {}
    new_name = (body.get('name') or '').strip()
    if not new_name:
        return jsonify({'ok': False, 'error': 'Nama tidak boleh kosong'}), 400
    ok = fb_patch(f'devices/{device_id}/meta', {'name': new_name})
    return jsonify({'ok': ok, 'name': new_name})

# ── Capture endpoints ─────────────────────────────────────────────────────────
@app.route('/api/capture/status')
def capture_status():
    with _capture_lock:
        st = _capture_state
        return jsonify({
            'active':       st['active'],
            'device_id':    st['device_id'],
            'session_id':   st['session_id'],
            'session_name': st['session_name'],
            'interval':     st['interval'],
            'count':        st['count'],
            'started_at':   st['started_at'],
        })

@app.route('/api/capture/start', methods=['POST'])
def capture_start():
    body         = request.get_json(silent=True) or {}
    device_id    = (body.get('deviceId') or '').strip()
    session_name = (body.get('sessionName') or '').strip() or f"Rekaman {_ts_now()}"
    interval_s   = max(1, int(body.get('interval', 3)))

    if not device_id:
        return jsonify({'ok': False, 'error': 'deviceId harus diisi'}), 400

    with _capture_lock:
        if _capture_state['active']:
            return jsonify({'ok': False, 'error': 'Capture sudah berjalan'}), 409

        session_id = f"session_{int(time.time()*1000)}"
        now_str    = _ts_now()
        fb_put(f"devices/{device_id}/History/{session_id}/_meta", {
            'id': session_id, 'name': session_name,
            'startTime': now_str, 'startTimestamp': int(time.time()*1000),
            'endTime': None, 'recordCount': 0,
        })
        _capture_state.update({
            'active': True, 'device_id': device_id,
            'session_id': session_id, 'session_name': session_name,
            'interval': interval_s, 'count': 0, 'started_at': now_str,
        })

        try:
            fb_put(f'devices/{device_id}/Commands/resetEnergy',
                   {'command': True, 'timestamp': int(time.time()*1000)})
            def _rm():
                time.sleep(5)
                fb_delete(f'devices/{device_id}/Commands/resetEnergy')
            threading.Thread(target=_rm, daemon=True).start()
        except Exception as e:
            print(f"[Capture] Reset energy gagal: {e}")

        _start_thread()

    return jsonify({'ok': True, 'session_id': session_id,
                    'session_name': session_name, 'device_id': device_id})

@app.route('/api/capture/stop', methods=['POST'])
def capture_stop():
    with _capture_lock:
        if not _capture_state['active']:
            return jsonify({'ok': False, 'error': 'Tidak ada capture aktif'}), 400
    _stop_thread_and_finalize()
    return jsonify({'ok': True})

@app.route('/api/capture/interval', methods=['POST'])
def capture_interval():
    body       = request.get_json(silent=True) or {}
    interval_s = max(1, int(body.get('interval', 3)))
    with _capture_lock:
        _capture_state['interval'] = interval_s
        ev = _capture_state.get('_wake_event')
        if ev: ev.set()
    return jsonify({'ok': True, 'interval': interval_s})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)