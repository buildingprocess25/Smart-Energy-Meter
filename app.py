from flask import Flask, render_template, jsonify, request
import os
import threading
import time
from datetime import datetime
import requests as http_requests
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# ──────────────────────────────────────────
# Firebase config (sent to browser)
# ──────────────────────────────────────────
FIREBASE_CONFIG = {
    'apiKey':            os.environ.get('FIREBASE_API_KEY'),
    'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN'),
    'databaseURL':       os.environ.get('FIREBASE_DATABASE_URL'),
    'projectId':         os.environ.get('FIREBASE_PROJECT_ID'),
    'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET',
                            f"{os.environ.get('FIREBASE_PROJECT_ID', '')}.appspot.com"),
    'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
    'appId':             os.environ.get('FIREBASE_APP_ID', ''),
}

DB_URL = os.environ.get('FIREBASE_DATABASE_URL', '').rstrip('/')

# ──────────────────────────────────────────
# Firebase REST helpers (no service account needed)
# ──────────────────────────────────────────
def fb_get(path: str):
    """GET a node from Firebase Realtime Database via REST."""
    try:
        r = http_requests.get(f"{DB_URL}/{path}.json", timeout=6)
        return r.json() if r.ok else None
    except Exception as e:
        print(f"[Firebase GET] {path} — {e}")
        return None

def fb_put(path: str, data: dict) -> bool:
    """PUT (set) a node in Firebase Realtime Database via REST."""
    try:
        r = http_requests.put(f"{DB_URL}/{path}.json", json=data, timeout=6)
        return r.ok
    except Exception as e:
        print(f"[Firebase PUT] {path} — {e}")
        return False

def fb_patch(path: str, data: dict) -> bool:
    """PATCH (update) a node in Firebase Realtime Database via REST."""
    try:
        r = http_requests.patch(f"{DB_URL}/{path}.json", json=data, timeout=6)
        return r.ok
    except Exception as e:
        print(f"[Firebase PATCH] {path} — {e}")
        return False

# ──────────────────────────────────────────
# Normalize raw Firebase / PZEM data
# ──────────────────────────────────────────
def normalize(raw: dict) -> dict | None:
    if not raw:
        return None
    try:
        return {
            'Voltage':        float(raw.get('V1', 0)     or 0),
            'Current':        float(raw.get('A1', 0)     or 0),
            'Power':         (float(raw.get('P_SUM', 0)  or 0)) * 1000,
            'Frequency':      float(raw.get('FREQ', 0)   or 0),
            'Apparent':       float(raw.get('S_SUM', 0)  or 0),
            'Reactive':       float(raw.get('Q_SUM', 0)  or 0),
            'Energy':         float(raw.get('WH', 0)     or 0),
            'PowerFactor':    float(raw.get('PF_SUM', 0) or 0),
            'Phase1':         float(raw.get('PHASE1', 0) or 0),
            'EnergyApparent': float(raw.get('SH', 0)     or 0),
            'EnergyReactive': float(raw.get('QH', 0)     or 0),
        }
    except Exception:
        return None

# ──────────────────────────────────────────
# Server-side capture state
# ──────────────────────────────────────────
_capture_lock = threading.Lock()
_capture_state = {
    'active':       False,
    'session_id':   None,
    'session_name': None,
    'interval':     3,      # seconds
    'count':        0,
    'started_at':   None,
    '_thread':      None,
    '_stop_event':  None,   # set() = stop the thread
    '_wake_event':  None,   # set() = interval changed, reschedule (don't capture)
}

def _ts_now() -> str:
    """Return localtime timestamp string matching the front-end format."""
    return datetime.now().strftime('%H:%M:%S %d/%m/%Y')

