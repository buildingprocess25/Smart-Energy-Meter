// ============================================================
// SMART ENERGY MONITOR — app.js
// ============================================================

// ====================================
// FIREBASE INIT
// ====================================
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ====================================
// APP STATE
// ====================================
let realtimeData        = null;
let historyData         = [];
let isConnected         = false;
let lastDataTimestamp   = 0;
let connectionCheckInterval = null;

let _staleFingerprint   = null;

// ====================================
// CHART STATE
// ====================================
let realtimeChart = null;
let chartData = {
    labels:      [],
    timestamps:  [],
    voltage:     [],
    current:     [],
    power:       [],
    frequency:   [],
    apparent:    [],
    reactive:    [],
    energy:      [],
    powerFactor: []
};

const MAX_DATA_POINTS     = 300;
const SAVE_EVERY_N_POINTS = 60;

let selectedParameter = 'voltage';
let timeFilter        = 'all';

// ====================================
// CAPTURE STATE
// ====================================
let captureActive     = false;
let captureCount      = 0;
let captureInterval   = 3000;
let captureIntervalId = null;
let _captureWasActive = false;

// ====================================
// SETTINGS STATE
// ====================================
let thresholds = {
    voltageMax:     240,
    voltageMin:     200,
    currentMax:     20,
    powerMax:       4400,
    powerFactorMin: 0.85,
    energyLimit:    1000
};

let preferences = {
    decimalPlaces: 2,
    updateRate:    2000,
    soundAlerts:   false,
    visualAlerts:  true
};

let autoExportEnabled  = false;
let autoExportInterval = '0';

// ====================================
// CHART PERSISTENCE — localStorage
// ====================================
const CHART_STORAGE_KEY = 'sem_chartdata_v1';
const CHART_KEYS = [
    'labels', 'timestamps', 'voltage', 'current', 'power',
    'frequency', 'apparent', 'reactive', 'energy', 'powerFactor'
];
let _saveCounter  = 0;
let _userIsZoomed = false;

function loadChartDataFromStorage() {
    try {
        const raw = localStorage.getItem(CHART_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!CHART_KEYS.every(k => Array.isArray(saved[k]))) return;
        CHART_KEYS.forEach(k => { chartData[k] = saved[k]; });

        const cutoff      = Date.now() - 24 * 60 * 60 * 1000;
        const firstRecent = chartData.timestamps.findIndex(t => t >= cutoff);
        if (firstRecent > 0) {
            CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(firstRecent); });
            console.log(`[ChartStorage] Pruned ${firstRecent} stale points.`);
        } else if (firstRecent === -1) {
            CHART_KEYS.forEach(k => { chartData[k] = []; });
            console.log('[ChartStorage] Semua data kadaluarsa, chart di-reset.');
            return;
        }
        console.log(`[ChartStorage] Loaded ${chartData.labels.length} points.`);
    } catch (e) {
        console.warn('[ChartStorage] Gagal memuat:', e);
    }
}

function saveChartDataToStorage() {
    try {
        const payload = {};
        CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
        localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('[ChartStorage] Storage penuh, memangkas data lama...');
        CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(-100); });
        try {
            const payload = {};
            CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
            localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
        } catch (_) { }
    }
}

function maybeSaveChartData() {
    _saveCounter++;
    if (_saveCounter >= SAVE_EVERY_N_POINTS) {
        _saveCounter = 0;
        saveChartDataToStorage();
    }
}

function clearChartDataFromStorage() {
    _saveCounter = 0;
    localStorage.removeItem(CHART_STORAGE_KEY);
}

// ====================================
// DAILY AGGREGATION — Firebase
// ====================================
const DAILY_AGG_REF  = 'alat1/DailyAgg';
const DAILY_AGG_KEYS = ['voltage','current','power','frequency','apparent','reactive','energy','powerFactor'];

let _dailyAgg    = {};
let _dailySums   = {};
let _dailyCounts = {};
let _lastDayStr  = '';

function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _cutoffStr() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
}

function loadDailyAggFromFirebase() {
    return new Promise((resolve) => {
        database.ref(DAILY_AGG_REF).once('value', (snap) => {
            if (!snap.exists()) { resolve(); return; }

            const raw    = snap.val() || {};
            const cutoff = _cutoffStr();
            const removes = [];

            Object.keys(raw).forEach(day => {
                if (day < cutoff) {
                    removes.push(database.ref(`${DAILY_AGG_REF}/${day}`).remove());
                    console.log(`[DailyAgg] Pruned: ${day}`);
                } else {
                    _dailyAgg[day] = raw[day];
                }
            });

            if (removes.length) {
                Promise.all(removes).catch(e => console.warn('[DailyAgg] Prune error:', e));
            }

            console.log(`[DailyAgg] Loaded ${Object.keys(_dailyAgg).length} days.`);
            resolve();
        }, () => resolve());
    });
}

function _accumulateDailyPoint(data) {
    const today = _todayStr();

    if (_lastDayStr && _lastDayStr !== today) {
        _flushDailyAgg(_lastDayStr);
        _pruneOldDailyAgg();
    }
    _lastDayStr = today;

    if (!_dailySums[today]) {
        _dailySums[today]   = {};
        _dailyCounts[today] = 0;
        DAILY_AGG_KEYS.forEach(k => { _dailySums[today][k] = 0; });
    }

    DAILY_AGG_KEYS.forEach(k => {
        const fk = k === 'powerFactor' ? 'PowerFactor' : k.charAt(0).toUpperCase() + k.slice(1);
        _dailySums[today][k] += (data[fk] || 0);
    });
    _dailyCounts[today]++;

    if (_dailyCounts[today] % 300 === 0) {
        _flushDailyAgg(today);
    }
}

