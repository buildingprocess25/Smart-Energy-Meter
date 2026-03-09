from __future__ import annotations
import os
import re
import threading
import time
import hashlib
import json
from datetime import datetime
import requests as http_requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()
app = Flask(__name__)

# ── Firebase config ────────────────────────────────────────────────────────────
_PROJECT_ID = os.environ.get('FIREBASE_PROJECT_ID', '')

FIREBASE_CONFIG: dict = {
    'apiKey':            os.environ.get('FIREBASE_API_KEY'),
    'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN'),
    'databaseURL':       os.environ.get('FIREBASE_DATABASE_URL'),
    'projectId':         _PROJECT_ID,
    'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET', f'{_PROJECT_ID}.appspot.com'),
    'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
    'appId':             os.environ.get('FIREBASE_APP_ID', ''),
}

DB_URL: str = (os.environ.get('FIREBASE_DATABASE_URL') or '').rstrip('/')

# ── Phase detection regex ──────────────────────────────────────────────────────
_PHASE_RE = re.compile(r'^L\d+$')


def _detect_phases(device_data: dict) -> list[str]:
    phase_set: set[str] = set()
    realtime = device_data.get('RealTime') or {}
    if isinstance(realtime, dict):
        for key in realtime.keys():
            if _PHASE_RE.match(key):
                phase_set.add(key)
    sensors = (device_data.get('meta') or {}).get('sensors') or {}
    if isinstance(sensors, dict):
        for key in sensors.keys():
            if _PHASE_RE.match(key):
                phase_set.add(key)
    if not phase_set:
        return ['L1']
    return sorted(phase_set, key=lambda x: int(x[1:]))


# ── Firebase REST helpers ──────────────────────────────────────────────────────
def _fb_request(method: str, path: str, **kwargs) -> dict | None:
    try:
        r = http_requests.request(method, f'{DB_URL}/{path}.json', timeout=6, **kwargs)
        return r.json() if r.ok else None
    except Exception as exc:
        print(f'[FB {method}] {path} — {exc}')
        return None


def fb_get(path: str):
    return _fb_request('GET', path)

def fb_put(path: str, data) -> bool:
    return _fb_request('PUT', path, json=data) is not None

def fb_patch(path: str, data) -> bool:
    return _fb_request('PATCH', path, json=data) is not None

def fb_delete(path: str) -> bool:
    return _fb_request('DELETE', path) is not None


# ── Data normalisation ─────────────────────────────────────────────────────────
def normalize(raw: dict | None) -> dict | None:
    if not raw:
        return None
    try:
        def get_val(phase: str, key: str) -> float:
            p = raw.get(phase)
            if isinstance(p, dict):
                try:
                    return float(p.get(key, 0))
                except (ValueError, TypeError):
                    return 0.0
            return 0.0

        phases = [k for k in raw.keys() if _PHASE_RE.match(k)]
        phases = sorted(phases, key=lambda x: int(x[1:]))
        if not phases:
            return None

        voltages  = [get_val(p, 'Voltage (V)')          for p in phases]
        currents  = [get_val(p, 'Current (A)')           for p in phases]
        powers    = [get_val(p, 'Power (W)')             for p in phases]
        freqs     = [get_val(p, 'Frequency (Hz)')        for p in phases]
        apparents = [get_val(p, 'Apparent Power (kVA)')  for p in phases]
        reactives = [get_val(p, 'Reactive Power (kVAR)') for p in phases]
        energies  = [get_val(p, 'Active Energy (kWh)')   for p in phases]
        pfs       = [get_val(p, 'Power Factor')           for p in phases]

        ph1 = get_val(phases[0], 'Phase Angle (°)')
        ea  = sum(get_val(p, 'Apparent Energy (kVAh)')  for p in phases)
        er  = sum(get_val(p, 'Reactive Energy (kVARh)') for p in phases)

        active_phases = sum(1 for v in voltages if v > 0)
        denom = active_phases if active_phases > 0 else 1

        return {
            'Voltage':        sum(voltages)  / denom,
            'Current':        sum(currents),
            'Power':          sum(powers),
            'Frequency':      sum(freqs)     / denom,
            'Apparent':       sum(apparents),
            'Reactive':       sum(reactives),
            'Energy':         sum(energies),
            'PowerFactor':    sum(pfs)       / denom,
            'Phase1':         ph1,
            'EnergyApparent': ea,
            'EnergyReactive': er,
        }
    except Exception:
        return None