def _capture_worker(stop_event: threading.Event, wake_event: threading.Event):
    import hashlib, json as _json

    last_raw_hash    = None
    last_change_time = time.time()

    # First capture fires immediately
    next_capture = time.time()

    while not stop_event.is_set():
        sleep_for = max(0.0, next_capture - time.time())

        # Wait until next_capture, stop_event, or wake_event (interval change)
        stop_triggered = stop_event.wait(timeout=min(sleep_for, 0.2))
        if stop_triggered:
            break

        # Check for interval-change signal (non-blocking)
        if wake_event.is_set():
            wake_event.clear()
            with _capture_lock:
                interval = _capture_state['interval']
            # Re-anchor: next capture is interval seconds from now
            next_capture = time.time() + interval
            continue   # go back to sleep, do NOT capture now

        # Not time yet — keep waiting
        if time.time() < next_capture:
            continue

        with _capture_lock:
            if not _capture_state['active']:
                break
            session_id = _capture_state['session_id']
            interval   = _capture_state['interval']

        # Advance schedule BEFORE work so drift never accumulates
        next_capture += interval

        try:
            raw  = fb_get('alat1/RealTime')
            data = normalize(raw)

            # ── Freshness / offline detection ──────────────────────────────
            raw_hash = hashlib.md5(
                _json.dumps(raw, sort_keys=True).encode()
            ).hexdigest() if raw else None

            now = time.time()
            if raw_hash != last_raw_hash:
                last_raw_hash    = raw_hash
                last_change_time = now

            stale_seconds   = now - last_change_time
            stale_threshold = max(interval * 2, 6)
            device_offline  = (
                data is None
                or (data['Voltage'] == 0 and data['Current'] == 0 and data['Power'] == 0)
                or stale_seconds > stale_threshold
            )

            src = data if (data and not device_offline) else None
            ts  = _ts_now()

            if device_offline:
                print(f"[CaptureWorker] OFFLINE (stale={stale_seconds:.1f}s threshold={stale_threshold}s)")

            record = {
                'timestamp':      ts,
                'offline':        device_offline,
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

            key = f"capture_{int(time.time() * 1000)}"
            fb_put(f"alat1/History/{session_id}/{key}", record)

            with _capture_lock:
                _capture_state['count'] += 1

            # If work took longer than interval, skip missed beats and
            # re-anchor so we don't fire multiple times in quick succession.
            now = time.time()
            if next_capture < now:
                missed = int((now - next_capture) / interval) + 1
                next_capture += missed * interval

        except Exception as e:
            print(f"[CaptureWorker] Error: {e}")

    print("[CaptureWorker] Thread exiting.")


def _start_thread():
    stop_event = threading.Event()
    wake_event = threading.Event()
    t = threading.Thread(target=_capture_worker, args=(stop_event, wake_event), daemon=True)
    t.start()
    _capture_state['_thread']     = t
    _capture_state['_stop_event'] = stop_event
    _capture_state['_wake_event'] = wake_event


def _stop_thread_and_finalize():
    """Stop the worker thread and write endTime/_meta back to Firebase."""
    stop_event: threading.Event = _capture_state.get('_stop_event')
    if stop_event:
        stop_event.set()

    thread: threading.Thread = _capture_state.get('_thread')
    if thread and thread.is_alive():
        thread.join(timeout=5)

    session_id = _capture_state['session_id']
    count      = _capture_state['count']
    end_time   = _ts_now()

    if session_id:
        fb_patch(f"alat1/History/{session_id}/_meta", {
            'endTime':     end_time,
            'recordCount': count,
        })

    _capture_state.update({
        'active':       False,
        'session_id':   None,
        'session_name': None,
        'interval':     _capture_state['interval'],   # keep last interval
        'count':        0,
        'started_at':   None,
        '_thread':      None,
        '_stop_event':  None,
        '_wake_event':  None,
    })

# ──────────────────────────────────────────
# Routes — pages
# ──────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html', firebase_config=FIREBASE_CONFIG)

@app.route('/api/config')
def get_config():
    return jsonify(FIREBASE_CONFIG)

# ──────────────────────────────────────────
# Routes — capture control
# ──────────────────────────────────────────
@app.route('/api/capture/status')
def capture_status():
    with _capture_lock:
        st = _capture_state
        return jsonify({
            'active':       st['active'],
            'session_id':   st['session_id'],
            'session_name': st['session_name'],
            'interval':     st['interval'],
            'count':        st['count'],
            'started_at':   st['started_at'],
        })


@app.route('/api/capture/start', methods=['POST'])
def capture_start():
    body = request.get_json(silent=True) or {}
    session_name = (body.get('sessionName') or '').strip() or f"Rekaman {_ts_now()}"
    interval_s   = max(1, int(body.get('interval', 3)))

    with _capture_lock:
        if _capture_state['active']:
            return jsonify({'ok': False, 'error': 'Capture already running'}), 409

        session_id = f"session_{int(time.time() * 1000)}"
        now_str    = _ts_now()

        meta = {
            'id':             session_id,
            'name':           session_name,
            'startTime':      now_str,
            'startTimestamp': int(time.time() * 1000),
            'endTime':        None,
            'recordCount':    0,
        }
        fb_put(f"alat1/History/{session_id}/_meta", meta)

        _capture_state.update({
            'active':       True,
            'session_id':   session_id,
            'session_name': session_name,
            'interval':     interval_s,
            'count':        0,
            'started_at':   now_str,
        })

        # Reset PZEM energy counter BEFORE the thread starts so record 1
        # always sees the already-reset energy value.
        try:
            fb_put('alat1/Commands/resetEnergy', {
                'command': True,
                'timestamp': int(time.time() * 1000)
            })
            # Schedule removal in a daemon thread (non-blocking)
            def _remove_reset():
                time.sleep(5)
                try:
                    import requests as _r
                    _r.delete(f"{DB_URL}/alat1/Commands/resetEnergy.json", timeout=4)
                except Exception:
                    pass
            threading.Thread(target=_remove_reset, daemon=True).start()
        except Exception as e:
            print(f"[Capture] Energy reset failed: {e}")

        _start_thread()

    print(f"[Capture] STARTED — session={session_id}  interval={interval_s}s")
    return jsonify({'ok': True, 'session_id': session_id, 'session_name': session_name})


@app.route('/api/capture/stop', methods=['POST'])
def capture_stop():
    with _capture_lock:
        if not _capture_state['active']:
            return jsonify({'ok': False, 'error': 'No active capture'}), 400

    _stop_thread_and_finalize()
    print("[Capture] STOPPED")
    return jsonify({'ok': True})


@app.route('/api/capture/interval', methods=['POST'])
def capture_interval():
    body       = request.get_json(silent=True) or {}
    interval_s = max(1, int(body.get('interval', 3)))

    with _capture_lock:
        _capture_state['interval'] = interval_s
        ev: threading.Event = _capture_state.get('_wake_event')
        if ev:
            ev.set()   # worker will clear it after waking

    return jsonify({'ok': True, 'interval': interval_s})


# ──────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────
if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)