function _flushDailyAgg(dayStr) {
    const count = _dailyCounts[dayStr];
    if (!count || count === 0) return;

    const avg = {};
    DAILY_AGG_KEYS.forEach(k => {
        avg[k] = parseFloat((_dailySums[dayStr][k] / count).toFixed(4));
    });
    _dailyAgg[dayStr] = avg;

    database.ref(`${DAILY_AGG_REF}/${dayStr}`).set(avg)
        .then(() => console.log(`[DailyAgg] Saved ${dayStr} (${count} samples)`))
        .catch(err => console.warn('[DailyAgg] Gagal simpan:', err));
}

function _pruneOldDailyAgg() {
    const cutoff = _cutoffStr();
    Object.keys(_dailyAgg).forEach(day => {
        if (day < cutoff) {
            database.ref(`${DAILY_AGG_REF}/${day}`).remove()
                .then(() => console.log(`[DailyAgg] Deleted: ${day}`))
                .catch(e => console.warn('[DailyAgg] Delete error:', e));
            delete _dailyAgg[day];
            delete _dailySums[day];
            delete _dailyCounts[day];
        }
    });
}

function getDailyChartData(param) {
    const labels = [], values = [];
    for (let i = 6; i >= 0; i--) {
        const d      = new Date();
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const label  = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
        labels.push(label);

        if (_dailyAgg[dayStr]?.[param] !== undefined) {
            values.push(_dailyAgg[dayStr][param]);
        } else if (_dailySums[dayStr] && _dailyCounts[dayStr] > 0) {
            values.push(parseFloat((_dailySums[dayStr][param] / _dailyCounts[dayStr]).toFixed(4)));
        } else {
            values.push(null);
        }
    }
    return { labels, values };
}

// ====================================
// MODAL
// ====================================
function showModal(title, message, type = 'info', buttons = ['ok']) {
    return new Promise((resolve) => {
        const modal        = document.getElementById('customModal');
        const modalTitle   = document.getElementById('modalTitle');
        const modalMessage = document.getElementById('modalMessage');
        const modalIcon    = document.getElementById('modalIcon');
        const modalButtons = document.getElementById('modalButtons');

        modalTitle.textContent   = title;
        modalMessage.textContent = message;
        modalIcon.className      = 'modal-icon ' + type;

        const icons = {
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };
        modalIcon.innerHTML = icons[type] || icons.info;

        modalButtons.innerHTML = '';
        if (buttons.includes('confirm')) {
            const cancelBtn = document.createElement('button');
            cancelBtn.className   = 'modal-btn modal-btn-secondary';
            cancelBtn.textContent = 'BATAL';
            cancelBtn.onclick     = () => { closeModal(); resolve(false); };
            modalButtons.appendChild(cancelBtn);

            const confirmBtn = document.createElement('button');
            confirmBtn.className   = 'modal-btn modal-btn-primary';
            confirmBtn.textContent = 'YA, LANJUTKAN';
            confirmBtn.onclick     = () => { closeModal(); resolve(true); };
            modalButtons.appendChild(confirmBtn);
        } else {
            const okBtn = document.createElement('button');
            okBtn.className   = 'modal-btn modal-btn-primary';
            okBtn.textContent = 'OK';
            okBtn.onclick     = () => { closeModal(); resolve(true); };
            modalButtons.appendChild(okBtn);
        }

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    });
}

function closeModal() {
    document.getElementById('customModal').classList.remove('active');
    document.body.style.overflow = '';
}