def _ts_now() -> str:
    return datetime.now().strftime('%H:%M:%S %d/%m/%Y')


# ── Validation helpers ─────────────────────────────────────────────────────────
def validate_device_name(name: str) -> tuple[bool, str]:
    if not name or not isinstance(name, str):
        return False, 'Nama harus berupa text'
    name = name.strip()
    if not name:
        return False, 'Nama tidak boleh kosong'
    if len(name) < 2:
        return False, 'Nama minimal 2 karakter'
    if len(name) > 100:
        return False, 'Nama maksimal 100 karakter'
    forbidden_chars = ['/', '.', '$', '#', '[', ']']
    if any(c in name for c in forbidden_chars):
        return False, f'Karakter tidak diizinkan: {" ".join(forbidden_chars)}'
    return True, ''


VALID_SENSOR_PROPERTIES = [
    'Voltage (V)', 'Current (A)', 'Power (W)', 'Frequency (Hz)',
    'Apparent Power (kVA)', 'Reactive Power (kVAR)', 'Active Energy (kWh)',
    'Power Factor', 'Phase Angle (°)', 'Apparent Energy (kVAh)', 'Reactive Energy (kVARh)'
]

def validate_phase_key(phase: str) -> bool:
    return bool(_PHASE_RE.match(phase))


# ── Capture state ──────────────────────────────────────────────────────────────
_capture_lock = threading.Lock()
_capture_state: dict = {
    'active':          False,
    'device_id':       None,
    'device_name':     None,
    'session_id':      None,
    'session_name':    None,
    'interval':        3,
    'count':           0,
    'started_at':      None,
    'enabled_phases':  None,
    '_thread':         None,
    '_stop_event':     None,
    '_wake_event':     None,
    '_finalizing':     False,
}


def _data_hash(raw: dict | None) -> str | None:
    if not raw:
        return None
    return hashlib.md5(json.dumps(raw, sort_keys=True).encode()).hexdigest()


# ── Chart Buffer (shared realtime chart across all clients) ───────────────────
_chart_writer_threads: dict = {}   # device_id -> (thread, stop_event)
_CHART_MAX_POINTS     = 300
_CHART_WRITE_INTERVAL = 3          # seconds


def _ensure_chart_writer(device_id: str) -> None:
    """Start chart-buffer writer for device if not already running."""
    existing = _chart_writer_threads.get(device_id)
    if existing:
        t, se = existing
        if t.is_alive():
            return
    se = threading.Event()
    t  = threading.Thread(
        target=_chart_writer_worker, args=(device_id, se), daemon=True
    )
    t.start()
    _chart_writer_threads[device_id] = (t, se)
    print(f'[ChartWriter:{device_id}] Started')


def _chart_writer_worker(device_id: str, stop_event: threading.Event) -> None:
    """Write RealTime snapshot to ChartBuffer every N seconds."""
    while not stop_event.is_set():
        try:
            raw = fb_get(f'devices/{device_id}/RealTime')
            if raw and isinstance(raw, dict):
                phases = {k: v for k, v in raw.items() if _PHASE_RE.match(k)}
                if phases:
                    ts  = int(time.time() * 1000)
                    key = f'p{ts}'
                    payload = {'ts': ts}
                    payload.update(phases)
                    fb_put(f'devices/{device_id}/ChartBuffer/{key}', payload)

                    # Prune old points — keep latest _CHART_MAX_POINTS
                    buf = fb_get(f'devices/{device_id}/ChartBuffer')
                    if buf and isinstance(buf, dict) and len(buf) > _CHART_MAX_POINTS + 30:
                        keys_sorted = sorted(buf.keys())
                        excess = keys_sorted[: len(keys_sorted) - _CHART_MAX_POINTS]
                        prune_threads = [
                            threading.Thread(
                                target=fb_delete,
                                args=(f'devices/{device_id}/ChartBuffer/{old}',),
                                daemon=True,
                            )
                            for old in excess
                        ]
                        for pt in prune_threads:
                            pt.start()
                        for pt in prune_threads:
                            pt.join(timeout=5)
        except Exception as exc:
            print(f'[ChartWriter:{device_id}] Error: {exc}')
        stop_event.wait(timeout=_CHART_WRITE_INTERVAL)
    print(f'[ChartWriter:{device_id}] Stopped')


