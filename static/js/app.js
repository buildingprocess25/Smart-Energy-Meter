firebase.initializeApp(firebaseConfig);
const database = firebase.database();
function showGlobalLoader() { const g = document.getElementById('globalLoader'); if(g){ g.style.display = 'flex'; void g.offsetWidth; g.classList.remove('hidden'); } }
function hideGlobalLoader() { const g = document.getElementById('globalLoader'); if(g){ g.classList.add('hidden'); setTimeout(()=>g.classList.contains('hidden')&&(g.style.display='none'), 500); } }
let realtimeData = null;
let rawRealtimeData = null;
let isConnected = false;
let lastDataTimestamp = 0;
let connectionCheckInterval = null;
let selectedDeviceId = '';
let selectedDeviceName = '';
let _deviceListCache = [];
let _prevDeviceId = '';
let currentSessionId = null;
let sessionsData = {};
let _renamingSessionId = null;
let dbSearchQuery = '';
let _renamingDeviceId = null;
let selectedPhase = '';
let hourlyFirebaseData = {};
let _hourlyListenerAttached = null;
let dayFirebaseData = {};
let _dayListenerAttached = null;
let realtimeChart = null;
let selectedParameter = 'voltage';
let timeFilter = 'all';
let chartTargetDate = null;
let _hourlyListenerDate = null;
let _userIsZoomed = false;
let _visiblePoints = 300;
const MAX_DATA_POINTS = 600;
const PARAM_KEYS = ['voltage', 'current', 'power', 'frequency', 'energy', 'powerFactor'];
let phaseChartData = {};
let chartLabels = [];
let chartTimestamps = [];
let _rafId = null;
let _rafDirty = false;
let _pageVisible = !document.hidden;
document.addEventListener('visibilitychange', () => {
    _pageVisible = !document.hidden;
    if (_pageVisible && _rafDirty && timeFilter === 'all') _scheduleRender();
});
function _scheduleRender() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(_doRender);
}
function _doRender() {
    _rafId = null;
    _rafDirty = false;
    if (!realtimeChart || !_pageVisible || timeFilter !== 'all') return;
    const enabledKeys = _getEnabledPhaseKeys();
    const phases = enabledKeys.slice().sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    if (!phases.length) return;
    const total = chartLabels.length;
    if (total === 0) return;
    const visible = Math.min(_visiblePoints, total);
    const start = total - visible;
    realtimeChart.data.labels = chartLabels.slice(start);
    const slicedDatasets = [];
    let mismatch = false;
    phases.forEach((phase, i) => {
        let values = phaseChartData[phase]?.[selectedParameter] || [];
        if (!values.length) values = Array(total).fill(0);
        else if (values.length < total) values = [...Array(total - values.length).fill(0), ...values];
        const sliced = values.slice(start);
        const labelName = getPhaseLabel(phase);
        const ds = realtimeChart.data.datasets.find(d => d.label === labelName);
        if (ds) {
            ds.data = sliced;
            slicedDatasets.push({ data: sliced });
        } else {
            mismatch = true;
        }
    });
    if (mismatch || phases.length !== realtimeChart.data.datasets.length) {
        _rebuildChart();
        return;
    }
    const { yMin, yMax } = getYBoundsMulti(slicedDatasets, selectedParameter);
    realtimeChart.options.scales.y.min = yMin;
    realtimeChart.options.scales.y.max = yMax;
    realtimeChart.update('none');
}
let _rebuildTimer = null;
let _chartEntryAnimate = false;
let _clipPathCleanupId = null;
function _rebuildChart(animate = false) {
    if (_rebuildTimer) {
        clearTimeout(_rebuildTimer);
        _rebuildTimer = null;
    }
    _chartEntryAnimate = animate;
    if (!realtimeChart) {
        initChart();
    } else {
        _morphChartStructure(animate);
    }
    _startAggRebuild();
}
let _lastChartMinute = -1;
let _lastChartHour = -1;
let _lastChartDay = -1;
let _timeWindowCheckId = null;
let _aggRebuildId = null;
const PHASE_COLORS = [
    { line: '#006400', bar: 'rgba(0,100,0,0.85)',   light: 'rgba(0,100,0,0.15)' },    // L1: Dark Green
    { line: '#b38600', bar: 'rgba(179,134,0,0.85)', light: 'rgba(179,134,0,0.15)' },  // L2: Dark Gold
    { line: '#004073', bar: 'rgba(0,64,115,0.85)',  light: 'rgba(0,64,115,0.15)' },   // L3: Deep Blue
    { line: '#333333', bar: 'rgba(51,51,51,0.85)',   light: 'rgba(51,51,51,0.15)' },     // L4
    { line: '#4a2311', bar: 'rgba(74,35,17,0.85)',   light: 'rgba(74,35,17,0.15)' },     // L5
];
function getPhaseColors(phase) {
    const idx = parseInt(phase.slice(1)) - 1;
    return PHASE_COLORS[Math.min(idx, PHASE_COLORS.length - 1)] || PHASE_COLORS[0];
}
function createAreaGradient(ctx, chartArea, color) {
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    const base = color.replace('rgba(', '').replace(')', '').split(',');
    const r = base[0].trim(), g = base[1].trim(), b = base[2].trim();
    gradient.addColorStop(0, `rgba(${r},${g},${b},0.32)`);
    gradient.addColorStop(0.5, `rgba(${r},${g},${b},0.10)`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    return gradient;
}
const crosshairPlugin = {
    id: 'isolarCrosshair',
    afterDraw(chart) {
        const active = chart.tooltip?._active;
        if (!active?.length) return;
        const ctx = chart.ctx;
        const x = active[0].element.x;
        const { top, bottom } = chart.chartArea;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(100,116,139,0.4)';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        if (timeFilter === 'all') {
            active.forEach(pt => {
                ctx.beginPath();
                ctx.arc(pt.element.x, pt.element.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = pt.element.options?.borderColor || '#1677FF';
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.setLineDash([]);
                ctx.fill();
                ctx.stroke();
            });
        }
        ctx.restore();
    },
};
Chart.register(crosshairPlugin);
const _ttDrag = { active: false, offX: 0, offY: 0, pinned: false };
function _initTooltipDrag(el) {
    if (el._dragInit) return;
    el._dragInit = true;
    el.style.cursor = 'grab';
    el.title = 'Drag untuk memindahkan · Klik 2x untuk reset posisi';
    el.addEventListener('dblclick', () => {
        _ttDrag.pinned = false;
        el.style.transition = '';
    });
    el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        _ttDrag.active = true;
        _ttDrag.pinned = false;
        _ttDrag.offX = e.clientX - parseFloat(el.style.left || 0);
        _ttDrag.offY = e.clientY - parseFloat(el.style.top || 0);
        el.style.cursor = 'grabbing';
        el.style.transition = 'none';
        el.style.userSelect = 'none';
        e.stopPropagation();
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!_ttDrag.active) return;
        _ttDrag.pinned = true;
        el.style.left = (e.clientX - _ttDrag.offX) + 'px';
        el.style.top = (e.clientY - _ttDrag.offY) + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!_ttDrag.active) return;
        _ttDrag.active = false;
        el.style.cursor = 'grab';
    });
}
function iSolarTooltipHandler(context) {
    const { chart, tooltip } = context;
    let el = document.getElementById('isc-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'isc-tooltip';
        el.className = 'isc-tooltip';
        document.body.appendChild(el);
        _initTooltipDrag(el);
    }
    if (tooltip.opacity === 0) {
        if (_ttDrag.active || _ttDrag.pinned) return;
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        _ttDrag.pinned = false;
        return;
    }
    const info = PARAM_INFO[selectedParameter];
    const title = tooltip.title?.[0] || '';
    let html = `<div class="isc-tt-header"><span class="isc-tt-clock">🕐</span><span>${title}</span></div><div class="isc-tt-rows">`;
    (tooltip.dataPoints || []).forEach(dp => {
        const val = dp.parsed.y;
        const color = dp.dataset.borderColor || dp.dataset.backgroundColor;
        const label = dp.dataset.label;
        const disp = val != null ? val.toFixed(2) : '—';
        const unit = info.unit || '';
        html += `<div class="isc-tt-row">
            <span class="isc-tt-dot" style="background:${color}"></span>
            <span class="isc-tt-label">${label}</span>
            <span class="isc-tt-val">${disp}<span class="isc-tt-unit">${unit ? ' ' + unit : ''}</span></span>
        </div>`;
    });
    html += '</div>';
    el.innerHTML = html;
    const rect = chart.canvas.getBoundingClientRect();
    const cx = tooltip.caretX;
    const cy = tooltip.caretY;
    const ttW = el.offsetWidth || 190;
    const ttH = el.offsetHeight || 80;
    let left, top;
    if (timeFilter === 'week') {
        left = rect.right + window.scrollX - ttW - 12;
        top = rect.top + window.scrollY + 8;
    } else {
        const spaceR = rect.width - cx;
        const leftBase = spaceR > ttW + 24 ? cx + 16 : cx - ttW - 16;
        let topBase = cy - ttH / 2;
        topBase = Math.max(4, Math.min(topBase, rect.height - ttH - 4));
        left = rect.left + window.scrollX + leftBase;
        top = rect.top + window.scrollY + topBase;
    }
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    el.style.pointerEvents = 'auto';
    if (!_ttDrag.pinned) {
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }
}
function hideIscTooltip() {
    const el = document.getElementById('isc-tooltip');
    if (!el) return;
    if (_ttDrag.active || _ttDrag.pinned) return;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
}
function getPhaseLabel(phase) {
    const dev = _deviceListCache.find(d => d.id === selectedDeviceId);
    const phaseObj = dev?.phases?.find(p => p.phase === phase);
    return phaseObj?.name && phaseObj.name !== phase ? `${phase} (${phaseObj.name})` : phase;
}
const $ = id => document.getElementById(id);
const DOM = {
    get statusDot() { return $('statusDot'); },
    get statusText() { return $('statusText'); },
    get lastUpdate() { return $('lastUpdate'); },
    get captureBtn() { return $('captureBtn'); },
    get historyBody() { return $('historyTableBody'); },
    get historyCount() { return $('historyCount'); },
    get deviceList() { return $('deviceList'); },
    get deviceSelect() { return $('deviceSelect'); },
    get paramSelect() { return $('parameterSelect'); },
    get intervalDisplay() { return $('intervalDisplay'); },
};
function resetChartData() { phaseChartData = {}; chartLabels = []; chartTimestamps = []; resetAggData(); }
function _detectPhaseKeys(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.keys(raw)
        .filter(k => /^L\d+$/.test(k))
        .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
}
function _getEnabledPhaseKeys() {
    const dev = _deviceListCache.find(d => d.id === selectedDeviceId);
    if (!dev?.phases?.length) {
        return Object.keys(phaseChartData).filter(k => /^L\d+$/.test(k));
    }
    return dev.phases
        .filter(p => p.enabled !== false)
        .map(p => p.phase);
}
function normalizeFirebaseData(raw) {
    if (!raw) return null;
    const phases = _detectPhaseKeys(raw);
    if (!phases.length) return null;
    const getVal = (phase, key) =>
        raw[phase] && raw[phase][key] ? parseFloat(raw[phase][key]) || 0 : 0;
    const voltages = phases.map(p => getVal(p, 'Voltage (V)'));
    const currents = phases.map(p => getVal(p, 'Current (A)'));
    const powers = phases.map(p => getVal(p, 'Power (W)'));
    const freqs = phases.map(p => getVal(p, 'Frequency (Hz)'));
    const energies = phases.map(p => getVal(p, 'Active Energy (kWh)'));
    const pfs = phases.map(p => getVal(p, 'Power Factor'));
    const sum = arr => arr.reduce((a, b) => a + b, 0);
    const activePhases = voltages.filter(v => v > 0).length;
    const denom = activePhases > 0 ? activePhases : 1;
    return {
        Voltage: sum(voltages) / denom,
        Current: sum(currents),
        Power: sum(powers),
        Frequency: sum(freqs) / denom,
        Apparent: phases.reduce((s, p) => s + getVal(p, 'Apparent Power (kVA)'), 0),
        Reactive: phases.reduce((s, p) => s + getVal(p, 'Reactive Power (kVAR)'), 0),
        Energy: sum(energies),
        PowerFactor: sum(pfs) / denom,
        Phase1: getVal(phases[0], 'Phase Angle (°)'),
        EnergyApparent: phases.reduce((s, p) => s + getVal(p, 'Apparent Energy (kVAh)'), 0),
        EnergyReactive: phases.reduce((s, p) => s + getVal(p, 'Reactive Energy (kVARh)'), 0),
        DeviceTimestamp: raw.Timestamp || '',
        _phases: phases,
    };
}
function getPhaseDisplayData(raw, phase) {
    if (!raw) return null;
    const phaseData = raw[phase];
    if (!phaseData || typeof phaseData !== 'object') return null;
    const f = key => { try { return parseFloat(phaseData[key] || 0) || 0; } catch (_) { return 0; } };
    return {
        Voltage: f('Voltage (V)'),
        Current: f('Current (A)'),
        Power: f('Power (W)'),
        Frequency: f('Frequency (Hz)'),
        Energy: f('Active Energy (kWh)'),
        PowerFactor: f('Power Factor'),
        Apparent: f('Apparent Power (kVA)'),
        Reactive: f('Reactive Power (kVAR)'),
        Phase1: f('Phase Angle (°)'),
        EnergyApparent: f('Apparent Energy (kVAh)'),
        EnergyReactive: f('Reactive Energy (kVARh)'),
        _phases: [phase],
    };
}
function setPhase(phase) {
    selectedPhase = phase;
    document.querySelectorAll('.phase-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.phase === phase);
    });
    if (rawRealtimeData) {
        const data = getPhaseDisplayData(rawRealtimeData, phase);
        if (data) updateDisplayCards(data);
        else updateDisplayCardsBlank();
    }
}
function updatePhaseSelector(phases) {
    const container = $('phaseSelectorBtns');
    if (!container) return;
    const dev = _deviceListCache.find(d => d.id === selectedDeviceId);
    const enabledPhases = phases.filter(p => {
        const po = dev?.phases?.find(ph => ph.phase === p);
        return !po || po.enabled !== false;
    });
    if (!selectedPhase || !enabledPhases.includes(selectedPhase)) {
        selectedPhase = enabledPhases[0] || '';
    }
    container.innerHTML = enabledPhases.map(p => {
        const phaseObj = dev?.phases?.find(ph => ph.phase === p);
        const label = phaseObj?.name && phaseObj.name !== p
            ? `${p} <span class="phase-btn-sub">${phaseObj.name}</span>`
            : p;
        return `<button class="phase-btn${selectedPhase === p ? ' active' : ''}" data-phase="${p}" onclick="setPhase('${p}')">${label}</button>`;
    }).join('');
}
const _p2 = v => String(v).padStart(2, '0');
function _minKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}T${_p2(d.getHours())}:${_p2(d.getMinutes())}`; }
function _hourKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}T${_p2(d.getHours())}`; }
function _dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`; }
let phaseMinAgg = {};
let phaseHourAgg = {};
let phaseDayAgg = {};
let _prevMinKey = '';
let _prevHourKey = '';
let _prevDayKey = '';
function _ensureAgg(agg, phase, param, key) {
    if (!agg[phase]) agg[phase] = {};
    if (!agg[phase][param]) agg[phase][param] = {};
    if (!agg[phase][param][key]) agg[phase][param][key] = { sum: 0, count: 0 };
}
function _avgOf(agg, phase, param, key) {
    const e = agg[phase]?.[param]?.[key];
    return (e && e.count > 0) ? e.sum / e.count : null;
}
function accumulatePoint(raw) {
    if (!raw) return;
    const now = Date.now();
    const minKey = _minKey(now);
    const hourKey = _hourKey(now);
    const dayKey = _dayKey(now);
    const phases = _detectPhaseKeys(raw);
    if (_prevMinKey && _prevMinKey !== minKey) {
        phases.forEach(phase => {
            PARAM_KEYS.forEach(param => {
                const avg = _avgOf(phaseMinAgg, phase, param, _prevMinKey);
                if (avg === null) return;
                const hk = _prevHourKey || hourKey;
                _ensureAgg(phaseHourAgg, phase, param, hk);
                phaseHourAgg[phase][param][hk].sum += avg;
                phaseHourAgg[phase][param][hk].count += 1;
            });
        });
    }
    if (_prevHourKey && _prevHourKey !== hourKey) {
        phases.forEach(phase => {
            PARAM_KEYS.forEach(param => {
                const avg = _avgOf(phaseHourAgg, phase, param, _prevHourKey);
                if (avg === null) return;
                const dk = _prevDayKey || dayKey;
                _ensureAgg(phaseDayAgg, phase, param, dk);
                phaseDayAgg[phase][param][dk].sum += avg;
                phaseDayAgg[phase][param][dk].count += 1;
            });
        });
        _pruneOldMinAgg();
    }
    _prevMinKey = minKey;
    _prevHourKey = hourKey;
    _prevDayKey = dayKey;
    phases.forEach(phase => {
        const pd = raw[phase] || {};
        const fv = k => { try { return parseFloat(pd[k] || 0) || 0; } catch (_) { return 0; } };
        const vals = {
            voltage: fv('Voltage (V)'),
            current: fv('Current (A)'),
            power: fv('Power (W)'),
            frequency: fv('Frequency (Hz)'),
            energy: fv('Active Energy (kWh)'),
            powerFactor: fv('Power Factor'),
        };
        PARAM_KEYS.forEach(param => {
            _ensureAgg(phaseMinAgg, phase, param, minKey);
            phaseMinAgg[phase][param][minKey].sum += vals[param];
            phaseMinAgg[phase][param][minKey].count += 1;
        });
    });
}
function _pruneOldMinAgg() {
    const cutoff = _minKey(Date.now() - 2 * 3_600_000);
    Object.values(phaseMinAgg).forEach(phaseData =>
        Object.values(phaseData).forEach(paramData =>
            Object.keys(paramData).forEach(k => { if (k < cutoff) delete paramData[k]; })
        )
    );
}
function resetAggData() {
    phaseMinAgg = {};
    phaseHourAgg = {};
    phaseDayAgg = {};
    _prevMinKey = '';
    _prevHourKey = '';
    _prevDayKey = '';
}
function rebuildCascadeFromRaw() {
    resetAggData();
    if (!chartTimestamps.length) return;
    const phases = Object.keys(phaseChartData);
    if (!phases.length) return;
    for (let i = 0; i < chartTimestamps.length; i++) {
        const ts = chartTimestamps[i];
        const mk = _minKey(ts);
        phases.forEach(phase => {
            PARAM_KEYS.forEach(param => {
                const v = phaseChartData[phase]?.[param]?.[i];
                if (v == null || isNaN(v)) return;
                _ensureAgg(phaseMinAgg, phase, param, mk);
                phaseMinAgg[phase][param][mk].sum += v;
                phaseMinAgg[phase][param][mk].count += 1;
            });
        });
    }
    const liveMinKey = _minKey(Date.now());
    phases.forEach(phase => {
        PARAM_KEYS.forEach(param => {
            const minKeys = Object.keys(phaseMinAgg[phase]?.[param] || {});
            minKeys.forEach(mk => {
                if (mk === liveMinKey) return;
                const e = phaseMinAgg[phase][param][mk];
                if (!e || e.count === 0) return;
                const hk = mk.slice(0, 13);
                _ensureAgg(phaseHourAgg, phase, param, hk);
                phaseHourAgg[phase][param][hk].sum += e.sum / e.count;
                phaseHourAgg[phase][param][hk].count += 1;
            });
        });
    });
    const liveHourKey = _hourKey(Date.now());
    phases.forEach(phase => {
        PARAM_KEYS.forEach(param => {
            const hourKeys = Object.keys(phaseHourAgg[phase]?.[param] || {});
            hourKeys.forEach(hk => {
                if (hk === liveHourKey) return;
                const e = phaseHourAgg[phase][param][hk];
                if (!e || e.count === 0) return;
                const dk = hk.slice(0, 10);
                _ensureAgg(phaseDayAgg, phase, param, dk);
                phaseDayAgg[phase][param][dk].sum += e.sum / e.count;
                phaseDayAgg[phase][param][dk].count += 1;
            });
        });
    });
    const now = Date.now();
    _prevMinKey = _minKey(now);
    _prevHourKey = _hourKey(now);
    _prevDayKey = _dayKey(now);
}
function getHourlyFirebaseData(phase, param) {
    const targetDateObj = chartTargetDate ? new Date(chartTargetDate + 'T00:00:00') : new Date();
    const todayDate = new Date();
    todayDate.setHours(0,0,0,0);
    const isToday = targetDateObj.getTime() === todayDate.getTime();
    
    const targetStr = `${targetDateObj.getFullYear()}-${_p2(targetDateObj.getMonth() + 1)}-${_p2(targetDateObj.getDate())}`;
    const endHour = isToday ? new Date().getHours() : 23;
    const endMin = isToday ? (Math.floor(new Date().getMinutes() / 5) * 5) : 55;
    
    const fieldMap = {
        voltage: 'Voltage',
        current: 'Current',
        power: 'Power',
        frequency: 'Frequency',
        energy: 'Energy',
        powerFactor: 'PowerFactor',
    };
    const field = fieldMap[param] || 'Voltage';
    const labels = [], values = [];
    
    for (let h = 0; h <= endHour; h++) {
        const maxMin = (h === endHour) ? endMin : 55;
        for (let m = 0; m <= maxMin; m += 5) {
            const key = `${_p2(h)}${_p2(m)}`;
            const rec = hourlyFirebaseData[phase]?.[key];
            labels.push(`${_p2(h)}:${_p2(m)}`);
            if (rec && rec.date === targetStr && rec[field] != null) {
                values.push(parseFloat(parseFloat(rec[field]).toFixed(4)));
            } else {
                values.push(0);
            }
        }
    }
    return { labels, values };
}
function _attachHourlyListener(deviceId) {
    if (_hourlyListenerAttached === deviceId && _hourlyListenerDate === chartTargetDate) {
        if (timeFilter === 'day' && realtimeChart) {
            _refreshDayChartFromFirebase();
        }
        return;
    }
    if (_hourlyListenerAttached) {
        const oldTarget = _hourlyListenerDate || new Date().toISOString().split('T')[0];
        database.ref(`devices/${_hourlyListenerAttached}/HourlyCapture/${oldTarget}`).off();
    }
    _hourlyListenerAttached = deviceId;
    _hourlyListenerDate = chartTargetDate;
    hourlyFirebaseData = {};
    const targetDate = chartTargetDate || new Date().toISOString().split('T')[0];
    
    database.ref(`devices/${deviceId}/HourlyCapture/${targetDate}`).on('value', snap => {
        hourlyFirebaseData = {};
        if (snap.exists()) {
            snap.forEach(phaseSnap => {
                const phase = phaseSnap.key;
                if (!/^L\d+$/.test(phase)) return;
                hourlyFirebaseData[phase] = {};
                phaseSnap.forEach(hourSnap => {
                    hourlyFirebaseData[phase][hourSnap.key] = hourSnap.val();
                });
            });
        }
        if (timeFilter === 'day') {
            if (realtimeChart) {
                _refreshDayChartFromFirebase();
            } else {
                setTimeout(() => _refreshDayChartFromFirebase(), 200);
            }
        }
    });
}
function _refreshDayChartFromFirebase() {
    if (!realtimeChart || timeFilter !== 'day') return;
    const { labels, datasets } = getAllPhaseDatasets();
    realtimeChart.data.labels = labels;
    realtimeChart.data.datasets = datasets;
    const { yMin, yMax } = getYBoundsMulti(datasets, selectedParameter);
    realtimeChart.options.scales.y.min = yMin;
    realtimeChart.options.scales.y.max = yMax;
    realtimeChart.update('none');
}
function _attachDayListener(deviceId) {
    if (_dayListenerAttached === deviceId) {
        if (timeFilter === 'week' && realtimeChart) _refreshWeekChartFromFirebase();
        return;
    }
    if (_dayListenerAttached) {
        database.ref(`devices/${_dayListenerAttached}/DayCapture`).off();
    }
    _dayListenerAttached = deviceId;
    dayFirebaseData = {};
    database.ref(`devices/${deviceId}/DayCapture`).on('value', snap => {
        dayFirebaseData = {};
        if (snap.exists()) {
            snap.forEach(phaseSnap => {
                const phase = phaseSnap.key;
                if (!/^L\d+$/.test(phase)) return;
                dayFirebaseData[phase] = {};
                phaseSnap.forEach(daySnap => {
                    dayFirebaseData[phase][daySnap.key] = daySnap.val();
                });
            });
        }
        if (timeFilter === 'week') {
            if (realtimeChart) _refreshWeekChartFromFirebase();
            else setTimeout(() => _refreshWeekChartFromFirebase(), 200);
        }
    });
}
function _refreshWeekChartFromFirebase() {
    if (!realtimeChart || timeFilter !== 'week') return;
    const { labels, datasets } = getAllPhaseDatasets();
    realtimeChart.data.labels = labels;
    realtimeChart.data.datasets = datasets;
    const { yMin, yMax } = getYBoundsMulti(datasets, selectedParameter);
    realtimeChart.options.scales.y.min = yMin;
    realtimeChart.options.scales.y.max = yMax;
    realtimeChart.update('none');
}
function getDayViewData(phase, param) {
    const fieldMap = {
        voltage: 'Voltage', current: 'Current', power: 'Power',
        frequency: 'Frequency', energy: 'Energy', powerFactor: 'PowerFactor',
    };
    const field = fieldMap[param] || 'Voltage';
    const phaseRec = dayFirebaseData[phase] || {};
    
    const targetDateObj = chartTargetDate ? new Date(chartTargetDate + 'T00:00:00') : new Date();
    const daysArr = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(targetDateObj);
        d.setDate(d.getDate() - i);
        daysArr.push(`${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`);
    }
    
    const labels = [], values = [];
    daysArr.forEach(dateKey => {
        const [, m, dStr] = dateKey.split('-');
        labels.push(`${dStr}/${m}`);
        const rec = phaseRec[dateKey];
        if (rec && rec[field] != null) {
            values.push(parseFloat(parseFloat(rec[field]).toFixed(4)));
        } else {
            values.push(0);
        }
    });
    return { labels, values };
}
function getAggregatedDataForPhase(phase, param) {
    if (timeFilter === 'all') return { labels: chartLabels, values: phaseChartData[phase]?.[param] || [] };
    if (timeFilter === 'day') return getHourlyFirebaseData(phase, param);
    return getDayViewData(phase, param);
}
const MODAL_ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
};
function showModal(title, message, type = 'info', buttons = ['ok']) {
    return new Promise(resolve => {
        $('modalTitle').textContent = title;
        $('modalMessage').textContent = message;
        const iconEl = $('modalIcon');
        iconEl.className = 'modal-icon ' + type;
        iconEl.innerHTML = MODAL_ICONS[type] || MODAL_ICONS.info;
        const btnsEl = $('modalButtons');
        btnsEl.innerHTML = '';
        if (buttons.includes('confirm')) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-secondary';
            cancelBtn.textContent = 'BATAL';
            cancelBtn.onclick = () => { closeModal(); resolve(false); };
            btnsEl.appendChild(cancelBtn);
        }
        const primaryBtn = document.createElement('button');
        primaryBtn.className = 'modal-btn modal-btn-primary';
        primaryBtn.textContent = buttons.includes('confirm') ? 'YA, LANJUTKAN' : 'OK';
        primaryBtn.onclick = () => { closeModal(); resolve(true); };
        btnsEl.appendChild(primaryBtn);
        $('customModal').classList.add('active');
        document.body.style.overflow = 'hidden';
    });
}
function closeModal() {
    $('customModal').classList.remove('active');
    document.body.style.overflow = '';
}
document.addEventListener('click', e => { if (e.target === $('customModal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
const CARD_IDS = ['voltage', 'current', 'power', 'frequency', 'energy', 'powerFactor'];
const CARD_DEC = { voltage: 1, current: 2, power: 1, frequency: 1, energy: 3, powerFactor: 3 };
function updateDisplayCards(data) {
    const fmt = (v, d) => (v != null && !isNaN(v)) ? parseFloat(v).toFixed(d) : '---';
    CARD_IDS.forEach(id => {
        const el = $(id);
        if (el) el.textContent = fmt(data[id.charAt(0).toUpperCase() + id.slice(1)], CARD_DEC[id]);
    });
    if (DOM.lastUpdate) {
        DOM.lastUpdate.textContent = 'Last update: ' + new Date().toLocaleTimeString('id-ID')
            + (selectedPhase ? ` · ${selectedPhase}` : '');
    }
}
function updateDisplayCardsBlank() {
    CARD_IDS.forEach(id => { const el = $(id); if (el) el.textContent = '---'; });
    if (DOM.lastUpdate) DOM.lastUpdate.textContent = '--- Device offline ---';
}
const PARAM_INFO = {
    voltage: { label: 'Voltage', unit: 'V', color: '#FFA500', border: '#FF8C00' },
    current: { label: 'Current', unit: 'A', color: '#0066CC', border: '#0052A3' },
    power: { label: 'Power', unit: 'W', color: '#00A651', border: '#008040' },
    frequency: { label: 'Frequency', unit: 'Hz', color: '#6B46C1', border: '#5A3AA0' },
    energy: { label: 'Energy', unit: 'kWh', color: '#00A651', border: '#008040' },
    powerFactor: { label: 'Power Factor', unit: '', color: '#6B46C1', border: '#5A3AA0' },
};
function updateDateNavigatorUI() {
    const nav = document.getElementById('chartDateNav');
    const label = document.getElementById('isolarDateLabel');
    const hiddenDate = document.getElementById('chartHiddenDate');
    if (!nav || !label || !hiddenDate) return;

    if (timeFilter === 'all') {
        nav.style.display = 'none';
        return;
    }
    nav.style.display = 'flex';

    if (!chartTargetDate) {
        chartTargetDate = new Date().toLocaleDateString('en-CA');
    }

    const todayDate = new Date();
    const minDate = new Date();
    minDate.setDate(todayDate.getDate() - 30);
    hiddenDate.min = minDate.toLocaleDateString('en-CA');
    hiddenDate.max = todayDate.toLocaleDateString('en-CA');
    hiddenDate.value = chartTargetDate;

    const targetDateObj = new Date(chartTargetDate + 'T00:00:00');
    
    if (timeFilter === 'day') {
        const d = String(targetDateObj.getDate()).padStart(2, '0');
        const m = String(targetDateObj.getMonth() + 1).padStart(2, '0');
        const y = targetDateObj.getFullYear();
        label.innerText = `${d}/${m}/${y}`;
    } else if (timeFilter === 'week') {
        const startDateObj = new Date(targetDateObj);
        startDateObj.setDate(startDateObj.getDate() - 6);
        const sd = String(startDateObj.getDate()).padStart(2, '0');
        const sm = String(startDateObj.getMonth() + 1).padStart(2, '0');
        const sy = startDateObj.getFullYear();
        const ed = String(targetDateObj.getDate()).padStart(2, '0');
        const em = String(targetDateObj.getMonth() + 1).padStart(2, '0');
        const ey = targetDateObj.getFullYear();
        label.innerText = `${sd}/${sm}/${sy} - ${ed}/${em}/${ey}`;
    }
}

function openNativeDatePicker() {
    const hiddenDate = document.getElementById('chartHiddenDate');
    if (hiddenDate && hiddenDate.showPicker) {
        hiddenDate.showPicker();
    }
}

function onHiddenDateChange() {
    const hiddenDate = document.getElementById('chartHiddenDate');
    if (!hiddenDate || !hiddenDate.value) return;
    chartTargetDate = hiddenDate.value;
    updateDateNavigatorUI();
    
    if (timeFilter === 'day' && selectedDeviceId) _attachHourlyListener(selectedDeviceId);
    if (timeFilter === 'week' && selectedDeviceId && realtimeChart) _refreshWeekChartFromFirebase();
}

function shiftChartDate(daysDirection) {
    if (!chartTargetDate) return;
    const targetDateObj = new Date(chartTargetDate + 'T00:00:00');
    
    let shiftAmount = daysDirection;
    if (timeFilter === 'week') {
        shiftAmount = daysDirection * 7;
    }
    
    targetDateObj.setDate(targetDateObj.getDate() + shiftAmount);
    
    const todayDate = new Date();
    todayDate.setHours(0,0,0,0);
    if (targetDateObj > todayDate) return;
    
    const minDate = new Date();
    minDate.setDate(todayDate.getDate() - 30);
    minDate.setHours(0,0,0,0);
    if (targetDateObj < minDate) return;
    
    chartTargetDate = targetDateObj.toLocaleDateString('en-CA');
    updateDateNavigatorUI();
    
    if (timeFilter === 'day' && selectedDeviceId) _attachHourlyListener(selectedDeviceId);
    if (timeFilter === 'week' && selectedDeviceId && realtimeChart) _refreshWeekChartFromFirebase();
}

function setTimeFilter(filter) {
    if (timeFilter === filter) return;
    timeFilter = filter;
    
    updateDateNavigatorUI();
    
    _userIsZoomed = false;
    _visiblePoints = filter === 'day' ? 24 : (filter === 'week' ? 7 : 300);
    document.querySelectorAll('.time-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    const now = new Date();
    _lastChartMinute = now.getMinutes();
    _lastChartHour = now.getHours();
    _lastChartDay = now.getDate();
    if (filter === 'day' && selectedDeviceId) _attachHourlyListener(selectedDeviceId);
    if (filter === 'week' && selectedDeviceId) _attachDayListener(selectedDeviceId);
    
    _rebuildChart(true);
}
function _startAggRebuild() {
    if (_aggRebuildId) { clearInterval(_aggRebuildId); _aggRebuildId = null; }
    if (timeFilter === 'day') {
        setTimeout(() => _refreshDayChartFromFirebase(), 150);
        _aggRebuildId = setInterval(() => {
            if (realtimeChart) _refreshDayChartFromFirebase();
        }, 30_000);
        return;
    }
    if (timeFilter === 'week') {
        setTimeout(() => _refreshWeekChartFromFirebase(), 150);
        _aggRebuildId = setInterval(() => {
            if (realtimeChart) _refreshWeekChartFromFirebase();
        }, 300_000);
    }
}
function _checkTimeWindowChange() {
    const now = new Date();
    const m = now.getMinutes();
    const h = now.getHours();
    const day = now.getDate();
    if (timeFilter === 'day') {
        if (_lastChartDay !== -1 && day !== _lastChartDay) {
            hourlyFirebaseData = {};
            _rebuildChart();
        }
        else if (_lastChartMinute !== -1 &&
            Math.floor(m / 5) !== Math.floor(_lastChartMinute / 5) &&
            realtimeChart) {
            _refreshDayChartFromFirebase();
        }
    } else if (timeFilter === 'week') {
        if (_lastChartDay !== -1 && day !== _lastChartDay) {
            _refreshWeekChartFromFirebase();
        }
    }
    _lastChartMinute = m;
    _lastChartHour = h;
    _lastChartDay = day;
}
function startTimeWindowMonitoring() {
    if (_timeWindowCheckId) clearInterval(_timeWindowCheckId);
    const now = new Date();
    _lastChartMinute = now.getMinutes();
    _lastChartHour = now.getHours();
    _lastChartDay = now.getDate();
    _startAggRebuild();
    _timeWindowCheckId = setInterval(_checkTimeWindowChange, 5_000);
}
function getAllPhaseDatasets() {
    const enabledKeys = _getEnabledPhaseKeys();
    const isBar = timeFilter === 'week';
    const allPhases = enabledKeys.slice().sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    if (!allPhases.length) return { labels: [], datasets: [] };

    let labels;
    let getValues;

    if (isBar) {
        // WEEK mode: build a CANONICAL 7-day date array so all phases share the same X-axis
        const targetDateObj = chartTargetDate ? new Date(chartTargetDate + 'T00:00:00') : new Date();
        const canonicalDates = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(targetDateObj);
            d.setDate(d.getDate() - i);
            canonicalDates.push(`${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`);
        }
        labels = canonicalDates.map(dk => { const [, m, day] = dk.split('-'); return `${day}/${m}`; });

        const fieldMap = {
            voltage: 'Voltage', current: 'Current', power: 'Power',
            frequency: 'Frequency', energy: 'Energy', powerFactor: 'PowerFactor',
        };
        const field = fieldMap[selectedParameter] || 'Voltage';

        // Per-phase value lookup against the canonical date grid
        getValues = (phase) => {
            const phaseRec = dayFirebaseData[phase] || {};
            return canonicalDates.map(dk => {
                const rec = phaseRec[dk];
                return (rec && rec[field] != null) ? parseFloat(parseFloat(rec[field]).toFixed(4)) : 0;
            });
        };
    } else {
        // DAY / ALL mode: keep existing behaviour
        let maxLabels = [];
        for (const ph of allPhases) {
            const ag = getAggregatedDataForPhase(ph, selectedParameter);
            if (ag.labels && ag.labels.length > maxLabels.length) maxLabels = ag.labels;
        }
        labels = maxLabels;
        getValues = (phase) => {
            let { values } = getAggregatedDataForPhase(phase, selectedParameter);
            if (!values || values.length === 0) return Array(labels.length).fill(0);
            if (values.length < labels.length) return [...Array(labels.length - values.length).fill(0), ...values];
            return values;
        };
    }

    const datasets = allPhases.map(phase => {
        const colors = getPhaseColors(phase);
        const values = getValues(phase);
        const bgFn = isBar
            ? colors.bar
            : (context) => {
                const ch = context.chart;
                if (!ch.chartArea) return colors.light;
                return createAreaGradient(ch.ctx, ch.chartArea, colors.light);
            };
        const isDayLine = !isBar && timeFilter === 'day';
        return {
            label: getPhaseLabel(phase),
            data: values,
            borderColor: colors.line,
            backgroundColor: bgFn,
            borderWidth: isDayLine ? 2 : (isBar ? 0 : 2.5),
            tension: isDayLine ? 0.4 : 0.38,
            cubicInterpolationMode: 'monotone',
            spanGaps: !isBar,
            fill: !isBar,
            pointRadius: isDayLine ? 0 : 0,
            pointHoverRadius: isDayLine ? 5 : 0,
            pointBackgroundColor: colors.line,
            pointBorderColor: '#fff',
            pointBorderWidth: isDayLine ? 2 : 0,
            borderRadius: isBar ? [6, 6, 0, 0] : 0,
            borderSkipped: false,
            ...(isBar ? { barPercentage: 0.55, categoryPercentage: 0.7 } : {}),
        };
    });
    return { labels, datasets };
}
function getYBoundsMulti(datasets, param) {
    const padMap = { voltage: 3, current: 0.2, power: 10, frequency: 0.2, energy: 0.05, powerFactor: 0.02 };
    const pad = padMap[param] ?? 2;
    const allValues = datasets.flatMap(ds => ds.data).filter(v => v != null && isFinite(v));
    if (!allValues.length) return { yMin: undefined, yMax: undefined };
    const dataMin = Math.min(...allValues), dataMax = Math.max(...allValues);
    const spread = dataMax - dataMin;
    const actualPad = spread < pad ? pad : spread * 0.08;
    return { yMin: parseFloat((dataMin - actualPad).toFixed(4)), yMax: parseFloat((dataMax + actualPad).toFixed(4)) };
}
function initChart() {
    const ctx = $('realtimeChart');
    if (!ctx) return;
    const info = PARAM_INFO[selectedParameter];
    const isBar = timeFilter === 'week';
    const now = new Date();
    const xTitles = {
        all: '',
        day: `Hari ini — ${now.toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })} (Hourly)`,
        week: '7 Hari Terakhir',
    };
    const unitLabel = info.unit ? `${info.label} (${info.unit})` : info.label;
    let initLabels, initDatasets;
    if (timeFilter === 'all') {
        const total = chartLabels.length;
        const visible = Math.min(_visiblePoints, total);
        const start = Math.max(0, total - visible);
        const enabledKeys = _getEnabledPhaseKeys();
        const phases = enabledKeys.slice().sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        initLabels = chartLabels.slice(start);
        initDatasets = phases.map(phase => {
            const colors = getPhaseColors(phase);
            let values = phaseChartData[phase]?.[selectedParameter] || [];
            if (!values.length) values = Array(total).fill(0);
            else if (values.length < total) values = [...Array(total - values.length).fill(0), ...values];
            values = values.slice(start);
            return {
                label: getPhaseLabel(phase),
                data: values,
                borderColor: colors.line,
                backgroundColor: (context) => {
                    const ch = context.chart;
                    if (!ch.chartArea) return colors.light;
                    return createAreaGradient(ch.ctx, ch.chartArea, colors.light);
                },
                borderWidth: 2.5,
                tension: 0.38,
                cubicInterpolationMode: 'monotone',
                spanGaps: true,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0,
            };
        });
    } else {
        const built = getAllPhaseDatasets();
        initLabels = built.labels;
        initDatasets = built.datasets;
    }
    const { yMin, yMax } = getYBoundsMulti(initDatasets, selectedParameter);
    const maxTicksMap = { all: 10, day: 12, week: 7 };
    realtimeChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        data: { labels: initLabels, datasets: initDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            animation: _chartEntryAnimate ? {
                duration: 800,
                easing: 'easeOutQuint',
                onComplete({ chart }) {
                    if (timeFilter === 'all') {
                        chart.options.animation = false;
                        chart.options.animations = {};
                    }
                },
            } : false,
            animations: _chartEntryAnimate ? {
                y: {
                    duration: 800,
                    easing: 'easeOutQuint',
                    from(ctx) {
                        return ctx.chart.scales?.y?.getPixelForValue(0) ?? 0;
                    },
                },
            } : {},
            layout: { padding: { top: 8, right: 16, bottom: 2, left: 4 } },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'start',
                    labels: {
                        font: { family: "'DM Sans','Segoe UI',sans-serif", size: 11.5, weight: '600' },
                        color: '#374151',
                        usePointStyle: true,
                        pointStyle: isBar ? 'rectRounded' : 'circle',
                        pointStyleWidth: 10,
                        padding: 20,
                        boxHeight: 8,
                        generateLabels(chart) {
                            const orig = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                            return orig.map(item => ({
                                ...item,
                                fillStyle: chart.data.datasets[item.datasetIndex]?.borderColor || item.fillStyle,
                                strokeStyle: 'transparent',
                            }));
                        },
                    },
                },
                tooltip: {
                    enabled: false,
                    external: iSolarTooltipHandler,
                    mode: 'index',
                    intersect: false,
                },
                zoom: {
                    zoom: {
                        wheel: { enabled: timeFilter !== 'all', speed: 0.08 },
                        pinch: { enabled: timeFilter !== 'all' },
                        mode: 'x',
                        onZoom: ({ chart }) => {
                            if (timeFilter === 'all') {
                                const { min, max } = chart.scales.x;
                                _visiblePoints = Math.max(10, Math.min(MAX_DATA_POINTS, Math.round(max - min + 1)));
                                try { chart.resetZoom('none'); } catch (_) { }
                            } else {
                                _userIsZoomed = true;
                            }
                        },
                    },
                    pan: {
                        enabled: true,
                        mode: 'x',
                        onPan: ({ chart }) => {
                            if (timeFilter === 'all') {
                                const { min, max } = chart.scales.x;
                                _visiblePoints = Math.max(10, Math.min(MAX_DATA_POINTS, Math.round(max - min + 1)));
                                try { chart.resetZoom('none'); } catch (_) { }
                            } else {
                                _userIsZoomed = true;
                            }
                        },
                    },
                    limits: { x: { minRange: 2 } },
                },
            },
            scales: {
                x: {
                    display: true,
                    border: { display: false },
                    title: {
                        display: !!(xTitles[timeFilter]),
                        text: xTitles[timeFilter] || '',
                        font: { size: 10, weight: '600', family: "'DM Sans','Segoe UI',sans-serif" },
                        color: '#9CA3AF',
                        padding: { top: 6 },
                    },
                    grid: {
                        color: 'rgba(226,232,240,0.8)',
                        drawTicks: false,
                        lineWidth: 1,
                    },
                    ticks: {
                        maxRotation: 0,
                        minRotation: 0,
                        font: { size: 10.5, family: "'DM Sans','Segoe UI',sans-serif" },
                        color: '#9CA3AF',
                        maxTicksLimit: maxTicksMap[timeFilter] ?? 10,
                        padding: 8,
                        autoSkip: true,
                        autoSkipPadding: timeFilter === 'day' ? 16 : 24,
                    },
                    offset: isBar,
                },
                y: {
                    display: true,
                    position: 'left',
                    border: { display: false },
                    title: {
                        display: true,
                        text: unitLabel,
                        font: { size: 10, weight: '600', family: "'DM Sans','Segoe UI',sans-serif" },
                        color: '#9CA3AF',
                        padding: { bottom: 8 },
                    },
                    grid: {
                        color: 'rgba(226,232,240,0.8)',
                        drawTicks: false,
                        lineWidth: 1,
                    },
                    ticks: {
                        font: { size: 10.5, family: "'DM Sans','Segoe UI',sans-serif" },
                        color: '#9CA3AF',
                        padding: 12,
                        maxTicksLimit: 6,
                        callback: v => {
                            if (v == null) return '';
                            if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
                            return parseFloat(v.toFixed(3)).toString();
                        },
                    },
                    min: yMin,
                    max: yMax,
                },
            },
        },
    });
    if (_clipPathCleanupId) {
        clearTimeout(_clipPathCleanupId);
        _clipPathCleanupId = null;
    }
    if (!isBar && _chartEntryAnimate) {
        _chartEntryAnimate = false;
        const container = ctx.parentElement;
        container.style.transition = 'none';
        container.style.clipPath = '';
        void container.offsetWidth;
        container.style.clipPath = 'inset(0 100% 0 0)';
        void container.offsetWidth;
        container.style.transition = 'clip-path 0.9s cubic-bezier(0.4, 0, 0.2, 1)';
        container.style.clipPath = 'inset(0 0% 0 0)';
        _clipPathCleanupId = setTimeout(() => {
            container.style.transition = '';
            container.style.clipPath = '';
            _clipPathCleanupId = null;
        }, 950);
    }
    ctx.addEventListener('mouseleave', () => {
        if (!_ttDrag.active && !_ttDrag.pinned) hideIscTooltip();
    });
}
const CHART_INTERVAL_MS = 1000;
let _chartTimer = null;
function _chartZeroPoint() {
    return {
        'Voltage (V)': 0, 'Current (A)': 0, 'Power (W)': 0,
        'Frequency (Hz)': 0, 'Active Energy (kWh)': 0, 'Power Factor': 0,
        'Apparent Power (kVA)': 0, 'Reactive Power (kVAR)': 0,
        'Phase Angle (°)': 0, 'Apparent Energy (kVAh)': 0, 'Reactive Energy (kVARh)': 0,
    };
}
function _chartPush() {
    const ts = Date.now();
    const online = isConnected && !!rawRealtimeData;
    let phases = online ? _detectPhaseKeys(rawRealtimeData) : _getEnabledPhaseKeys();
    if (!phases.length) phases = ['L1'];
    const point = { ts };
    phases.forEach(ph => {
        point[ph] = (online && rawRealtimeData[ph]) ? rawRealtimeData[ph] : _chartZeroPoint();
    });
    _appendChartPoint(point);
    const raw = _rebuildRawFromPoint(point);
    if (raw) accumulatePoint(raw);
    _rafDirty = true;
    if (_pageVisible && timeFilter === 'all') _scheduleRender();
}
function _chartInit(deviceId) {
    if (_chartTimer) { clearInterval(_chartTimer); _chartTimer = null; }
    resetChartData();
    const now = Date.now();
    let phases = _getEnabledPhaseKeys();
    if (!phases.length) {
        const dev = _deviceListCache.find(d => d.id === deviceId);
        phases = (dev?.phases || []).filter(p => p.enabled !== false).map(p => p.phase);
    }
    if (!phases.length) phases = ['L1'];
    for (let ts = now - _visiblePoints * CHART_INTERVAL_MS; ts <= now; ts += CHART_INTERVAL_MS) {
        const point = { ts };
        phases.forEach(ph => { point[ph] = _chartZeroPoint(); });
        _appendChartPoint(point);
    }
    rebuildCascadeFromRaw();
    _rebuildChart();
    _chartTimer = setInterval(() => { if (selectedDeviceId === deviceId) _chartPush(); }, CHART_INTERVAL_MS);
}
function _rebuildRawFromPoint(point) {
    if (!point) return null;
    const phases = Object.keys(point).filter(k => /^L\d+$/.test(k));
    if (!phases.length) return null;
    const raw = {};
    phases.forEach(ph => { raw[ph] = point[ph]; });
    return raw;
}
function _appendChartPoint(point) {
    if (!point || !point.ts) return;
    const ts = point.ts;
    const phases = Object.keys(point).filter(k => /^L\d+$/.test(k));
    if (!phases.length) return;
    const label = new Date(ts).toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    chartLabels.push(label);
    chartTimestamps.push(ts);
    const fv = (pd, k) => { try { return parseFloat(pd[k] || 0) || 0; } catch (_) { return 0; } };
    phases.forEach(phase => {
        if (!phaseChartData[phase]) {
            phaseChartData[phase] = Object.fromEntries(PARAM_KEYS.map(k => [k, []]));
        }
        const pd = point[phase] || {};
        phaseChartData[phase].voltage.push(fv(pd, 'Voltage (V)'));
        phaseChartData[phase].current.push(fv(pd, 'Current (A)'));
        phaseChartData[phase].power.push(fv(pd, 'Power (W)'));
        phaseChartData[phase].frequency.push(fv(pd, 'Frequency (Hz)'));
        phaseChartData[phase].energy.push(fv(pd, 'Active Energy (kWh)'));
        phaseChartData[phase].powerFactor.push(fv(pd, 'Power Factor'));
    });
    if (chartLabels.length > MAX_DATA_POINTS) {
        chartLabels.shift();
        chartTimestamps.shift();
        phases.forEach(ph => {
            PARAM_KEYS.forEach(k => { phaseChartData[ph]?.[k]?.shift(); });
        });
    }
}
function updateChart(raw) { }
function changeParameter() { _switchParameter(DOM.paramSelect?.value); }
function _switchParameter(param) {
    if (!param) return;
    selectedParameter = param;
    _userIsZoomed = false;
    _visiblePoints = timeFilter === 'day' ? 24 : (timeFilter === 'week' ? 7 : 150);
    if (DOM.paramSelect) DOM.paramSelect.value = param;
    document.querySelectorAll('.metric-card-compact').forEach(card => {
        card.classList.toggle('card-active', card.dataset.param === param);
    });
    _rebuildChart(true);
}
function _morphChartStructure(animate = true) {
    if (!realtimeChart) { initChart(); return; }
    const isBar = timeFilter === 'week';
    realtimeChart.config.type = isBar ? 'bar' : 'line';
    if (timeFilter === 'all') {
        const total = chartLabels.length;
        const visible = Math.min(_visiblePoints, total);
        const start = Math.max(0, total - visible);
        const enabledKeys = _getEnabledPhaseKeys();
        const phases = enabledKeys.slice().sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        realtimeChart.data.labels = chartLabels.slice(start);
        realtimeChart.data.datasets = phases.map(phase => {
            const colors = getPhaseColors(phase);
            let values = phaseChartData[phase]?.[selectedParameter] || [];
            if (!values.length) values = Array(total).fill(0);
            else if (values.length < total) values = [...Array(total - values.length).fill(0), ...values];
            values = values.slice(start);
            return {
                label: getPhaseLabel(phase),
                data: values,
                borderColor: colors.line,
                backgroundColor: (context) => {
                    const ch = context.chart;
                    if (!ch.chartArea) return colors.light;
                    return createAreaGradient(ch.ctx, ch.chartArea, colors.light);
                },
                borderWidth: 2.5,
                tension: 0.38,
                cubicInterpolationMode: 'monotone',
                spanGaps: true,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 0,
            };
        });
    } else {
        const built = getAllPhaseDatasets();
        realtimeChart.data.labels = built.labels;
        realtimeChart.data.datasets = built.datasets;
    }
    const { yMin, yMax } = getYBoundsMulti(realtimeChart.data.datasets, selectedParameter);
    realtimeChart.options.scales.y.min = yMin;
    realtimeChart.options.scales.y.max = yMax;
    if (animate) {
        realtimeChart.options.animation = { duration: 750, easing: 'easeOutQuart' };
    } else {
        realtimeChart.options.animation = false;
    }
    realtimeChart.update();
    if (animate && timeFilter === 'all') {
        setTimeout(() => {
            if (realtimeChart) realtimeChart.options.animation = false;
        }, 800);
    }
}
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    $(`${tabName}Tab`)?.classList.add('active');
    $(`${tabName}Content`)?.classList.add('active');
    if (tabName === 'history') loadDevices().then(() => buildSessionUI());
}
async function loadDevices() {
    try {
        const devices = await fetch('/api/devices').then(r => r.json());
        devices.forEach(d => {
            const cached = _deviceListCache.find(c => c.id === d.id);
            if (cached?.phases) {
                d.phases.forEach(p => {
                    const cp = cached.phases.find(c => c.phase === p.phase);
                    if (cp !== undefined) p.enabled = cp.enabled !== false;
                });
            }
        });
        _deviceListCache = devices;
        const visible = devices;
        if (!visible.length) return;
        
        const initialLoad = !selectedDeviceId;
        if (initialLoad) {
            selectedDeviceId = visible[0].id;
            selectedDeviceName = visible[0].name || visible[0].id;
        }
        const activeDev = visible.find(d => d.id === selectedDeviceId);
        if (!initialLoad && activeDev) {
            selectedDeviceName = activeDev.name || activeDev.id;
        }

        if (initialLoad && activeDev) {
            isConnected = !!activeDev.online;
            lastDataTimestamp = isConnected ? Date.now() : 0;
            updateConnectionStatus(isConnected);
            _attachRealtimeListener(selectedDeviceId);
            _attachHistoryListener(selectedDeviceId);
            _attachHourlyListener(selectedDeviceId);
            _attachDayListener(selectedDeviceId);
        }

        _populateDeviceSelect(visible);
        if (activeDev) {
            renderDeviceList([activeDev]);
            if (activeDev.phases?.length) {
                const enabledPhases = activeDev.phases.filter(p => p.enabled !== false).map(p => p.phase);
                updatePhaseSelector(enabledPhases);
            }
        } else {
            renderDeviceList([]);
        }
    } catch (e) { }
}
function _populateDeviceSelect(devices) {
    const sel = DOM.deviceSelect;
    if (!sel) return;
    const currentVal = sel.value || selectedDeviceId;
    sel.innerHTML = devices.map(d =>
        `<option value="${d.id}"${d.id === currentVal ? ' selected' : ''}>${d.name || d.id}</option>`
    ).join('');
}
function renderDeviceList(devices) {
    const container = DOM.deviceList;
    if (!container) return;
    if (!devices.length) {
        container.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px;padding:8px 0">Belum ada device terdaftar</p>';
        return;
    }
    const editSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const checkSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
    const closeSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    container.innerHTML = devices.map(d => {
        const dotClass = d.online ? 'online' : 'offline';
        const phasesHTML = (d.phases && d.phases.length > 0)
            ? d.phases.map(p => {
                const isEnabled = p.enabled !== false;
                return `
            <div class="device-phase-item${isEnabled ? '' : ' phase-disabled'}" id="phase-item_${d.id}_${p.phase}">
                <div class="device-phase-view" id="phase-view_${d.id}_${p.phase}">
                    <label class="phase-toggle-wrap" title="${isEnabled ? 'Nonaktifkan' : 'Aktifkan'} fase ini" onclick="event.stopPropagation()">
                        <input type="checkbox" class="phase-toggle-cb" ${isEnabled ? 'checked' : ''}
                            onchange="togglePhaseEnabled('${d.id}','${p.phase}',this.checked)">
                        <span class="phase-toggle-track"></span>
                    </label>
                    <div class="device-phase-badge" style="${isEnabled ? '' : 'opacity:.4'}">${p.phase}</div>
                    <div class="device-phase-info">
                        <p class="device-phase-name" id="phase-label_${d.id}_${p.phase}" style="${isEnabled ? '' : 'opacity:.45;text-decoration:line-through'}">${p.name || p.phase}</p>
                        <p class="device-phase-status">${isEnabled ? '<span style="color:var(--green);font-weight:700">● Aktif</span>' : '<span style="color:var(--text-tertiary)">○ Nonaktif</span>'}</p>
                    </div>
                    <button class="device-phase-edit-btn" onclick="startRenamePhase('${d.id}','${p.phase}')" title="Ubah nama fase">${editSVG}</button>
                </div>
                <div class="device-phase-edit" id="phase-edit_${d.id}_${p.phase}" style="display:none">
                    <div class="device-phase-info">
                        <div class="device-phase-edit-field">
                            <input type="text" class="device-phase-rename-input" id="phase-rename_${d.id}_${p.phase}"
                                value="${p.name || p.phase}" maxlength="40" autocomplete="off"
                                onkeydown="if(event.key==='Enter') savePhaseRename('${d.id}','${p.phase}'); else if(event.key==='Escape') cancelRenamePhase('${d.id}','${p.phase}')">
                        </div>
                    </div>
                    <div class="device-phase-actions">
                        <button class="device-confirm-btn" onclick="savePhaseRename('${d.id}','${p.phase}')" title="Simpan">${checkSVG}</button>
                        <button class="device-cancel-btn"  onclick="cancelRenamePhase('${d.id}','${p.phase}')" title="Batal">${closeSVG}</button>
                    </div>
                </div>
            </div>`;
            }).join('')
            : '<p style="font-size:11px;color:var(--text-tertiary);padding:4px 0">Mendeteksi phase…</p>';
        return `
        <div class="device-item" id="device-item_${d.id}">
            <div class="device-view-mode" id="view_${d.id}">
                <div class="device-item-info">
                    <span class="device-online-dot ${dotClass}"></span>
                    <div>
                        <p class="device-item-name" id="label_${d.id}">${d.name || d.id}</p>
                        <p class="device-item-id">${d.phaseCount || 0} phase · Last seen: ${d.lastSeen || '---'}</p>
                    </div>
                </div>
                <button class="device-edit-btn" onclick="startRenameDevice('${d.id}')" title="Ubah nama">${editSVG}</button>
            </div>
            <div class="device-edit-mode" id="edit_${d.id}" style="display:none">
                <div class="device-item-info">
                    <span class="device-online-dot ${dotClass}"></span>
                    <div class="device-edit-field">
                        <input type="text" class="device-rename-input-inline" id="rename_${d.id}"
                            value="${d.name || d.id}" maxlength="40" autocomplete="off"
                            onkeydown="if(event.key==='Enter') saveDeviceName('${d.id}'); else if(event.key==='Escape') cancelRenameDevice('${d.id}')">
                        <p class="device-edit-hint"><kbd>Enter</kbd> simpan &nbsp;·&nbsp; <kbd>Esc</kbd> batal</p>
                    </div>
                </div>
                <div class="device-edit-actions">
                    <button class="device-confirm-btn" onclick="saveDeviceName('${d.id}')"     title="Simpan">${checkSVG}</button>
                    <button class="device-cancel-btn"  onclick="cancelRenameDevice('${d.id}')" title="Batal">${closeSVG}</button>
                </div>
            </div>
            <div class="device-phases-container">${phasesHTML}</div>
        </div>`;
    }).join('');
}
function startRenameDevice(deviceId) {
    _renamingDeviceId = deviceId;
    $(`view_${deviceId}`).style.display = 'none';
    $(`edit_${deviceId}`).style.display = 'flex';
    const input = $(`rename_${deviceId}`);
    input.focus(); input.select();
}
function cancelRenameDevice(deviceId) {
    _renamingDeviceId = null;
    const label = $(`label_${deviceId}`), input = $(`rename_${deviceId}`);
    if (label && input) input.value = label.textContent;
    $(`edit_${deviceId}`).style.display = 'none';
    $(`view_${deviceId}`).style.display = 'flex';
    input.disabled = false;
}
async function saveDeviceName(deviceId) {
    const input = $(`rename_${deviceId}`);
    const newName = input?.value.trim();
    if (!newName) { await showModal('Error', 'Nama tidak boleh kosong', 'warning'); return; }
    if (newName.length < 2) { await showModal('Error', 'Nama minimal 2 karakter', 'warning'); return; }
    if (newName.length > 100) { await showModal('Error', 'Nama maksimal 100 karakter', 'warning'); return; }
    if (/[\/\.\$\#\[\]]/.test(newName)) { await showModal('Error', 'Karakter tidak diizinkan: / . $ # [ ]', 'warning'); return; }
    const oldName = _deviceListCache.find(d => d.id === deviceId)?.name || deviceId;
    const dev = _deviceListCache.find(d => d.id === deviceId);
    if (dev) dev.name = newName;
    const label = $(`label_${deviceId}`);
    if (label) label.textContent = newName;
    if (deviceId === selectedDeviceId) {
        selectedDeviceName = newName;
        const sel = DOM.deviceSelect;
        if (sel) Array.from(sel.options).forEach(opt => { if (opt.value === deviceId) opt.text = newName; });
    }
    _renamingDeviceId = null;
    cancelRenameDevice(deviceId);
    showModal('Berhasil', `Nama device diubah menjadi:\n"${newName}"`, 'success');
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(`/api/devices/${deviceId}/rename`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }), signal: controller.signal,
        });
        clearTimeout(tid);
        if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || `HTTP ${response.status}`); }
        const json = await response.json();
        if (!json.ok) throw new Error(json.error || 'Gagal menyimpan ke Firebase');
    } catch (e) {
        if (dev) dev.name = oldName;
        if (label) label.textContent = oldName;
        if (deviceId === selectedDeviceId) {
            selectedDeviceName = oldName;
            const sel = DOM.deviceSelect;
            if (sel) Array.from(sel.options).forEach(opt => { if (opt.value === deviceId) opt.text = oldName; });
        }
        closeModal();
        await showModal('Error', e.name === 'AbortError' ? 'Request timeout (8s) - Periksa koneksi internet' : 'Gagal menyimpan: ' + e.message, 'error');
    }
}
async function onDeviceChange(deviceId) {
    if (!deviceId || deviceId === selectedDeviceId) return;
    if (_prevDeviceId) {
        database.ref(`devices/${_prevDeviceId}/RealTime`).off();
        database.ref(`devices/${_prevDeviceId}/History`).off();
        database.ref(`devices/${_prevDeviceId}/meta/name`).off();
        database.ref(`devices/${_prevDeviceId}/meta/sensors`).off();
        database.ref(`devices/${_prevDeviceId}/HourlyCapture`).off();
        database.ref(`devices/${_prevDeviceId}/DayCapture`).off();
        _hourlyListenerAttached = null;
        _dayListenerAttached = null;
        hourlyFirebaseData = {};
        dayFirebaseData = {};
    }
    if (_chartTimer) { clearInterval(_chartTimer); _chartTimer = null; }
    selectedDeviceId = deviceId;
    selectedDeviceName = _deviceListCache.find(d => d.id === deviceId)?.name || deviceId;
    selectedPhase = '';
    updatePhaseSelector([]);
    resetChartData();
    rawRealtimeData = null;
    initChart();
    updateConnectionStatus('connecting');
    updateDisplayCardsBlank();
    lastDataTimestamp = 0;
    historyData = []; recordsBySession = {}; sessionsData = {};
    buildSessionUI();
    fetch(`/api/devices/${deviceId}/init-sensors`, { method: 'POST' })
        .then(r => r.json()).then(json => { if (json.phases) loadDevices(); }).catch(() => { });
    _attachRealtimeListener(deviceId);
    _attachHistoryListener(deviceId);
    _attachDeviceNameListener(deviceId);
    _attachPhasesListener(deviceId);
    _attachHourlyListener(deviceId);
    _attachDayListener(deviceId);
    const activeDev = _deviceListCache.find(d => d.id === deviceId);
    if (activeDev) renderDeviceList([activeDev]);
}
function startRenamePhase(deviceId, phase) {
    const id = `${deviceId}_${phase}`;
    $(`phase-view_${id}`).style.display = 'none';
    $(`phase-edit_${id}`).style.display = 'flex';
    const input = $(`phase-rename_${id}`);
    input.focus(); input.select();
}
function cancelRenamePhase(deviceId, phase) {
    const id = `${deviceId}_${phase}`;
    const label = $(`phase-label_${id}`), input = $(`phase-rename_${id}`);
    if (label && input) input.value = label.textContent;
    $(`phase-edit_${id}`).style.display = 'none';
    $(`phase-view_${id}`).style.display = 'flex';
    input.disabled = false;
}
async function savePhaseRename(deviceId, phase) {
    const id = `${deviceId}_${phase}`;
    const input = $(`phase-rename_${id}`);
    const newName = input?.value.trim();
    if (!newName) { await showModal('Error', 'Nama tidak boleh kosong', 'warning'); return; }
    if (newName.length < 2) { await showModal('Error', 'Nama minimal 2 karakter', 'warning'); return; }
    if (newName.length > 40) { await showModal('Error', 'Nama maksimal 40 karakter', 'warning'); return; }
    if (/[\/\.\$\#\[\]]/.test(newName)) { await showModal('Error', 'Karakter tidak diizinkan: / . $ # [ ]', 'warning'); return; }
    const dev = _deviceListCache.find(d => d.id === deviceId);
    const phaseObj = dev?.phases?.find(p => p.phase === phase);
    const oldName = phaseObj?.name || phase;
    if (phaseObj) phaseObj.name = newName;
    const label = $(`phase-label_${id}`);
    if (label) label.textContent = newName;
    cancelRenamePhase(deviceId, phase);
    if (dev?.phases) updatePhaseSelector(dev.phases.map(p => p.phase));
    if ($('historyContent')?.classList.contains('active')) buildSessionUI();
    showModal('Berhasil', `Fase ${phase} diubah menjadi:\n"${newName}"`, 'success');
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(`/api/devices/${deviceId}/sensors/${phase}/rename`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }), signal: controller.signal,
        });
        clearTimeout(tid);
        if (!response.ok) { const e = await response.json().catch(() => ({})); throw new Error(e.error || `HTTP ${response.status}`); }
        const json = await response.json();
        if (!json.ok) throw new Error(json.error || 'Gagal menyimpan');
    } catch (e) {
        if (phaseObj) phaseObj.name = oldName;
        if (label) label.textContent = oldName;
        if (dev?.phases) updatePhaseSelector(dev.phases.map(p => p.phase));
        if ($('historyContent')?.classList.contains('active')) buildSessionUI();
        closeModal();
        await showModal('Error', e.name === 'AbortError' ? 'Request timeout (8s) - Periksa koneksi' : 'Gagal menyimpan: ' + e.message, 'error');
    }
}
async function togglePhaseEnabled(deviceId, phase, enabled) {
    const dev = _deviceListCache.find(d => d.id === deviceId);
    const phaseObj = dev?.phases?.find(p => p.phase === phase);
    if (!enabled && dev?.phases) {
        const stillEnabled = dev.phases.filter(p => p.phase !== phase && p.enabled !== false);
        if (stillEnabled.length === 0) {
            const cb = document.querySelector(`#phase-item_${deviceId}_${phase} .phase-toggle-cb`);
            if (cb) cb.checked = true;
            await showModal('Tidak Diizinkan', 'Minimal satu fase harus tetap aktif.', 'warning');
            return;
        }
    }
    if (phaseObj) phaseObj.enabled = enabled;
    const item = $(`phase-item_${deviceId}_${phase}`);
    if (item) item.classList.toggle('phase-disabled', !enabled);
    const badge = item?.querySelector('.device-phase-badge');
    if (badge) badge.style.opacity = enabled ? '' : '0.4';
    const nameEl = $(`phase-label_${deviceId}_${phase}`);
    if (nameEl) {
        nameEl.style.opacity = enabled ? '' : '0.45';
        nameEl.style.textDecoration = enabled ? '' : 'line-through';
    }
    const statusEl = item?.querySelector('.device-phase-status');
    if (statusEl) statusEl.innerHTML = enabled
        ? '<span style="color:var(--green);font-weight:700">● Aktif</span>'
        : '<span style="color:var(--text-tertiary)">○ Nonaktif</span>';
    if (deviceId === selectedDeviceId && dev?.phases) {
        const enabledPhases = dev.phases.filter(p => p.enabled !== false).map(p => p.phase);
        updatePhaseSelector(enabledPhases);
    }
    if (deviceId === selectedDeviceId) {
        _rebuildChart();
    }
    try {
        await fetch(`/api/devices/${deviceId}/sensors/${phase}/enabled`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
    } catch (e) {
        if (phaseObj) phaseObj.enabled = !enabled;
        const cb = document.querySelector(`#phase-item_${deviceId}_${phase} .phase-toggle-cb`);
        if (cb) cb.checked = !enabled;
        if (deviceId === selectedDeviceId) _rebuildChart();
    }
}
function _attachRealtimeListener(deviceId) {
    _prevDeviceId = deviceId;
    _chartInit(deviceId);
    let _firstSnap = true;
    let _lastPhaseCount = Object.keys(phaseChartData).filter(k => /^L\d+$/.test(k)).length;
    database.ref(`devices/${deviceId}/RealTime`).on('value', snapshot => {
        if (!snapshot.exists()) { updateConnectionStatus(false); return; }
        const raw = snapshot.val();
        const data = normalizeFirebaseData(raw);
        if (!data) { updateConnectionStatus(false); return; }
        if (_firstSnap) { _firstSnap = false; return; }
        const isZero = data.Voltage === 0 && data.Current === 0 && data.Power === 0;
        if (isZero) { updateConnectionStatus(false); return; }
        const currentPhaseCount = (data._phases || []).length;
        if (currentPhaseCount !== _lastPhaseCount && currentPhaseCount > 0) {
            _lastPhaseCount = currentPhaseCount;
            updatePhaseSelector(data._phases || []);
            fetch(`/api/devices/${deviceId}/init-sensors`, { method: 'POST' })
                .then(r => r.json()).then(() => loadDevices()).catch(() => { });
        }
        lastDataTimestamp = Date.now();
        rawRealtimeData = raw;
        realtimeData = data;
        isConnected = true;
        if (selectedPhase) {
            const displayData = getPhaseDisplayData(raw, selectedPhase);
            if (displayData) updateDisplayCards(displayData);
            else updateDisplayCardsBlank();
        }
        updateConnectionStatus(true);
    }, () => updateConnectionStatus(false));
}
function updateConnectionStatus(connected) {
    const dot = DOM.statusDot, txt = DOM.statusText;
    if (!dot || !txt) return;
    if (connected === 'connecting') {
        dot.className = 'status-dot connecting';
        txt.textContent = 'CONNECTING';
        return;
    }
    dot.className = 'status-dot ' + (connected ? 'online' : 'offline');
    txt.textContent = connected ? 'ONLINE' : 'OFFLINE';
    if (!connected) updateDisplayCardsBlank();
}
function checkDataFreshness() {
    const age = Date.now() - lastDataTimestamp;
    if (isConnected && (lastDataTimestamp === 0 || age > 3000)) {
        isConnected = false; realtimeData = null; rawRealtimeData = null;
        updateConnectionStatus(false);
    }
}
function startConnectionMonitoring() {
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(checkDataFreshness, 2000);
}
function onDbSearchInput(value) {
    dbSearchQuery = value.trim().toLowerCase();
    $('dbSearchClear')?.classList.toggle('visible', dbSearchQuery.length > 0);
    buildSessionUI();
}
function clearDbSearch() {
    const input = $('dbSearchInput');
    if (input) input.value = '';
    dbSearchQuery = '';
    $('dbSearchClear')?.classList.remove('visible');
    buildSessionUI();
    input?.focus();
}
let historyData = [], recordsBySession = {};
function _attachHistoryListener(deviceId) {
    database.ref(`devices/${deviceId}/History`).on('value', snap => {
        historyData = []; recordsBySession = {}; sessionsData = {};
        if (snap.exists()) {
            snap.forEach(phaseSnap => {
                const phase = phaseSnap.key;
                if (!/^L\d+$/.test(phase)) return;
                phaseSnap.forEach(sessionSnap => {
                    const sid = sessionSnap.key;
                    if (!recordsBySession[sid]) recordsBySession[sid] = {};
                    if (!recordsBySession[sid][phase]) recordsBySession[sid][phase] = [];
                    sessionSnap.forEach(recordSnap => {
                        if (recordSnap.key === '_meta') {
                            const meta = { ...recordSnap.val(), id: sid };
                            const existing = sessionsData[sid];
                            if (!existing || (!existing.name && meta.name) || (!existing.startTime && meta.startTime)) {
                                sessionsData[sid] = meta;
                            }
                            return;
                        }
                        const record = { ...recordSnap.val(), sessionId: sid, _phase: phase, _key: recordSnap.key };
                        historyData.push(record);
                        recordsBySession[sid][phase].push(record);
                    });
                });
            });
        }
        buildSessionUI();
    });
}
function _attachDeviceNameListener(deviceId) {
    database.ref(`devices/${deviceId}/meta/name`).on('value', snapshot => {
        if (!snapshot.exists()) return;
        const newName = snapshot.val().toString().trim();
        if (!newName || newName === selectedDeviceName) return;
        selectedDeviceName = newName;
        const dev = _deviceListCache.find(d => d.id === deviceId);
        if (dev) dev.name = newName;
        const sel = DOM.deviceSelect;
        if (sel) Array.from(sel.options).forEach(opt => { if (opt.value === deviceId) opt.text = newName; });
        const label = $(`label_${deviceId}`);
        if (label) label.textContent = newName;
    });
}
function _attachPhasesListener(deviceId) {
    database.ref(`devices/${deviceId}/meta/sensors`).on('value', snapshot => {
        if (!snapshot.exists()) return;
        const sensorsData = snapshot.val();
        const dev = _deviceListCache.find(d => d.id === deviceId);
        if (!dev) return;
        const phaseKeys = Object.keys(sensorsData)
            .filter(k => /^L\d+$/.test(k))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        dev.phases = phaseKeys.map(phase => ({
            phase,
            name: sensorsData[phase]?.name || phase,
            properties: sensorsData[phase]?.properties || [],
            enabled: sensorsData[phase]?.enabled !== false,
        }));
        dev.phaseCount = dev.phases.length;
        if (deviceId === selectedDeviceId) {
            const enabledPhases = dev.phases.filter(p => p.enabled).map(p => p.phase);
            updatePhaseSelector(enabledPhases);
        }
        const visible = _deviceListCache.filter(d => d.id !== 'alat1');
        renderDeviceList(visible);
        if ($('historyContent')?.classList.contains('active')) buildSessionUI();
    });
}
function parseTimestamp(ts) {
    try {
        const [time, date] = ts.split(' ');
        const [h, m, s] = time.split(':').map(Number);
        const [d, mo, y] = date.split('/').map(Number);
        return new Date(y, mo - 1, d, h, m, s);
    } catch (_) { return new Date(); }
}
function _escapeAttr(s) { return (s || '').replace(/'/g, "\\'"); }
function _highlight(text) {
    if (!dbSearchQuery) return text;
    return text.replace(new RegExp(`(${dbSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="search-highlight">$1</mark>');
}
function buildSessionUI() {
    const allSessions = Object.values(sessionsData).sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0));
    const filtered = dbSearchQuery ? allSessions.filter(s => (s.name || s.id || '').toLowerCase().includes(dbSearchQuery)) : allSessions;
    if (DOM.historyCount) {
        DOM.historyCount.textContent = dbSearchQuery
            ? `${filtered.length} dari ${allSessions.length} sesi · ${historyData.length} total record`
            : `${allSessions.length} sesi · ${historyData.length} total record`;
    }
    const tbody = DOM.historyBody;
    if (!tbody) return;
    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">${dbSearchQuery ? 'Tidak ada sesi yang cocok.' : 'Belum ada data rekaman'}</td></tr>`;
        return;
    }
    const openSessions = new Set();
    const openPhases = new Set();
    document.querySelectorAll('.session-detail-row').forEach(row => { if (row.style.display !== 'none') openSessions.add(row.id.replace('detail_', '')); });
    document.querySelectorAll('[id^="phase-detail_"]').forEach(el => { if (el.style.display !== 'none') openPhases.add(el.id.replace('phase-detail_', '')); });
    const editingPhases = new Map();
    document.querySelectorAll('[id^="sph-edit_"]').forEach(el => {
        if (el.style.display !== 'none') {
            const key = el.id.replace('sph-edit_', '');
            const inputEl = document.getElementById('sph-input_' + key);
            editingPhases.set(key, inputEl ? inputEl.value : '');
        }
    });
    tbody.innerHTML = filtered.map(session => {
        const frozenNames = session.phaseNames || {};
        const recordedPhaseKeys = Object.keys(recordsBySession[session.id] || {})
            .filter(k => /^L\d+$/.test(k))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        const phaseSourceKeys = recordedPhaseKeys.length > 0
            ? recordedPhaseKeys
            : Object.keys(frozenNames)
                .filter(k => /^L\d+$/.test(k))
                .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
        const dev2 = _deviceListCache.find(d => d.id === selectedDeviceId);
        const phases = phaseSourceKeys.map(ph => {
            const cachedName = dev2?.phases?.find(p => p.phase === ph)?.name;
            return { phase: ph, name: frozenNames[ph] || cachedName || ph };
        });
        const allPhaseRecords = Object.values(recordsBySession[session.id] || {}).flat();
        const isActive = session.id === currentSessionId && captureActive;
        let actionBtns = `
            <button class="session-rename-btn" onclick="openChangeTimeModal('${session.id}','${session.startTime}','${_escapeAttr(session.name)}',event)" title="Ubah Waktu" style="color:var(--text-secondary)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </button>`;
        if (!isActive) {
            actionBtns += `
            <button class="session-export-btn" onclick="exportSession('${session.id}','${_escapeAttr(session.name)}',event)" title="Export">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
            <button class="session-rename-btn" onclick="openRenameModal('${session.id}','${_escapeAttr(session.name)}',event)" title="Rename">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="session-delete-btn" onclick="deleteSession('${session.id}','${_escapeAttr(session.name)}',event)" title="Hapus">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6m4-6v6"></path></svg>
            </button>`;
        }
        const phaseBlocks = phases.map(p => `
            <div class="session-phase-block" id="phase-block_${session.id}_${p.phase}">
                <div class="session-phase-header" id="sph-view_${session.id}_${p.phase}"
                    style="display:flex;gap:12px;align-items:center;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);cursor:pointer;user-select:none"
                    onclick="togglePhaseDetails('${session.id}','${p.phase}')">
                    <span id="chevron_${session.id}_${p.phase}" style="font-size:11px;color:var(--text-tertiary)">▶</span>
                    <span style="display:inline-flex;width:26px;height:26px;background:var(--blue);color:white;border-radius:6px;align-items:center;justify-content:center;font-weight:700;font-size:11px">${p.phase}</span>
                    <span id="sph-label_${session.id}_${p.phase}" style="flex:1;font-size:13px;font-weight:600;color:var(--text-primary)">${p.name}</span>
                    <span style="font-size:11px;color:var(--text-tertiary)">${(recordsBySession[session.id]?.[p.phase] || []).length} record</span>
                    ${!isActive ? `<button class="sph-edit-btn" title="Ubah nama fase"
                        onclick="event.stopPropagation();startRenameSessionPhase('${session.id}','${p.phase}')"
                        style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:1.5px solid transparent;background:transparent;color:var(--text-tertiary);cursor:pointer;flex-shrink:0;opacity:0;transition:opacity .15s ease,background .15s ease,border-color .15s ease;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>` : ''}
                </div>
                <div class="session-phase-header" id="sph-edit_${session.id}_${p.phase}"
                    style="display:none;gap:10px;align-items:center;padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);border-top:2px solid var(--blue);">
                    <span style="display:inline-flex;width:26px;height:26px;background:var(--blue);color:white;border-radius:6px;align-items:center;justify-content:center;font-weight:700;font-size:11px;flex-shrink:0">${p.phase}</span>
                    <input id="sph-input_${session.id}_${p.phase}" type="text"
                        value="${p.name}" maxlength="40" autocomplete="off"
                        style="flex:1;font-size:13px;font-weight:500;color:var(--text-primary);background:transparent;border:none;border-bottom:2px solid var(--blue);border-radius:0;outline:none;padding:2px 4px 4px;caret-color:var(--blue);font-family:var(--font-ui);"
                        onkeydown="if(event.key==='Enter'){event.preventDefault();saveRenameSessionPhase('${session.id}','${p.phase}');}else if(event.key==='Escape'){cancelRenameSessionPhase('${session.id}','${p.phase}');}">
                    <div style="display:flex;gap:5px;flex-shrink:0">
                        <button onclick="saveRenameSessionPhase('${session.id}','${p.phase}')" title="Simpan"
                            style="width:30px;height:30px;border-radius:6px;border:none;background:var(--green);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>
                        </button>
                        <button onclick="cancelRenameSessionPhase('${session.id}','${p.phase}')" title="Batal"
                            style="width:30px;height:30px;border-radius:6px;border:none;background:rgba(0,0,0,0.06);color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                </div>
                <div id="phase-detail_${session.id}_${p.phase}" style="display:none">
                    ${(() => {
                const pr = (recordsBySession[session.id]?.[p.phase] || []).slice().sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));
                return `<table class="data-table inner-table" style="width:100%;margin:0;border-radius:0">
                        <thead><tr><th>Timestamp</th><th>Voltage (V)</th><th>Current (A)</th><th>Power (W)</th><th>Frequency (Hz)</th><th>Energy (kWh)</th><th>PF</th></tr></thead>
                        <tbody>${pr.length ? pr.map(e => {
                    const pfColor = e.offline ? '#9CA3AF' : (e.PowerFactor >= 0.85 ? '#00A651' : '#ED1C24');
                    const offTag = e.offline ? ' <span style="color:#9CA3AF;font-size:9px;font-weight:700">[offline]</span>' : '';
                    return '<tr class="inner-record-row"' + (e.offline ? ' style="opacity:0.5;font-style:italic"' : '') + '>'
                        + '<td>' + e.timestamp + offTag + '</td>'
                        + '<td>' + (e.Voltage != null ? e.Voltage.toFixed(2) : '---') + '</td>'
                        + '<td>' + (e.Current != null ? e.Current.toFixed(2) : '---') + '</td>'
                        + '<td>' + (e.Power != null ? e.Power.toFixed(2) : '---') + '</td>'
                        + '<td>' + (e.Frequency != null ? e.Frequency.toFixed(2) : '---') + '</td>'
                        + '<td>' + (e.Energy != null ? e.Energy.toFixed(3) : '---') + '</td>'
                        + '<td style="color:' + pfColor + '">' + (e.PowerFactor != null ? e.PowerFactor.toFixed(3) : '---') + '</td>'
                        + '</tr>';
                }).join('') : '<tr><td colspan="7" class="loading-cell" style="padding:20px !important">Belum ada record</td></tr>'}</tbody>
                        </table>`;
            })()}
                </div>
            </div>`).join('');
        return `
        <tr class="session-row${isActive ? ' session-active' : ''}" onclick="toggleSessionDetail('${session.id}')">
            <td class="session-toggle-cell">
                <span class="session-chevron" id="chevron_${session.id}">&#9658;</span>
                <span class="session-id-badge" title="${session.id}">${session.id.replace('session_', '')}</span>
            </td>
            <td class="session-name-cell">
                <span class="session-name">${_highlight(session.name || 'Tanpa nama')}</span>
                ${session.deviceName && session.deviceName !== session.deviceId ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:4px">· ${session.deviceName}</span>` : ''}
                ${isActive ? '<span class="session-live-badge">&#9679; LIVE</span>' : ''}
            </td>
            <td>${session.startTime || '---'}</td>
            <td>${isActive ? '<span style="color:#00A651;font-weight:700">Sedang berlangsung...</span>' : (session.endTime || '---')}</td>
            <td style="text-align:right;padding-right:16px">
                <div class="session-actions">
                    <span class="record-count-badge">${allPhaseRecords.length} record</span>
                    ${actionBtns}
                </div>
            </td>
        </tr>
        <tr class="session-detail-row" id="detail_${session.id}" style="display:none">
            <td colspan="5" style="padding:0">
                <div style="background:var(--surface);border-top:1px solid var(--border)">
                    ${phaseBlocks || '<div style="padding:16px;font-size:12px;color:var(--text-tertiary)">Tidak ada fase terdeteksi</div>'}
                </div>
            </td>
        </tr>`;
    }).join('');
    openSessions.forEach(sid => {
        const detail = $(`detail_${sid}`), chevron = $(`chevron_${sid}`);
        if (detail) detail.style.display = 'table-row';
        if (chevron) chevron.textContent = '\u25BC';
    });
    openPhases.forEach(key => {
        const detail = $(`phase-detail_${key}`), chevron = $(`chevron_${key}`);
        if (detail) detail.style.display = 'block';
        if (chevron) chevron.textContent = '\u25BC';
    });
    editingPhases.forEach((inputValue, key) => {
        const viewEl = document.getElementById('sph-view_' + key);
        const editEl = document.getElementById('sph-edit_' + key);
        const inputEl = document.getElementById('sph-input_' + key);
        if (!editEl) return;
        if (viewEl) viewEl.style.display = 'none';
        editEl.style.display = 'flex';
        if (inputEl) {
            inputEl.value = inputValue;
            inputEl.focus();
            const len = inputValue.length;
            inputEl.setSelectionRange(len, len);
        }
    });
}
function toggleSessionDetail(sessionId) {
    const detail = $(`detail_${sessionId}`), chevron = $(`chevron_${sessionId}`);
    if (!detail) return;
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'table-row';
    if (chevron) chevron.textContent = isOpen ? '\u25B6' : '\u25BC';
}
function togglePhaseDetails(sessionId, phase) {
    const detail = $(`phase-detail_${sessionId}_${phase}`), chevron = $(`chevron_${sessionId}_${phase}`);
    if (!detail) return;
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'block';
    if (chevron) chevron.textContent = isOpen ? '▶' : '▼';
}
(function _injectSphHoverStyle() {
    if (document.getElementById('sph-hover-style')) return;
    const s = document.createElement('style');
    s.id = 'sph-hover-style';
    s.textContent = `
        .session-phase-header:hover .sph-edit-btn {
            opacity: 1 !important;
            background: var(--blue-muted) !important;
            border-color: rgba(22,119,255,0.3) !important;
            color: var(--blue) !important;
        }
        .sph-edit-btn:hover {
            background: rgba(22,119,255,0.18) !important;
            border-color: var(--blue) !important;
        }
    `;
    document.head.appendChild(s);
})();
function startRenameSessionPhase(sessionId, phase) {
    const viewEl = $(`sph-view_${sessionId}_${phase}`);
    const editEl = $(`sph-edit_${sessionId}_${phase}`);
    const inputEl = $(`sph-input_${sessionId}_${phase}`);
    if (!viewEl || !editEl) return;
    viewEl.style.display = 'none';
    editEl.style.display = 'flex';
    inputEl?.focus();
    inputEl?.select();
}
function cancelRenameSessionPhase(sessionId, phase) {
    const viewEl = $(`sph-view_${sessionId}_${phase}`);
    const editEl = $(`sph-edit_${sessionId}_${phase}`);
    const inputEl = $(`sph-input_${sessionId}_${phase}`);
    const labelEl = $(`sph-label_${sessionId}_${phase}`);
    if (inputEl && labelEl) inputEl.value = labelEl.textContent;
    if (editEl) editEl.style.display = 'none';
    if (viewEl) viewEl.style.display = 'flex';
}
async function saveRenameSessionPhase(sessionId, phase) {
    const inputEl = $(`sph-input_${sessionId}_${phase}`);
    const labelEl = $(`sph-label_${sessionId}_${phase}`);
    const newName = inputEl?.value.trim();
    const oldName = labelEl?.textContent || phase;
    if (!newName) {
        await showModal('Nama Kosong', 'Nama fase tidak boleh kosong.', 'warning');
        inputEl?.focus();
        return;
    }
    if (newName.length > 40) {
        await showModal('Terlalu Panjang', 'Nama maksimal 40 karakter.', 'warning');
        inputEl?.focus();
        return;
    }
    cancelRenameSessionPhase(sessionId, phase);
    if (labelEl) labelEl.textContent = newName;
    if (sessionsData[sessionId]) {
        if (!sessionsData[sessionId].phaseNames) sessionsData[sessionId].phaseNames = {};
        sessionsData[sessionId].phaseNames[phase] = newName;
    }
    try {
        const phaseKeys = Object.keys(recordsBySession[sessionId] || {})
            .filter(k => /^L\d+$/.test(k));
        if (!phaseKeys.length) {
            await showModal('Error', 'Tidak ada data phase untuk diperbarui.', 'error');
            return;
        }
        const update = { [`phaseNames/${phase}`]: newName };
        await Promise.all(
            phaseKeys.map(ph =>
                database.ref(`devices/${selectedDeviceId}/History/${ph}/${sessionId}/_meta`)
                    .update(update)
            )
        );
        await showModal('Berhasil', `Nama fase ${phase} di sesi ini diubah menjadi:\n"${newName}"`, 'success');
    } catch (e) {
        if (labelEl) labelEl.textContent = oldName;
        if (sessionsData[sessionId]?.phaseNames) {
            sessionsData[sessionId].phaseNames[phase] = oldName;
        }
        await showModal('Error', 'Gagal menyimpan: ' + e.message, 'error');
    }
}
function getDevicePhasesWithNames() {
    if (!selectedDeviceId) return [];
    const dev = _deviceListCache.find(d => d.id === selectedDeviceId);
    if (!dev?.phases?.length) return [];
    return dev.phases.filter(p => p.enabled !== false).map(p => ({ phase: p.phase, name: p.name }));
}
const COL_WIDTHS = [
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 13 }, { wch: 13 }, { wch: 13 },
    { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 22 },
];
function _buildExcelRow(entry, deviceName) {
    const row = {};
    row['Device Name'] = deviceName;
    row['Timestamp'] = entry.timestamp ?? '';
    row['Status'] = entry.offline ? 'OFFLINE' : 'online';
    row['Voltage (V)'] = entry.Voltage != null ? +entry.Voltage.toFixed(2) : '';
    row['Current (A)'] = entry.Current != null ? +entry.Current.toFixed(2) : '';
    row['Power (W)'] = entry.Power != null ? +entry.Power.toFixed(2) : '';
    row['Apparent Power (kVA)'] = entry.Apparent != null ? +entry.Apparent.toFixed(4) : '';
    row['Reactive Power (kVAR)'] = entry.Reactive != null ? +entry.Reactive.toFixed(4) : '';
    row['Power Factor'] = entry.PowerFactor != null ? +entry.PowerFactor.toFixed(4) : '';
    row['Phase Angle (°)'] = entry.Phase1 != null ? +entry.Phase1.toFixed(3) : '';
    row['Frequency (Hz)'] = entry.Frequency != null ? +entry.Frequency.toFixed(1) : '';
    row['Active Energy (kWh)'] = entry.Energy != null ? +entry.Energy.toFixed(4) : '';
    row['Apparent Energy (kVAh)'] = entry.EnergyApparent != null ? +entry.EnergyApparent.toFixed(4) : '';
    row['Reactive Energy (kVARh)'] = entry.EnergyReactive != null ? +entry.EnergyReactive.toFixed(4) : '';
    return row;
}
async function exportSession(sessionId, sessionName, event) {
    event.stopPropagation();
    const phaseData = recordsBySession[sessionId] || {};
    const phaseKeys = Object.keys(phaseData).filter(k => /^L\d+$/.test(k)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    const totalRecords = phaseKeys.reduce((s, ph) => s + (phaseData[ph]?.length || 0), 0);
    if (!phaseKeys.length || totalRecords === 0) { await showModal('Tidak Ada Data', `Sesi "${sessionName}" belum memiliki record.`, 'warning'); return; }
    const confirmed = await showModal('Export Sesi',
        `Ekspor ${totalRecords} record (${phaseKeys.length} phase) dari sesi:\n"${sessionName}"\n\nData Firebase TIDAK dihapus. Lanjutkan?`, 'info', ['confirm']);
    if (!confirmed) return;
    try {
        const session = sessionsData[sessionId];
        const deviceName = session?.deviceName || _deviceListCache.find(d => d.id === (session?.deviceId || selectedDeviceId))?.name || selectedDeviceId;
        const wb = XLSX.utils.book_new();
        const frozenNames = session.phaseNames || {};
        for (const phase of phaseKeys) {
            const phaseRecs = (phaseData[phase] || []).slice().sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
            const phaseDevName = frozenNames[phase] || phase;
            const ws = XLSX.utils.json_to_sheet(phaseRecs.map(e => _buildExcelRow(e, deviceName)));
            ws['!cols'] = COL_WIDTHS;
            XLSX.utils.book_append_sheet(wb, ws, phaseDevName);
        }
        const allRecords = Object.values(phaseData).flat();
        const onlineRows = allRecords.filter(e => !e.offline);
        const avg = f => onlineRows.length ? onlineRows.reduce((s, e) => s + (e[f] || 0), 0) / onlineRows.length : 0;
        const sum = f => onlineRows.reduce((s, e) => s + (e[f] || 0), 0);
        const wsMeta = XLSX.utils.aoa_to_sheet([
            ['Smart Energy Monitor - Session Export'], [''],
            ['Nama Sesi', sessionName], ['Export Date', new Date().toLocaleString('id-ID')],
            ['Device Name', deviceName], ['Phases', phaseKeys.join(', ')],
            ['Waktu Mulai', session?.startTime || '---'], ['Waktu Selesai', session?.endTime || 'Berlangsung'],
            ['Total Records', totalRecords], ['Records Online', onlineRows.length], ['Records Offline', allRecords.length - onlineRows.length], [''],
            ['Summary Statistics (semua phase, online saja)'], [''],
            ['Parameter', 'Rata-rata', 'Satuan'],
            ['Voltage', avg('Voltage').toFixed(2), 'V'], ['Current', avg('Current').toFixed(2), 'A'],
            ['Power', avg('Power').toFixed(2), 'W'], ['Apparent Power', avg('Apparent').toFixed(4), 'kVA'],
            ['Reactive Power', avg('Reactive').toFixed(4), 'kVAR'], ['Power Factor', avg('PowerFactor').toFixed(4), ''],
            ['Phase Angle', avg('Phase1').toFixed(3), '°'], ['Frequency', avg('Frequency').toFixed(1), 'Hz'],
            ['Total Active Energy', sum('Energy').toFixed(4), 'kWh'],
            ['Total Apparent Energy', sum('EnergyApparent').toFixed(4), 'kVAh'],
            ['Total Reactive Energy', sum('EnergyReactive').toFixed(4), 'kVARh'],
        ]);
        wsMeta['!cols'] = [{ wch: 28 }, { wch: 28 }, { wch: 10 }];
        XLSX.utils.book_append_sheet(wb, wsMeta, 'Summary');
        XLSX.writeFile(wb, `${sessionName.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`);
        await showModal('Export Berhasil!', `${totalRecords} record dari "${sessionName}" berhasil diekspor.`, 'success');
    } catch (e) { await showModal('Export Gagal', 'Error: ' + e.message, 'error'); }
}
async function clearRecords() {
    if (!historyData.length && !Object.keys(sessionsData).length) { await showModal('Tidak Ada Data', 'Tidak ada history yang perlu dihapus.', 'info'); return; }
    const confirmed = await showModal('Konfirmasi Hapus Record', `Hapus SEMUA sesi & record device "${selectedDeviceName}"?\n\nData TIDAK DAPAT dikembalikan.`, 'warning', ['confirm']);
    if (!confirmed) return;
    try {
        await database.ref(`devices/${selectedDeviceId}/History`).remove();
        historyData = []; recordsBySession = {}; sessionsData = {};
        buildSessionUI();
        await showModal('Berhasil Dihapus', 'Semua data rekaman telah dihapus.', 'success');
    } catch (e) { await showModal('Error', 'Gagal menghapus! Error: ' + e.message, 'error'); }
}
let captureActive = false;
let captureInterval = 3000;
let _captureTransitioning = false;
let _captureStatusPollId = null;
let _intervalUserEdited = false;
async function syncCaptureStatus() {
    try {
        const status = await fetch('/api/capture/status').then(r => r.json());
        if (!_captureTransitioning) {
            if (status.active) {
                captureActive = true;
                currentSessionId = status.session_id || null;
                _updateCaptureButtonUI(true);
            } else if (!status.finalizing) {
                captureActive = false;
                currentSessionId = null;
                _updateCaptureButtonUI(false);
            }
        }
        if (!_captureTransitioning && !_intervalUserEdited) {
            const serverSec = status.interval || 3;
            captureInterval = serverSec * 1000;
            const inputEl = $('intervalInput'), unitEl = $('intervalUnit');
            if (inputEl && unitEl) {
                inputEl.value = serverSec;
                unitEl.value = '1';
            }
            if (DOM.intervalDisplay)
                DOM.intervalDisplay.textContent = `Current: ${serverSec} seconds`;
        }
        buildSessionUI();
    } catch (e) { }
}
function _startStatusPolling() {
    if (_captureStatusPollId) return;
    _captureStatusPollId = setInterval(syncCaptureStatus, 4000);
}
const CAPTURE_START_HTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg> Start Capture`;
const CAPTURE_STOP_HTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Stop Capture`;
function _updateCaptureButtonUI(active) {
    const btn = DOM.captureBtn;
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.innerHTML = active ? CAPTURE_STOP_HTML : CAPTURE_START_HTML;
}
async function toggleCapture() {
    if (!captureActive) {
        if (!selectedDeviceId) { await showModal('Pilih Device', 'Pilih device terlebih dahulu.', 'warning'); return; }
        if (!isConnected) { await showModal('Device Offline', 'Tidak dapat memulai capture.\nPastikan device menyala.', 'error'); return; }
        openSessionNameModal();
    } else {
        const confirmed = await showModal('Hentikan Rekaman', 'Hentikan sesi rekaman yang sedang berlangsung?\n\nData sudah tersimpan di Firebase.', 'warning', ['confirm']);
        if (confirmed) await _apiStopCapture();
    }
}
async function _apiStopCapture() {
    captureActive = false;
    currentSessionId = null;
    _captureTransitioning = true;
    _updateCaptureButtonUI(false);
    buildSessionUI();
    try {
        const json = await fetch('/api/capture/stop', { method: 'POST' })
            .then(r => r.json());
        if (!json.ok) {
            await showModal('Error', 'Gagal menghentikan: ' + json.error, 'error');
        }
    } catch (e) {
        await showModal('Error', 'Network error: ' + e.message, 'error');
    } finally {
        _captureTransitioning = false;
    }
}
function openSessionNameModal() {
    const input = $('sessionNameInput');
    const now = new Date(), pad = v => String(v).padStart(2, '0');
    input.value = `Rekaman ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    _resetSessionModal();
    $('sessionNameModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { input.focus(); input.select(); }, 120);
}
function closeSessionNameModal() {
    $('sessionNameModal').classList.remove('active');
    document.body.style.overflow = '';
    _renamingSessionId = null;
    _resetSessionModal();
}
function _resetSessionModal() {
    const modal = $('sessionNameModal');
    if (!modal) return;
    modal.querySelector('.modal-title').textContent = 'Mulai Rekaman Baru';
    modal.querySelector('.modal-message').textContent = 'Beri nama sesi rekaman ini sebelum memulai.';
    const btn = modal.querySelector('.modal-btn-primary');
    btn.innerHTML = '&#9654; MULAI REKAM'; btn.onclick = confirmStartCapture;
}
function openRenameModal(sessionId, currentName, event) {
    event.stopPropagation();
    _renamingSessionId = sessionId;
    const modal = $('sessionNameModal');
    modal.querySelector('.modal-title').textContent = 'Rename Sesi';
    modal.querySelector('.modal-message').textContent = 'Ubah nama sesi rekaman ini.';
    const btn = modal.querySelector('.modal-btn-primary');
    btn.innerHTML = 'SIMPAN NAMA'; btn.onclick = confirmRenameSession;
    $('sessionNameInput').value = currentName;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { $('sessionNameInput').focus(); $('sessionNameInput').select(); }, 120);
}
async function confirmRenameSession() {
    const newName = $('sessionNameInput')?.value.trim();
    const targetId = _renamingSessionId;
    if (!newName) { await showModal('Nama Kosong', 'Nama sesi tidak boleh kosong.', 'warning'); return; }
    closeSessionNameModal();
    if (!targetId) return;
    try {
        const phaseKeys = Object.keys(recordsBySession[targetId] || {}).filter(k => /^L\d+$/.test(k));
        if (phaseKeys.length) {
            await Promise.all(phaseKeys.map(ph => database.ref(`devices/${selectedDeviceId}/History/${ph}/${targetId}/_meta`).update({ name: newName })));
        }
        if (sessionsData[targetId]) sessionsData[targetId].name = newName;
        buildSessionUI();
        await showModal('Berhasil', `Nama sesi diubah menjadi:\n"${newName}"`, 'success');
    } catch (e) { await showModal('Error', 'Gagal mengubah nama! Error: ' + e.message, 'error'); }
}
async function confirmStartCapture() {
    const sessionName = $('sessionNameInput')?.value.trim()
        || `Rekaman ${new Date().toLocaleTimeString('id-ID')}`;
    const intervalSec = Math.round(captureInterval / 1000) || 3;
    closeSessionNameModal();
    const activeDev = _deviceListCache.find(d => d.id === selectedDeviceId);
    const phasesHint = (activeDev?.phases || []).filter(p => p.enabled !== false).map(p => p.phase);
    captureActive = true;
    currentSessionId = null;
    _captureTransitioning = true;
    _updateCaptureButtonUI(true);
    buildSessionUI();
    showModal(
        'Capture Diaktifkan',
        `Sesi: "${sessionName}"\nDevice: ${selectedDeviceName}\n\nRekaman berjalan di server.\nInterval: ${intervalSec}s`,
        'success'
    );
    try {
        const json = await fetch('/api/capture/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionName,
                interval: intervalSec,
                deviceId: selectedDeviceId,
                deviceName: selectedDeviceName,
                phases: phasesHint,
            }),
        }).then(r => r.json());
        if (!json.ok) {
            captureActive = false;
            currentSessionId = null;
            _updateCaptureButtonUI(false);
            closeModal();
            buildSessionUI();
            await showModal('Error', 'Gagal memulai capture: ' + (json.error || ''), 'error');
            return;
        }
        currentSessionId = json.session_id;
        buildSessionUI();
    } catch (e) {
        captureActive = false;
        currentSessionId = null;
        _updateCaptureButtonUI(false);
        closeModal();
        buildSessionUI();
        await showModal('Error', 'Network error: ' + e.message, 'error');
    } finally {
        _captureTransitioning = false;
    }
}

let _timeEditSessionId = null;

function openChangeTimeModal(sessionId, currentStartTime, sessionName, event) {
    if (event) event.stopPropagation();
    _timeEditSessionId = sessionId;
    $('oldTimeInput').value = currentStartTime || '---';
    $('newTimeInput').value = currentStartTime || '';
    $('changeTimeModal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeChangeTimeModal() {
    _timeEditSessionId = null;
    $('changeTimeModal').classList.remove('active');
    document.body.style.overflow = '';
}

async function confirmChangeTime() {
    const sessionId = _timeEditSessionId;
    if (!sessionId) return;
    const oldTimeStr = $('oldTimeInput').value;
    const newTimeStr = $('newTimeInput').value.trim();
    if (!newTimeStr) {
        showModal('Error', 'Waktu baru tidak boleh kosong', 'warning');
        return;
    }
    if (oldTimeStr === newTimeStr) {
        closeChangeTimeModal();
        return;
    }
    
    const formatRegex = /^\d{2}:\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/;
    if (!formatRegex.test(newTimeStr)) {
        closeChangeTimeModal();
        showModal('Format Tidak Valid', 'Mohon masukkan waktu sesuai format:\nHH:MM:SS DD/MM/YYYY\nContoh: 14:30:00 08/04/2026', 'warning');
        return;
    }
    
    const oldDate = parseTimestamp(oldTimeStr);
    const newDate = parseTimestamp(newTimeStr);
    if (isNaN(oldDate.getTime()) || isNaN(newDate.getTime())) {
        closeChangeTimeModal();
        showModal('Error', 'Format waktu tidak valid! Gunakan: HH:MM:SS DD/MM/YYYY', 'warning');
        return;
    }
    
    const deltaMs = newDate.getTime() - oldDate.getTime();
    
    try {
        closeChangeTimeModal();
        showGlobalLoader();
        
        let snap;
        for (let i = 0; i < 15; i++) {
            snap = await database.ref(`devices/${selectedDeviceId}/History`).get();
            let hasRecord = false;
            if (snap && snap.exists()) {
                snap.forEach(phaseSnap => {
                    const sSnap = phaseSnap.child(sessionId);
                    if (sSnap.exists() && Object.keys(sSnap.val() || {}).length > 1) {
                        hasRecord = true;
                    }
                });
            }
            if (hasRecord) break;
            await new Promise(r => setTimeout(r, 600));
        }
        
        let oldestRecTs = Infinity;
        if (snap && snap.exists()) {
            snap.forEach(phaseSnap => {
                const ph = phaseSnap.key;
                if (!/^L\d+$/.test(ph)) return;
                const sessSnap = phaseSnap.child(sessionId);
                if (sessSnap.exists()) {
                    sessSnap.forEach(recSnap => {
                        if (recSnap.key === '_meta') return;
                        const rec = recSnap.val();
                        if (rec.timestamp) {
                            const recDate = parseTimestamp(rec.timestamp);
                            if (!isNaN(recDate.getTime()) && recDate.getTime() < oldestRecTs) {
                                oldestRecTs = recDate.getTime();
                            }
                        }
                    });
                }
            });
        }
        
        if (oldestRecTs === Infinity) oldestRecTs = oldDate.getTime();
        const deltaMs = newDate.getTime() - oldestRecTs;
        
        let shiftEpoch = Infinity;
        try {
            const res = await fetch('/api/capture/shift_time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, deltaMs })
            }).then(r => r.json());
            if (res && res.shift_epoch) shiftEpoch = res.shift_epoch * 1000;
        } catch(err) { console.error('Failed to shift backend time', err); }
        
        await new Promise(r => setTimeout(r, 3500));
        
        let updates = {};
        const p2 = v => String(v).padStart(2, '0');
        const serializeTs = (date) => `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())} ${p2(date.getDate())}/${p2(date.getMonth() + 1)}/${date.getFullYear()}`;
        const newStartTime = serializeTs(newDate);
        
        const finalSnap = await database.ref(`devices/${selectedDeviceId}/History`).get();
        let latestRecTs = 0;
        
        if (finalSnap && finalSnap.exists()) {
            finalSnap.forEach(phaseSnap => {
                const ph = phaseSnap.key;
                if (!/^L\d+$/.test(ph)) return;
                const sessSnap = phaseSnap.child(sessionId);
                if (sessSnap.exists()) {
                    sessSnap.forEach(recSnap => {
                        if (recSnap.key === '_meta') return;
                        const rec = recSnap.val();
                        if (!rec.timestamp) return;
                        
                        const schedTsStr = recSnap.key.replace('capture_', '');
                        const schedTs = parseInt(schedTsStr);
                        const recDate = parseTimestamp(rec.timestamp).getTime();
                        if (isNaN(recDate)) return;
                        
                        const isAlreadyShifted = (!isNaN(schedTs) && schedTs >= shiftEpoch);
                        const finalTs = isAlreadyShifted ? recDate : recDate + deltaMs;
                        if (finalTs > latestRecTs) latestRecTs = finalTs;
                    });
                }
            });
            
            finalSnap.forEach(phaseSnap => {
                const ph = phaseSnap.key;
                if (!/^L\d+$/.test(ph)) return;
                const sessSnap = phaseSnap.child(sessionId);
                if (sessSnap.exists()) {
                    const meta = sessSnap.child('_meta').val() || {};
                    updates[`devices/${selectedDeviceId}/History/${ph}/${sessionId}/_meta/startTime`] = newStartTime;
                    if (meta.startTimestamp) {
                        updates[`devices/${selectedDeviceId}/History/${ph}/${sessionId}/_meta/startTimestamp`] = (meta.startTimestamp || 0) + deltaMs;
                    }
                    if (meta.endTime && meta.endTime !== '---' && latestRecTs > 0) {
                        updates[`devices/${selectedDeviceId}/History/${ph}/${sessionId}/_meta/endTime`] = serializeTs(new Date(latestRecTs));
                    }
                    
                    sessSnap.forEach(recSnap => {
                        if (recSnap.key === '_meta') return;
                        const schedTsStr = recSnap.key.replace('capture_', '');
                        const schedTs = parseInt(schedTsStr);
                        if (!isNaN(schedTs) && schedTs >= shiftEpoch) return;
                        
                        const rec = recSnap.val();
                        if (!rec.timestamp) return;
                        const recDate = parseTimestamp(rec.timestamp);
                        if (isNaN(recDate.getTime())) return;
                        const shiftedDate = new Date(recDate.getTime() + deltaMs);
                        updates[`devices/${selectedDeviceId}/History/${ph}/${sessionId}/${recSnap.key}/timestamp`] = serializeTs(shiftedDate);
                    });
                }
            });
        }
        
        if (Object.keys(updates).length > 0) {
            await database.ref().update(updates);
        }
        
        hideGlobalLoader();
        showModal('Sukses', 'Waktu sesi berhasil diubah dan disinkronkan.', 'success');
        buildSessionUI();
        
    } catch(e) {
        hideGlobalLoader();
        showModal('Error', 'Gagal mengubah waktu! Error: ' + e.message, 'error');
    }
}

async function deleteSession(sessionId, sessionName, event) {
    event.stopPropagation();
    const confirmed = await showModal('Hapus Sesi', `Hapus sesi:\n"${sessionName}"\n\nSemua record akan ikut terhapus.`, 'warning', ['confirm']);
    if (!confirmed) return;
    try {
        const historyPhaseKeys = Object.keys(recordsBySession[sessionId] || {});
        const activePhases = getDevicePhasesWithNames().map(p => p.phase);
        const phaseKeys = Array.from(new Set([...historyPhaseKeys, ...activePhases]));
        if (phaseKeys.length > 0) {
            await Promise.all(phaseKeys.map(ph => database.ref(`devices/${selectedDeviceId}/History/${ph}/${sessionId}`).remove()));
        } else {
            await database.ref(`devices/${selectedDeviceId}/History/${sessionId}`).remove();
        }
        delete sessionsData[sessionId]; delete recordsBySession[sessionId];
        historyData = historyData.filter(r => r.sessionId !== sessionId);
        buildSessionUI();
        await showModal('Sesi Dihapus', `Sesi "${sessionName}" berhasil dihapus.`, 'success');
    } catch (e) { await showModal('Error', 'Gagal menghapus! Error: ' + e.message, 'error'); }
}
async function setCaptureInterval() {
    const val = parseInt($('intervalInput')?.value);
    const multiplier = parseInt($('intervalUnit')?.value);
    if (isNaN(val) || val < 1) { await showModal('Input Tidak Valid', 'Masukkan nilai interval yang valid (minimal 1)!', 'warning'); return; }
    const totalSec = val * multiplier;
    captureInterval = totalSec * 1000;
    _intervalUserEdited = true;
    const unitLabel = $('intervalUnit')?.options[$('intervalUnit').selectedIndex]?.text.toLowerCase() || 'seconds';
    if (DOM.intervalDisplay) DOM.intervalDisplay.textContent = multiplier === 1 ? `Current: ${val} seconds` : `Current: ${val} ${unitLabel} (${totalSec}s)`;
    try {
        await fetch('/api/capture/interval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interval: totalSec }),
        });
    } catch (e) { }
    await showModal('Interval Diperbarui', `Interval diubah menjadi ${val} ${unitLabel}.`, 'success');
}
document.addEventListener('DOMContentLoaded', async () => {
    initChart();
    DOM.paramSelect?.addEventListener('change', changeParameter);
    document.querySelectorAll('.metric-card-compact[data-param]').forEach(card => {
        card.addEventListener('click', () => _switchParameter(card.dataset.param));
        card.classList.toggle('card-active', card.dataset.param === selectedParameter);
    });
    await loadDevices();
    const globalLoader = document.getElementById('globalLoader');
    if (globalLoader) {
        globalLoader.classList.add('hidden');
        setTimeout(() => globalLoader.style.display = 'none', 500);
    }
    setInterval(loadDevices, 30_000);
    updateConnectionStatus('connecting');
    startConnectionMonitoring();
    startTimeWindowMonitoring();
    await syncCaptureStatus();
    _startStatusPolling();
    $('intervalInput')?.addEventListener('focus', () => { _intervalUserEdited = true; });
    $('intervalInput')?.addEventListener('input', () => { _intervalUserEdited = true; });
    $('intervalUnit')?.addEventListener('change', () => { _intervalUserEdited = true; });
    $('sessionNameInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { _renamingSessionId ? confirmRenameSession() : confirmStartCapture(); }
    });
});
window.addEventListener('beforeunload', () => {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_chartTimer) { clearInterval(_chartTimer); _chartTimer = null; }
});