document.addEventListener('click',   e => { if (e.target === document.getElementById('customModal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ====================================
// ZOOM
// ====================================
function resetZoom() {
    if (realtimeChart) {
        realtimeChart.resetZoom();
        _userIsZoomed = false;
    }
}

// ====================================
// TIME FILTER
// ====================================
function setTimeFilter(filter) {
    timeFilter    = filter;
    _userIsZoomed = false;
    document.querySelectorAll('.time-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    refreshChartWithFilter();
}

// ====================================
// AGGREGATION
// ====================================
function getFilterConfig() {
    const configs = {
        minute: { buckets: 60, bucketMs: 60_000,        windowMs: 60 * 60_000,       fmt: 'HH:MM' },
        hour:   { buckets: 24, bucketMs: 60 * 60_000,   windowMs: 24 * 60 * 60_000,  fmt: 'HH:00' },
        '6h':   { buckets: 12, bucketMs: 30 * 60_000,   windowMs: 6  * 60 * 60_000,  fmt: 'HH:MM' },
        day:    null
    };
    return configs[timeFilter] || null;
}

function getAggregatedChartData() {
    const raw = chartData[selectedParameter];
    const ts  = chartData.timestamps;

    if (timeFilter === 'all') return { labels: chartData.labels, values: raw };
    if (timeFilter === 'day') return getDailyChartData(selectedParameter);

    const cfg = getFilterConfig();
    if (!cfg) return { labels: chartData.labels, values: raw };

    const now = Date.now();
    const d   = new Date(now);
    let alignedNow;
    if (timeFilter === 'minute') {
        alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + 1, 0, 0).getTime();
    } else {
        alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
    }
    const windowStart = alignedNow - cfg.windowMs;

    const sums   = new Array(cfg.buckets).fill(0);
    const counts = new Array(cfg.buckets).fill(0);

    for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t < windowStart || t > now) continue;
        const idx = Math.floor((t - windowStart) / cfg.bucketMs);
        if (idx < 0 || idx >= cfg.buckets) continue;
        sums[idx]   += raw[i];
        counts[idx] += 1;
    }

    const labels = [], values = [];
    for (let i = 0; i < cfg.buckets; i++) {
        const labelTime = new Date(windowStart + i * cfg.bucketMs);
        labels.push(formatBucketLabel(labelTime, cfg.fmt));
        values.push(counts[i] > 0 ? parseFloat((sums[i] / counts[i]).toFixed(4)) : null);
    }

    return { labels, values };
}

function formatBucketLabel(d, fmt) {
    const pad = v => String(v).padStart(2, '0');
    switch (fmt) {
        case 'DD/MM':  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        case 'HH:00':  return `${pad(d.getHours())}:00`;
        case 'HH:MM':  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        default:       return d.toLocaleTimeString('id-ID');
    }
}

function refreshChartWithFilter() {
    const canvas = document.getElementById('realtimeChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    wrap.style.transition = 'opacity 0.18s ease';
    wrap.style.opacity    = '0';
    setTimeout(() => {
        if (realtimeChart) { realtimeChart.destroy(); realtimeChart = null; }
        initChart();
        wrap.style.opacity = '1';
    }, 180);
}

function updateFilterInfo(_values) {
    const el = document.getElementById('filterInfo');
    if (el) el.textContent = '';
}

// ====================================
// CHART
// ====================================
function getYBounds(values, param) {
    const padMap = {
        voltage:     10,
        current:     1,
        power:       50,
        frequency:   1,
        apparent:    0.05,
        reactive:    0.05,
        energy:      0.1,
        powerFactor: 0.05
    };
    const pad   = padMap[param] ?? 5;
    const clean = (values || []).filter(v => v !== null && v !== undefined && isFinite(v));
    if (clean.length === 0) return { yMin: undefined, yMax: undefined };

    const dataMin   = Math.min(...clean);
    const dataMax   = Math.max(...clean);
    const dataRange = dataMax - dataMin;
    const actualPad = dataRange < pad * 2 ? pad : dataRange * 0.15;

    return {
        yMin: parseFloat((dataMin - actualPad).toFixed(4)),
        yMax: parseFloat((dataMax + actualPad).toFixed(4))
    };
}

function initChart() {
    const ctx = document.getElementById('realtimeChart');
    if (!ctx) return;

    const parameterInfo = {
        voltage:     { label: 'Voltage',       unit: 'V',    color: '#FFA500', borderColor: '#FF8C00' },
        current:     { label: 'Current',        unit: 'A',    color: '#0066CC', borderColor: '#0052A3' },
        power:       { label: 'Power',          unit: 'W',    color: '#00A651', borderColor: '#008040' },
        frequency:   { label: 'Frequency',      unit: 'Hz',   color: '#6B46C1', borderColor: '#5A3AA0' },
        apparent:    { label: 'Apparent Power', unit: 'kVA',  color: '#FFA500', borderColor: '#FF8C00' },
        reactive:    { label: 'Reactive Power', unit: 'kVAR', color: '#0066CC', borderColor: '#0052A3' },
        energy:      { label: 'Energy',         unit: 'kWh',  color: '#00A651', borderColor: '#008040' },
        powerFactor: { label: 'Power Factor',   unit: '',     color: '#6B46C1', borderColor: '#5A3AA0' }
    };

    const info     = parameterInfo[selectedParameter];
    const isBar    = (timeFilter === 'day' || timeFilter === '6h' || timeFilter === 'hour');
    const isAgg    = (timeFilter !== 'all');
    const isMinute = (timeFilter === 'minute');

    const { labels, values } = getAggregatedChartData();

    const xTitles = {
        all:    'Waktu',
        minute: '60 Menit Terakhir',
        hour:   '24 Jam Terakhir',
        '6h':   '6 Jam Terakhir',
        day:    '7 Hari Terakhir'
    };

    const gradientFill = (() => {
        const c2d = ctx.getContext('2d');
        const g   = c2d.createLinearGradient(0, 0, 0, ctx.clientHeight || 300);
        const top = isMinute ? '88' : '55';
        const bot = isMinute ? '10' : '05';
        g.addColorStop(0, info.color + top);
        g.addColorStop(1, info.color + bot);
        return g;
    })();

    realtimeChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        data: {
            labels,
            datasets: [{
                label:                  info.unit ? `${info.label} (${info.unit})` : info.label,
                data:                   values,
                borderColor:            info.borderColor,
                backgroundColor:        isBar ? info.color + 'BB' : gradientFill,
                borderWidth:            isBar ? 1.5 : (isMinute ? 2.5 : 2),
                tension:                isMinute ? 0.5 : 0.4,
                cubicInterpolationMode: 'monotone',
                spanGaps:               isMinute,
                fill:                   !isBar,
                pointRadius:            isBar ? 0 : (isMinute ? 0 : (isAgg ? 4 : (chartData.labels.length > 150 ? 0 : 2))),
                pointHoverRadius:       isBar ? 0 : (isMinute ? 5 : 6),
                pointBackgroundColor:   info.borderColor,
                pointBorderColor:       '#fff',
                pointBorderWidth:       1.5,
                borderRadius:           isBar ? 5 : 0,
                borderSkipped:          false
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            interaction:         { intersect: false, mode: 'index' },
            animation:           { duration: 300, easing: 'easeInOutQuart' },
            transitions:         { active: { animation: { duration: 150 } } },
            plugins: {
                legend: {
                    display: true, position: 'top',
                    labels: {
                        font:        { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial', size: 11, weight: 700 },
                        color:       '#666666',
                        usePointStyle: true,
                        pointStyle:  isBar ? 'rect' : 'circle',
                        padding:     12
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(20,20,20,0.9)',
                    titleFont:       { size: 12, weight: 700 },
                    bodyFont:        { size: 11 },
                    padding: 12, cornerRadius: 10, displayColors: false, caretSize: 6,
                    callbacks: {
                        title: items => ({ minute: ' ', hour: ' ', '6h': ' ', day: ' ', all: ' ' }[timeFilter] || ' ') + (items[0]?.label || ''),
                        label: ctx => {
                            const val = ctx.parsed.y;
                            if (val === null || val === undefined) return '  Tidak ada data';
                            const unit   = info.unit ? ` ${info.unit}` : '';
                            const prefix = isAgg ? '  Rata-rata: ' : '  ';
                            return `${prefix}${val.toFixed(3)}${unit}`;
                        }
                    }
                },
                zoom: {
                    zoom: {
                        wheel:  { enabled: true, speed: 0.08 },
                        pinch:  { enabled: true },
                        mode:   'x',
                        onZoom: () => { _userIsZoomed = true; }
                    },
                    pan: {
                        enabled: true,
                        mode:    'x',
                        onPan:   () => { _userIsZoomed = true; }
                    },
                    limits: { x: { minRange: 2 } }
                }
            },
            scales: {
                x: {
                    display: true,
                    title: { display: true, text: xTitles[timeFilter] || 'Waktu', font: { size: 11, weight: 700 }, color: '#666666' },
                    grid:  { color: 'rgba(0,0,0,0.04)', drawTicks: false },
                    ticks: {
                        maxRotation: isMinute ? 0 : 45,
                        minRotation: 0,
                        font:        { size: 9 },
                        color:       '#999999',
                        maxTicksLimit: isBar ? 7 : (isMinute ? 10 : (isAgg ? 12 : 15)),
                        padding:     4
                    },
                    offset: isBar
                },
                y: (() => {
                    const { yMin, yMax } = getYBounds(values, selectedParameter);
                    return {
                        display: true,
                        title: { display: true, text: info.unit ? `${info.label} (${info.unit})` : info.label, font: { size: 11, weight: 700 }, color: '#666666' },
                        grid:  { color: 'rgba(0,0,0,0.05)', drawTicks: false },
                        ticks: {
                            font:     { size: 9 },
                            color:    '#999999',
                            padding:  6,
                            callback: val => (val === null ? '' : val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val)
                        },
                        min: yMin,
                        max: yMax
                    };
                })()
            }
        }
    });

    updateFilterInfo(values);
}

function updateChart(data) {
    if (!realtimeChart) return;

    const now       = new Date();
    const timeLabel = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    chartData.labels.push(timeLabel);
    chartData.timestamps.push(Date.now());
    chartData.voltage.push(data.Voltage       || 0);
    chartData.current.push(data.Current       || 0);
    chartData.power.push(data.Power           || 0);
    chartData.frequency.push(data.Frequency   || 0);
    chartData.apparent.push(data.Apparent     || 0);
    chartData.reactive.push(data.Reactive     || 0);
    chartData.energy.push(data.Energy         || 0);
    chartData.powerFactor.push(data.PowerFactor || 0);

    if (chartData.labels.length > MAX_DATA_POINTS) {
        chartData.labels.shift();
        chartData.timestamps.shift();
        chartData.voltage.shift();
        chartData.current.shift();
        chartData.power.shift();
        chartData.frequency.shift();
        chartData.apparent.shift();
        chartData.reactive.shift();
        chartData.energy.shift();
        chartData.powerFactor.shift();
    }

    maybeSaveChartData();
    _accumulateDailyPoint(data);

    const { labels, values } = getAggregatedChartData();
    realtimeChart.data.labels              = labels;
    realtimeChart.data.datasets[0].data    = values;

    if (timeFilter === 'all') {
        realtimeChart.data.datasets[0].pointRadius = chartData.labels.length > 150 ? 0 : 2;
    }

    realtimeChart.update('none');

    if (timeFilter === 'all' && !_userIsZoomed && realtimeChart.data.labels.length > 0) {
        _scrollToLatest();
    }

    updateFilterInfo(values);
}

function _scrollToLatest() {
    const total    = realtimeChart.data.labels.length;
    const visible  = Math.min(60, total);
    const minIndex = total - visible;
    const maxIndex = total - 1;
    try {
        realtimeChart.zoomScale('x', { min: minIndex, max: maxIndex }, 'none');
    } catch (_) { }
}

function changeParameter() {
    _switchParameter(document.getElementById('parameterSelect').value);
}

function _switchParameter(param) {
    selectedParameter = param;
    _userIsZoomed     = false;

    const sel = document.getElementById('parameterSelect');
    if (sel) sel.value = param;

    document.querySelectorAll('.metric-card-compact').forEach(card => {
        card.classList.toggle('card-active', card.dataset.param === param);
    });

    const canvas = document.getElementById('realtimeChart');
    const wrap   = canvas ? canvas.parentElement : null;
    if (wrap) {
        wrap.style.transition = 'opacity 0.18s ease';
        wrap.style.opacity    = '0';
        setTimeout(() => {
            if (realtimeChart) realtimeChart.destroy();
            initChart();
            wrap.style.opacity = '1';
        }, 180);
    } else {
        if (realtimeChart) realtimeChart.destroy();
        initChart();
    }
}

function clearChartData() {
    chartData = {
        labels: [], timestamps: [],
        voltage: [], current: [], power: [], frequency: [],
        apparent: [], reactive: [], energy: [], powerFactor: []
    };
    clearChartDataFromStorage();
    if (realtimeChart) {
        realtimeChart.data.labels           = [];
        realtimeChart.data.datasets[0].data = [];
        realtimeChart.update();
    }
    updateFilterInfo([]);
}

// ====================================
// TAB SWITCHING
// ====================================
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    const map = { realtime: 'realtime', history: 'history', settings: 'settings' };
    if (map[tabName]) {
        document.getElementById(tabName + 'Tab').classList.add('active');
        document.getElementById(tabName + 'Content').classList.add('active');
    }
    if (tabName === 'settings') loadSettings();
}

// ====================================
// REALTIME LISTENER
// ====================================
function initRealtimeListener() {
    database.ref('alat1/RealTime').on('value', (snapshot) => {
        if (!snapshot.exists()) {
            isConnected = false;
            updateConnectionStatus(false);
            return;
        }

        const data = snapshot.val();
        realtimeData = data;

        const fp = `${data.Voltage}|${data.Current}|${data.Power}|${data.Energy}|${data.Frequency}`;

        if (_staleFingerprint === null) {
            _staleFingerprint = fp;
            updateDisplayCards(data);
            return;
        }

        if (fp === _staleFingerprint) {
            return;
        }

        _staleFingerprint = fp;
        lastDataTimestamp = Date.now();
        isConnected       = true;
        updateRealtimeUI(data);
        updateConnectionStatus(true);
        checkThresholds(data);

    }, () => { isConnected = false; updateConnectionStatus(false); });
}

function updateDisplayCards(data) {
    document.getElementById('lastUpdate').textContent      = `Last update: ${new Date().toLocaleTimeString('id-ID')}`;
    document.getElementById('voltage').textContent         = data.Voltage?.toFixed(2)     || '---';
    document.getElementById('current').textContent         = data.Current?.toFixed(2)     || '---';
    document.getElementById('power').textContent           = data.Power?.toFixed(2)       || '---';
    document.getElementById('frequency').textContent       = data.Frequency?.toFixed(1)   || '---';
    document.getElementById('apparent').textContent        = data.Apparent?.toFixed(3)    || '---';
    document.getElementById('reactive').textContent        = data.Reactive?.toFixed(3)    || '---';
    document.getElementById('energy').textContent          = data.Energy?.toFixed(3)      || '---';
    document.getElementById('powerFactor').textContent     = data.PowerFactor?.toFixed(3) || '---';
}

function updateRealtimeUI(data) {
    updateDisplayCards(data);
    updateChart(data);
}

// ====================================
// CONNECTION STATUS
// ====================================
let _prevConnected = null;
let _initialLoad   = true;  // true selama koneksi pertama saat reload/buka halaman

async function updateConnectionStatus(connected) {
    const statusDot  = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const captureBtn = document.getElementById('captureBtn');

    if (connected) {
        statusDot.classList.add('online');
        statusDot.classList.remove('offline');
        statusText.textContent = 'ONLINE';
        // Popup hanya saat koneksi pulih setelah benar-benar terputus mid-session (bukan saat reload)
        if (_prevConnected === false && !_initialLoad) {
            await showModal('Device Online', 'Koneksi dengan device berhasil!\nData realtime mulai diterima.', 'success', ['ok']);
        }

        // Tandai bahwa koneksi awal sudah selesai — popup berikutnya boleh tampil
        _initialLoad = false;

        // Auto-resume capture jika sebelumnya aktif lalu terputus
        if (_captureWasActive && !captureActive) {
            _captureWasActive = false;
            await _autoResumeCapture();
        }

    } else {
        statusDot.classList.add('offline');
        statusDot.classList.remove('online');
        statusText.textContent = 'OFFLINE';
        // Popup offline hanya saat koneksi benar-benar terputus mid-session (bukan saat reload)
        if (_prevConnected === true && !_initialLoad) {
            if (captureActive) {
                await showModal('Device Offline',
                    'Koneksi dengan device terputus.\nData capture dihentikan otomatis dan akan dilanjutkan kembali saat device online.',
                    'error', ['ok']);
            } else {
                await showModal('Device Offline',
                    'Koneksi dengan device terputus.\nTidak ada data yang masuk saat ini.',
                    'warning', ['ok']);
            }
        }

        if (captureActive) {
            _captureWasActive = true;
            _autoStopCapture();
        }
    }

    _prevConnected = connected;
}

function _autoStopCapture() {
    captureActive = false;
    stopCaptureInterval();

    const captureBtn = document.getElementById('captureBtn');
    if (captureBtn) {
        captureBtn.classList.remove('active');
        captureBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg> START CAPTURE`;
    }
    console.warn('[Capture] Auto-stopped: device offline.');
}

async function _autoResumeCapture() {
    captureActive = true;
    startCaptureInterval();

    const captureBtn = document.getElementById('captureBtn');
    if (captureBtn) {
        captureBtn.classList.add('active');
        captureBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> STOP CAPTURE`;
    }
    await showModal('Capture Dilanjutkan',
        `Device online kembali!\nData capture dilanjutkan otomatis.\n\nTotal data tersimpan: ${captureCount} records.`,
        'success', ['ok']);
    console.log('[Capture] Auto-resumed: device back online.');
}

function checkDataFreshness() {
    const age   = Date.now() - lastDataTimestamp;
    const fresh = lastDataTimestamp !== 0 && age <= 10000;
    isConnected  = fresh;
    updateConnectionStatus(fresh);
}

function startConnectionMonitoring() {
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(checkDataFreshness, 5000);
}

// ====================================
// HISTORY LISTENER
// ====================================
function initHistoryListener() {
    database.ref('alat1/History').on('value', (snapshot) => {
        if (snapshot.exists()) {
            historyData = Object.values(snapshot.val());
            historyData.sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));
            updateHistoryUI(historyData);
        } else {
            updateHistoryUI([]);
        }
    });
}

function parseTimestamp(timestamp) {
    try {
        const [time, date] = timestamp.split(' ');
        const [h, m, s]    = time.split(':').map(Number);
        const [d, mo, y]   = date.split('/').map(Number);
        return new Date(y, mo - 1, d, h, m, s);
    } catch (e) { return new Date(); }
}

function updateHistoryUI(data) {
    const tbody        = document.getElementById('historyTableBody');
    const historyCount = document.getElementById('historyCount');
    historyCount.textContent = `${data.length} captured records`;
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">No history data available yet</td></tr>';
        return;
    }
    tbody.innerHTML = data.map(entry => {
        const pfClass = entry.PowerFactor >= 0.95 ? 'color:#00A651' : 'color:#ED1C24';
        return `<tr>
            <td>${entry.timestamp}</td>
            <td>${entry.Voltage?.toFixed(2)    || '---'}</td>
            <td>${entry.Current?.toFixed(2)    || '---'}</td>
            <td>${entry.Power?.toFixed(2)      || '---'}</td>
            <td>${entry.Energy?.toFixed(3)     || '---'}</td>
            <td style="${pfClass}">${entry.PowerFactor?.toFixed(3) || '---'}</td>
        </tr>`;
    }).join('');
}

// ====================================
// EXPORT & DELETE
// ====================================
async function exportSpreadsheet() {
    if (historyData.length === 0) {
        await showModal('Tidak Ada Data', 'Tidak ada data untuk diekspor!', 'warning', ['ok']);
        return;
    }
    const confirmed = await showModal('Konfirmasi Export',
        `Anda akan mengekspor ${historyData.length} record ke Excel.\n\n⚠️ PERHATIAN: Setelah ekspor berhasil, semua data history akan DIHAPUS dari Firebase!\n\nApakah Anda yakin ingin melanjutkan?`,
        'warning', ['confirm']);
    if (!confirmed) return;

    try {
        const excelData = historyData.map(entry => ({
            'Timestamp':             entry.timestamp,
            'Voltage (V)':           entry.Voltage?.toFixed(2)     || '',
            'Current (A)':           entry.Current?.toFixed(2)     || '',
            'Power (W)':             entry.Power?.toFixed(2)       || '',
            'Apparent Power (kVA)':  entry.Apparent?.toFixed(3)    || '',
            'Reactive Power (kVAR)': entry.Reactive?.toFixed(3)    || '',
            'Energy (kWh)':          entry.Energy?.toFixed(3)      || '',
            'Frequency (Hz)':        entry.Frequency?.toFixed(1)   || '',
            'Power Factor':          entry.PowerFactor?.toFixed(3) || ''
        }));

        const ws = XLSX.utils.json_to_sheet(excelData);
        ws['!cols'] = [
            { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
            { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }, { wch: 15 }
        ];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Energy History');

        const metadata = [
            ['Smart Energy Monitor - Export Report'], [''],
            ['Export Date',         new Date().toLocaleString('id-ID')],
            ['Total Records',       historyData.length],
            ['Device ID',           'alat1'], [''],
            ['Summary Statistics'],
            ['Average Voltage (V)',  calculateAverage(historyData, 'Voltage').toFixed(2)],
            ['Average Current (A)',  calculateAverage(historyData, 'Current').toFixed(2)],
            ['Average Power (W)',    calculateAverage(historyData, 'Power').toFixed(2)],
            ['Total Energy (kWh)',   calculateSum(historyData, 'Energy').toFixed(3)],
            ['Average Power Factor', calculateAverage(historyData, 'PowerFactor').toFixed(3)]
        ];
        const wsMeta = XLSX.utils.aoa_to_sheet(metadata);
        wsMeta['!cols'] = [{ wch: 25 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, wsMeta, 'Summary');

        XLSX.writeFile(wb, `Smart_Energy_History_${new Date().toISOString().split('T')[0]}_${Date.now()}.xlsx`);
        await deleteHistoryAfterExport();
    } catch (error) {
        await showModal('Export Gagal', 'Gagal mengekspor data!\n\nError: ' + error.message, 'error', ['ok']);
    }
}

function calculateAverage(data, field) {
    if (!data.length) return 0;
    return data.reduce((acc, e) => acc + (e[field] || 0), 0) / data.length;
}

function calculateSum(data, field) {
    return data.reduce((acc, e) => acc + (e[field] || 0), 0);
}

async function deleteHistoryAfterExport() {
    try {
        await database.ref('alat1/History').remove();
        await showModal('Export Berhasil!', 'Data telah disimpan ke file Excel dan history di Firebase telah dihapus.', 'success', ['ok']);
        historyData = [];
        updateHistoryUI([]);
    } catch (error) {
        await showModal('Perhatian', 'File Excel berhasil disimpan, tetapi gagal menghapus data dari Firebase.\n\nError: ' + error.message, 'warning', ['ok']);
    }
}

// ====================================
// CONTROL FUNCTIONS
// ====================================
async function clearRecords() {
    if (historyData.length === 0) {
        await showModal('Tidak Ada Data', 'Tidak ada data history yang perlu dihapus.', 'info', ['ok']);
        return;
    }
    const confirmed = await showModal('Konfirmasi Hapus Record',
        `Anda akan menghapus ${historyData.length} record history dari Firebase.\n\n⚠️ Data yang dihapus TIDAK DAPAT dikembalikan.\n\nApakah Anda yakin ingin melanjutkan?`,
        'warning', ['confirm']);
    if (!confirmed) return;
    try {
        await database.ref('alat1/History').remove();
        historyData = [];
        updateHistoryUI([]);
        await showModal('Berhasil Dihapus', 'Semua data record history telah berhasil dihapus dari Firebase.', 'success', ['ok']);
    } catch (error) {
        await showModal('Error', 'Gagal menghapus data record!\n\nError: ' + error.message, 'error', ['ok']);
    }
}

async function toggleCapture() {
    // Cek koneksi — jika offline tampilkan popup dan batalkan
    if (!isConnected) {
        await showModal('Device Offline',
            'Tidak dapat memulai capture.\nDevice sedang offline, pastikan device menyala dan terhubung ke internet.',
            'error', ['ok']);
        return;
    }

    const captureBtn = document.getElementById('captureBtn');
    captureActive = !captureActive;

    if (captureActive) {
        captureCount = 0;
        captureBtn.classList.add('active');
        captureBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> STOP CAPTURE`;

        try {
            await database.ref('alat1/Commands/resetEnergy').set({ command: true, timestamp: Date.now() });
            setTimeout(() => database.ref('alat1/Commands/resetEnergy').remove(), 5000);
        } catch (error) {
            console.error('Auto reset energy gagal:', error);
        }

        startCaptureInterval();
        await showModal('Capture Diaktifkan',
            `Mode capture telah diaktifkan.\n\nEnergy counter otomatis direset ke nol.\nData akan disimpan setiap ${captureInterval / 1000} detik ke Firebase History.`,
            'success', ['ok']);
    } else {
        stopCaptureInterval();
        captureBtn.classList.remove('active');
        captureBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg> START CAPTURE`;
        _captureWasActive = false;
        await showModal('Capture Dihentikan',
            `Mode capture telah dihentikan.\n\nTotal data yang tersimpan: ${captureCount} records.`,
            'info', ['ok']);
    }
}

function startCaptureInterval() {
    if (captureIntervalId) clearInterval(captureIntervalId);
    captureIntervalId = window.setInterval(() => {
        if (captureActive && realtimeData) captureDataToHistory();
    }, captureInterval);
}

function stopCaptureInterval() {
    if (captureIntervalId) { clearInterval(captureIntervalId); captureIntervalId = null; }
}

async function captureDataToHistory() {
    if (!realtimeData) return;
    try {
        const timestamp = new Date().toLocaleString('id-ID', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            day: '2-digit', month: '2-digit', year: 'numeric'
        }).replace(',', '');

        await database.ref(`/alat1/History/capture_${Date.now()}`).set({
            timestamp,
            Voltage:     realtimeData.Voltage     || 0,
            Current:     realtimeData.Current     || 0,
            Power:       realtimeData.Power       || 0,
            Apparent:    realtimeData.Apparent    || 0,
            Reactive:    realtimeData.Reactive    || 0,
            Energy:      realtimeData.Energy      || 0,
            Frequency:   realtimeData.Frequency   || 0,
            PowerFactor: realtimeData.PowerFactor || 0
        });
        captureCount++;
    } catch (error) {
        console.error('Error capturing data:', error);
    }
}

async function setCaptureInterval() {
    const intervalInput   = document.getElementById('intervalInput');
    const intervalUnit    = document.getElementById('intervalUnit');
    const intervalDisplay = document.getElementById('intervalDisplay');
    const value           = parseInt(intervalInput.value);
    const multiplier      = parseInt(intervalUnit.value);

    if (isNaN(value) || value < 1) {
        await showModal('Input Tidak Valid', 'Masukkan nilai interval yang valid (minimal 1)!', 'warning', ['ok']);
        return;
    }
    const intervalSeconds = value * multiplier;
    captureInterval = intervalSeconds * 1000;
    intervalDisplay.textContent = multiplier === 1
        ? `Current: ${value} seconds`
        : multiplier === 60
            ? `Current: ${value} minutes (${intervalSeconds}s)`
            : `Current: ${value} hours (${intervalSeconds}s)`;

    if (captureActive) startCaptureInterval();
    await showModal('Interval Diperbarui',
        `Interval capture berhasil diubah menjadi ${value} ${intervalUnit.options[intervalUnit.selectedIndex].text.toLowerCase()}.`,
        'success', ['ok']);
}

// ====================================
// SETTINGS
// ====================================
function loadSettings() {
    const savedThresholds = localStorage.getItem('thresholds');
    if (savedThresholds) thresholds = JSON.parse(savedThresholds);
    ['voltageMax','voltageMin','currentMax','powerMax','powerFactorMin','energyLimit'].forEach(id => {
        if (document.getElementById(id)) document.getElementById(id).value = thresholds[id];
    });

    const savedPrefs = localStorage.getItem('preferences');
    if (savedPrefs) preferences = JSON.parse(savedPrefs);
    ['decimalPlaces','updateRate'].forEach(id => {
        if (document.getElementById(id)) document.getElementById(id).value = preferences[id];
    });
    if (document.getElementById('soundAlerts'))  document.getElementById('soundAlerts').checked  = preferences.soundAlerts;
    if (document.getElementById('visualAlerts')) document.getElementById('visualAlerts').checked = preferences.visualAlerts;

    const savedAutoExport = localStorage.getItem('autoExportInterval');
    if (savedAutoExport) {
        autoExportInterval = savedAutoExport;
        if (document.getElementById('autoExportInterval')) {
            document.getElementById('autoExportInterval').value = autoExportInterval;
            updateAutoExportStatus();
        }
    }
}

async function saveThresholds() {
    thresholds = {
        voltageMax:     parseFloat(document.getElementById('voltageMax').value),
        voltageMin:     parseFloat(document.getElementById('voltageMin').value),
        currentMax:     parseFloat(document.getElementById('currentMax').value),
        powerMax:       parseFloat(document.getElementById('powerMax').value),
        powerFactorMin: parseFloat(document.getElementById('powerFactorMin').value),
        energyLimit:    parseFloat(document.getElementById('energyLimit').value)
    };
    localStorage.setItem('thresholds', JSON.stringify(thresholds));
    await showModal('Pengaturan Disimpan', 'Threshold alert telah berhasil disimpan!', 'success', ['ok']);
}

async function resetThresholds() {
    const confirmed = await showModal('Konfirmasi Reset',
        'Apakah Anda yakin ingin mereset semua threshold ke nilai default?',
        'warning', ['confirm']);
    if (!confirmed) return;
    thresholds = { voltageMax: 240, voltageMin: 200, currentMax: 20, powerMax: 4400, powerFactorMin: 0.85, energyLimit: 1000 };
    ['voltageMax','voltageMin','currentMax','powerMax','powerFactorMin','energyLimit'].forEach(id => {
        if (document.getElementById(id)) document.getElementById(id).value = thresholds[id];
    });
    localStorage.setItem('thresholds', JSON.stringify(thresholds));
    await showModal('Reset Berhasil', 'Semua threshold telah direset ke nilai default.', 'success', ['ok']);
}

function checkThresholds(data) {
    if (!preferences.visualAlerts) return;
    const triggered =
        data.Voltage     >  thresholds.voltageMax     ||
        data.Voltage     <  thresholds.voltageMin     ||
        data.Current     >  thresholds.currentMax     ||
        data.Power       >  thresholds.powerMax       ||
        data.PowerFactor <  thresholds.powerFactorMin ||
        data.Energy      >  thresholds.energyLimit;

    if (triggered) {
        const lastAlertTime = parseInt(localStorage.getItem('lastAlertTime') || 0);
        if (Date.now() - lastAlertTime > 60000) {
            localStorage.setItem('lastAlertTime', Date.now());
            if (preferences.soundAlerts) playAlertSound();
        }
    }
}

function playAlertSound() {
    try {
        const ac   = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ac.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.5);
        osc.start(ac.currentTime);
        osc.stop(ac.currentTime + 0.5);
    } catch (e) { console.error('Audio error:', e); }
}

async function savePreferences() {
    preferences = {
        decimalPlaces: parseInt(document.getElementById('decimalPlaces').value),
        updateRate:    parseInt(document.getElementById('updateRate').value),
        soundAlerts:   document.getElementById('soundAlerts').checked,
        visualAlerts:  document.getElementById('visualAlerts').checked
    };
    localStorage.setItem('preferences', JSON.stringify(preferences));
    await showModal('Preferensi Disimpan', 'Preferensi tampilan telah berhasil disimpan!', 'success', ['ok']);
}

async function toggleAutoExport() {
    const selectElement = document.getElementById('autoExportInterval');
    autoExportInterval  = selectElement.value;
    localStorage.setItem('autoExportInterval', autoExportInterval);
    updateAutoExportStatus();
    if (autoExportInterval === '0') {
        await showModal('Auto-Export Dinonaktifkan', 'Fitur auto-export telah dinonaktifkan.', 'info', ['ok']);
    } else {
        await showModal('Auto-Export Diaktifkan',
            `Auto-export diatur ke: ${selectElement.options[selectElement.selectedIndex].text}`,
            'success', ['ok']);
    }
}

function updateAutoExportStatus() {
    const statusElement = document.getElementById('autoExportStatus');
    const selectElement = document.getElementById('autoExportInterval');
    if (!statusElement || !selectElement) return;
    statusElement.textContent = autoExportInterval === '0'
        ? 'Status: Disabled'
        : `Status: ${selectElement.options[selectElement.selectedIndex].text}`;
}

// ====================================
// INITIALIZE APP
// ====================================
document.addEventListener('DOMContentLoaded', async () => {
    loadChartDataFromStorage();
    await loadDailyAggFromFirebase();

    initChart();

    const parameterSelect = document.getElementById('parameterSelect');
    if (parameterSelect) parameterSelect.addEventListener('change', changeParameter);

    document.querySelectorAll('.metric-card-compact').forEach(card => {
        if (!card.dataset.param) return;
        card.addEventListener('click', () => _switchParameter(card.dataset.param));
    });

    document.querySelectorAll('.metric-card-compact').forEach(card => {
        card.classList.toggle('card-active', card.dataset.param === selectedParameter);
    });

    initRealtimeListener();
    initHistoryListener();
    updateConnectionStatus(false);
    startConnectionMonitoring();
    loadSettings();
});

window.addEventListener('beforeunload', () => {
    saveChartDataToStorage();
    if (_lastDayStr) _flushDailyAgg(_lastDayStr);
});