def _start_all_chart_writers() -> None:
    """Called once on startup — start writers for all registered devices."""
    try:
        devices = fb_get('devices') or {}
        for device_id in devices:
            if isinstance(device_id, str):
                _ensure_chart_writer(device_id)
        print(f'[ChartWriter] Started writers for {len(devices)} device(s)')
    except Exception as exc:
        print(f'[ChartWriter] Startup error: {exc}')


# ── I/O task ──────────────────────────────────────────────────────────────────
def _do_capture_io(
    device_id:          str,
    session_id:         str,
    scheduled_ts:       float,
    interval:           float,
    last_hash_holder:   list,
    last_change_holder: list,
    enabled_phases:     list | None = None,
) -> None:
    try:
        raw      = fb_get(f'devices/{device_id}/RealTime')
        data     = normalize(raw)
        raw_hash = _data_hash(raw)
        now      = time.time()

        if raw_hash != last_hash_holder[0]:
            last_hash_holder[0]   = raw_hash
            last_change_holder[0] = now

        stale_seconds   = (now - last_change_holder[0]) if last_change_holder[0] else float('inf')
        stale_threshold = max(interval * 2, 6)
        device_offline  = (data is None or stale_seconds > stale_threshold)

        ts  = datetime.fromtimestamp(scheduled_ts).strftime('%H:%M:%S %d/%m/%Y')
        key = f'capture_{int(scheduled_ts * 1000)}'

        all_raw_phases: list[str] = []
        if raw and isinstance(raw, dict):
            all_raw_phases = sorted(
                [k for k in raw.keys() if _PHASE_RE.match(k)],
                key=lambda x: int(x[1:])
            )
        if not all_raw_phases:
            all_raw_phases = ['L1']

        if enabled_phases:
            phases = [p for p in all_raw_phases if p in enabled_phases]
            if not phases:
                phases = enabled_phases
        else:
            phases = all_raw_phases

        def _write_phase(phase: str) -> None:
            pd: dict = {}
            if not device_offline and raw and isinstance(raw.get(phase), dict):
                pd = raw[phase]

            def _f(field: str) -> float:
                try:
                    return float(pd.get(field) or 0)
                except Exception:
                    return 0.0

            fb_put(
                f'devices/{device_id}/History/{phase}/{session_id}/{key}',
                {
                    'timestamp':      ts,
                    'offline':        device_offline,
                    'Voltage':        _f('Voltage (V)'),
                    'Current':        _f('Current (A)'),
                    'Power':          _f('Power (W)'),
                    'Apparent':       _f('Apparent Power (kVA)'),
                    'Reactive':       _f('Reactive Power (kVAR)'),
                    'Energy':         _f('Active Energy (kWh)'),
                    'Frequency':      _f('Frequency (Hz)'),
                    'PowerFactor':    _f('Power Factor'),
                    'Phase1':         _f('Phase Angle (°)'),
                    'EnergyApparent': _f('Apparent Energy (kVAh)'),
                    'EnergyReactive': _f('Reactive Energy (kVARh)'),
                }
            )

        write_threads = [
            threading.Thread(target=_write_phase, args=(ph,), daemon=True)
            for ph in phases
        ]
        for t in write_threads:
            t.start()
        for t in write_threads:
            t.join(timeout=8)

        with _capture_lock:
            _capture_state['count'] += 1

        elapsed = time.time() - scheduled_ts
        print(f'[CaptureIO] ✅ {ts} | phases={phases} | total={elapsed:.2f}s')

    except Exception as exc:
        print(f'[CaptureIO] ❌ {exc}')


# ── Timer loop ────────────────────────────────────────────────────────────────
def _capture_worker(stop_event: threading.Event, wake_event: threading.Event) -> None:
    last_hash_holder:   list = [None]
    last_change_holder: list = [None]

    next_capture: float = time.time()

    while not stop_event.is_set():

        sleep_for = max(0.0, next_capture - time.time())
        if stop_event.wait(timeout=min(sleep_for, 0.2)):
            break

        if wake_event.is_set():
            wake_event.clear()
            with _capture_lock:
                interval = _capture_state['interval']
            next_capture = time.time() + interval
            continue

        if time.time() < next_capture:
            continue

        with _capture_lock:
            if not _capture_state['active']:
                break
            session_id      = _capture_state['session_id']
            device_id       = _capture_state['device_id']
            interval        = float(_capture_state['interval'])
            enabled_phases  = _capture_state.get('enabled_phases')

        scheduled_ts = next_capture
        next_capture = next_capture + interval

        threading.Thread(
            target=_do_capture_io,
            args=(device_id, session_id, scheduled_ts, interval,
                  last_hash_holder, last_change_holder, enabled_phases),
            daemon=True,
        ).start()

    print('[CaptureWorker] Timer thread exiting.')


def _start_thread() -> None:
    se = threading.Event()
    we = threading.Event()
    t  = threading.Thread(target=_capture_worker, args=(se, we), daemon=True)
    t.start()
    _capture_state.update({'_thread': t, '_stop_event': se, '_wake_event': we})


# ── Finalize in background ────────────────────────────────────────────────────
def _finalize_in_background(
    sid:             str,
    did:             str,
    count:           int,
    se:              threading.Event | None,
    th:              threading.Thread | None,
    enabled_phases:  list | None = None,
) -> None:
    try:
        if se:
            se.set()
        if th and th.is_alive():
            th.join(timeout=5)
        time.sleep(1.5)

        if sid and did:
            if enabled_phases:
                phases = enabled_phases
            else:
                device_data = fb_get(f'devices/{did}') or {}
                phases      = _detect_phases(device_data)
            end_payload = {'endTime': _ts_now(), 'recordCount': count}
            write_threads = [
                threading.Thread(
                    target=fb_patch,
                    args=(f'devices/{did}/History/{ph}/{sid}/_meta', end_payload),
                    daemon=True,
                )
                for ph in phases
            ]
            for t in write_threads:
                t.start()
            for t in write_threads:
                t.join(timeout=8)

        print(f'[Finalize] ✅ session {sid} finalized ({count} records)')

    except Exception as exc:
        print(f'[Finalize] ❌ {exc}')

    finally:
        with _capture_lock:
            _capture_state.update({'_finalizing': False})


def _stop_and_respond() -> None:
    with _capture_lock:
        if not _capture_state['active']:
            return

        _capture_state['active']      = False
        _capture_state['_finalizing'] = True

        sid             = _capture_state['session_id']
        did             = _capture_state['device_id']
        count           = _capture_state['count']
        se              = _capture_state.get('_stop_event')
        th              = _capture_state.get('_thread')
        enabled_phases  = _capture_state.get('enabled_phases')

        _capture_state.update({
            'device_id':      None,
            'device_name':    None,
            'session_id':     None,
            'session_name':   None,
            'count':          0,
            'started_at':     None,
            'enabled_phases': None,
            '_thread':        None,
            '_stop_event':    None,
            '_wake_event':    None,
        })

    threading.Thread(
        target=_finalize_in_background,
        args=(sid, did, count, se, th, enabled_phases),
        daemon=True,
    ).start()


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', firebase_config=FIREBASE_CONFIG)


@app.route('/api/config')
def get_config():
    return jsonify(FIREBASE_CONFIG)


@app.route('/api/devices')
def list_devices():
    raw = fb_get('devices') or {}
    devices = []
    for device_id, device_data in raw.items():
        if not isinstance(device_data, dict):
            continue
        meta = device_data.get('meta') or {}
        detected_phases = _detect_phases(device_data)
        sensors_raw = meta.get('sensors') or {}
        phases = []
        for phase in detected_phases:
            if isinstance(sensors_raw, dict) and phase in sensors_raw and isinstance(sensors_raw[phase], dict):
                phase_name    = sensors_raw[phase].get('name', phase)
                phase_props   = sensors_raw[phase].get('properties', [])
                phase_enabled = sensors_raw[phase].get('enabled', True)
            else:
                phase_name    = phase
                phase_props   = []
                phase_enabled = True
            phases.append({'phase': phase, 'name': phase_name, 'properties': phase_props, 'enabled': phase_enabled})
        devices.append({
            'id':         device_id,
            'name':       meta.get('name', device_id),
            'online':     meta.get('online', False),
            'lastSeen':   meta.get('lastSeen', '---'),
            'phases':     phases,
            'phaseCount': len(phases),
        })
    devices.sort(key=lambda d: d['id'])

    # Auto-start chart writers for all discovered devices
    for d in devices:
        _ensure_chart_writer(d['id'])

    return jsonify(devices)


@app.route('/api/devices/<device_id>/init-sensors', methods=['POST'])
def init_device_sensors(device_id: str):
    device_data = fb_get(f'devices/{device_id}') or {}
    detected = _detect_phases(device_data)
    count = 0
    for phase in detected:
        existing = fb_get(f'devices/{device_id}/meta/sensors/{phase}')
        if existing is None:
            sensor_data = {
                'name': phase, 'phase': phase, 'properties': [],
                'enabled': True, 'created_at': _ts_now(), 'updated_at': _ts_now(),
            }
            if fb_put(f'devices/{device_id}/meta/sensors/{phase}', sensor_data):
                count += 1
    # Ensure chart writer is running for this device
    _ensure_chart_writer(device_id)
    return jsonify({'ok': True, 'initialized': count, 'device_id': device_id, 'phases': detected})


@app.route('/api/devices/<device_id>/rename', methods=['POST'])
def rename_device(device_id: str):
    body     = request.get_json(silent=True) or {}
    new_name = (body.get('name') or '').strip()
    is_valid, error_msg = validate_device_name(new_name)
    if not is_valid:
        return jsonify({'ok': False, 'error': error_msg}), 400
    ok = fb_patch(f'devices/{device_id}/meta', {'name': new_name})
    if ok:
        return jsonify({'ok': True, 'name': new_name, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan ke Firebase'}), 500


@app.route('/api/devices/<device_id>/sensors/<phase>/rename', methods=['POST'])
def rename_sensor(device_id: str, phase: str):
    phase    = phase.upper()
    body     = request.get_json(silent=True) or {}
    new_name = (body.get('name') or '').strip()
    if not validate_phase_key(phase):
        return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    is_valid, error_msg = validate_device_name(new_name)
    if not is_valid:
        return jsonify({'ok': False, 'error': error_msg}), 400
    current = fb_get(f'devices/{device_id}/meta/sensors/{phase}') or {}
    sensor_data = {
        'name': new_name, 'phase': phase,
        'properties': current.get('properties', []),
        'enabled':    current.get('enabled', True),
        'created_at': current.get('created_at', _ts_now()),
        'updated_at': _ts_now(),
    }
    ok = fb_patch(f'devices/{device_id}/meta/sensors/{phase}', sensor_data)
    if ok:
        return jsonify({'ok': True, 'name': new_name, 'phase': phase, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan ke Firebase'}), 500


@app.route('/api/devices/<device_id>/sensors/<phase>/init', methods=['POST'])
def init_sensor(device_id: str, phase: str):
    phase = phase.upper()
    if not validate_phase_key(phase):
        return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    existing = fb_get(f'devices/{device_id}/meta/sensors/{phase}')
    if existing:
        return jsonify({'ok': True, 'exists': True, 'sensor': existing})
    sensor_data = {
        'name': f'Phase {phase[1:]}', 'phase': phase,
        'properties': [], 'enabled': True, 'created_at': _ts_now(),
    }
    ok = fb_put(f'devices/{device_id}/meta/sensors/{phase}', sensor_data)
    if ok:
        return jsonify({'ok': True, 'sensor': sensor_data, 'timestamp': int(time.time() * 1000)})
    return jsonify({'ok': False, 'error': 'Gagal membuat sensor'}), 500


@app.route('/api/devices/<device_id>/sensors/<phase>/enabled', methods=['POST'])
def set_phase_enabled(device_id: str, phase: str):
    phase = phase.upper()
    if not validate_phase_key(phase):
        return jsonify({'ok': False, 'error': f'Phase tidak valid: {phase}.'}), 400
    body    = request.get_json(silent=True) or {}
    enabled = bool(body.get('enabled', True))
    ok = fb_patch(f'devices/{device_id}/meta/sensors/{phase}', {
        'enabled':    enabled,
        'updated_at': _ts_now(),
    })
    if ok:
        return jsonify({'ok': True, 'phase': phase, 'enabled': enabled})
    return jsonify({'ok': False, 'error': 'Gagal menyimpan'}), 500


@app.route('/api/capture/status')
def capture_status():
    with _capture_lock:
        st = _capture_state
        return jsonify({
            'active':       st['active'],
            'device_id':    st['device_id'],
            'device_name':  st['device_name'],
            'session_id':   st['session_id'],
            'session_name': st['session_name'],
            'interval':     st['interval'],
            'count':        st['count'],
            'started_at':   st['started_at'],
            'finalizing':   st.get('_finalizing', False),
        })


@app.route('/api/capture/start', methods=['POST'])
def capture_start():
    body         = request.get_json(silent=True) or {}
    device_id    = (body.get('deviceId')    or '').strip()
    device_name  = (body.get('deviceName')  or '').strip()
    session_name = (body.get('sessionName') or '').strip() or f'Rekaman {_ts_now()}'
    interval_s   = max(1, int(body.get('interval', 3)))
    phases_hint: list[str] = body.get('phases') or []

    if not device_id:
        return jsonify({'ok': False, 'error': 'deviceId harus diisi'}), 400

    with _capture_lock:
        if _capture_state['active'] or _capture_state.get('_finalizing'):
            return jsonify({'ok': False, 'error': 'Capture sudah berjalan atau sedang finalisasi'}), 409

        session_id = f'session_{int(time.time() * 1000)}'
        now_str    = _ts_now()

        _phases_tmp = sorted(
            [p for p in phases_hint if _PHASE_RE.match(p)],
            key=lambda x: int(x[1:])
        ) or ['L1']

        _phase_names_tmp = {ph: ph for ph in _phases_tmp}

        meta_payload = {
            'id':             session_id,
            'name':           session_name,
            'deviceId':       device_id,
            'deviceName':     device_name or device_id,
            'startTime':      now_str,
            'startTimestamp': int(time.time() * 1000),
            'endTime':        None,
            'recordCount':    0,
            'phaseNames':     _phase_names_tmp,
        }

        _enabled_phases = sorted(
            [p for p in phases_hint if _PHASE_RE.match(p)],
            key=lambda x: int(x[1:])
        ) or None

        _capture_state.update({
            'active':         True,
            'device_id':      device_id,
            'device_name':    device_name or device_id,
            'session_id':     session_id,
            'session_name':   session_name,
            'interval':       interval_s,
            'count':          0,
            'started_at':     now_str,
            'enabled_phases': _enabled_phases,
        })

        def _write_meta_bg():
            try:
                device_data = fb_get(f'devices/{device_id}') or {}
                sensors_raw = (device_data.get('meta') or {}).get('sensors') or {}
                phase_names_real = {
                    ph: (sensors_raw.get(ph) or {}).get('name', ph)
                    for ph in _phases_tmp
                }
                meta_payload['phaseNames'] = phase_names_real
            except Exception:
                pass
            for ph in _phases_tmp:
                fb_put(f'devices/{device_id}/History/{ph}/{session_id}/_meta', meta_payload)

        threading.Thread(target=_write_meta_bg, daemon=True).start()

        def _reset_energy_bg():
            try:
                fb_put(f'devices/{device_id}/Commands/resetEnergy', {
                    'command': True, 'timestamp': int(time.time() * 1000),
                })
                time.sleep(5)
                fb_delete(f'devices/{device_id}/Commands/resetEnergy')
            except Exception as exc:
                print(f'[Capture] Reset energy command failed: {exc}')

        threading.Thread(target=_reset_energy_bg, daemon=True).start()

        _start_thread()

    return jsonify({
        'ok': True,
        'session_id':   session_id,
        'session_name': session_name,
        'device_id':    device_id,
    })


@app.route('/api/capture/stop', methods=['POST'])
def capture_stop():
    with _capture_lock:
        if not _capture_state['active']:
            return jsonify({'ok': False, 'error': 'Tidak ada capture aktif'}), 400
    _stop_and_respond()
    return jsonify({'ok': True})


@app.route('/api/capture/interval', methods=['POST'])
def capture_interval():
    body       = request.get_json(silent=True) or {}
    interval_s = max(1, int(body.get('interval', 3)))
    with _capture_lock:
        _capture_state['interval'] = interval_s
        ev: threading.Event | None = _capture_state.get('_wake_event')
        if ev:
            ev.set()
    return jsonify({'ok': True, 'interval': interval_s})


if __name__ == '__main__':
    # Start chart writers for all existing devices on startup
    threading.Thread(target=_start_all_chart_writers, daemon=True).start()
    app.run(debug=True, host='0.0.0.0', port=5000)