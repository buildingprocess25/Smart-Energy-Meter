// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// State
let realtimeData = null;
let historyData = [];
let isConnected = false;
let lastDataTimestamp = 0;
let connectionCheckInterval = null;

// Fingerprint data terakhir yang diterima saat reload (cached/stale).
// Device dianggap ONLINE hanya jika Firebase mengirim data dengan nilai BERBEDA
// dari snapshot awal — bukan hanya karena listener fire (bisa 2x meski device mati).
let _staleFingerprint = null;

// Chart state
let realtimeChart = null;
let chartData = {
    labels: [],
    timestamps: [],
    voltage: [],
    current: [],
    power: [],
    frequency: [],
    apparent: [],
    reactive: [],
    energy: [],
    powerFactor: []
};

const MAX_DATA_POINTS     = 300;   // titik in-memory untuk tampilan & localStorage
const SAVE_EVERY_N_POINTS = 60;    // auto-save localStorage setiap 60 titik baru

let selectedParameter = 'voltage';

// Time filter state: 'all' | 'day' | 'hour' | 'minute'
let timeFilter = 'all';

// Capture state
let captureActive = false;
let captureCount = 0;
let captureInterval = 3000;
let captureIntervalId = null;

// Settings state
let thresholds = {
    voltageMax: 240,
    voltageMin: 200,
    currentMax: 20,
    powerMax: 4400,
    powerFactorMin: 0.85,
    energyLimit: 1000
};

let preferences = {
    decimalPlaces: 2,
    updateRate: 2000,
    soundAlerts: false,
    visualAlerts: true
};

let autoExportEnabled = false;
let autoExportInterval = '0';

// ====================================
// CHART PERSISTENCE — localStorage
// Data chart disimpan di browser, bukan Firebase.
// Tidak makan kuota Firebase, persist saat reload,
// bekerja di semua deployment (Render, Vercel, dll).
// ====================================
const CHART_STORAGE_KEY = 'sem_chartdata_v1'; // ganti suffix jika ingin reset semua user
const CHART_KEYS = ['labels','timestamps','voltage','current','power',
                    'frequency','apparent','reactive','energy','powerFactor'];
let _saveCounter   = 0;
// True saat user sedang zoom/pan manual — chart tidak auto-follow ke titik terbaru
let _userIsZoomed  = false;

/**
 * Muat chartData dari localStorage.
 * Sinkron, dipanggil sebelum initChart().
 */
function loadChartDataFromStorage() {
    try {
        const raw = localStorage.getItem(CHART_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        const valid = CHART_KEYS.every(k => Array.isArray(saved[k]));
        if (!valid) return;
        CHART_KEYS.forEach(k => { chartData[k] = saved[k]; });

        // Pruning: buang data yang lebih tua dari 24 jam agar grafik
        // tidak campur data hari ini dengan data kemarin/lama.
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const firstRecent = chartData.timestamps.findIndex(t => t >= cutoff);
        if (firstRecent > 0) {
            CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(firstRecent); });
            console.log(`[ChartStorage] Pruned ${firstRecent} stale points (> 24 jam).`);
        } else if (firstRecent === -1) {
            // Semua data sudah kadaluarsa — reset total
            CHART_KEYS.forEach(k => { chartData[k] = []; });
            console.log('[ChartStorage] Semua data kadaluarsa, chart di-reset.');
            return;
        }

        console.log(`[ChartStorage] Loaded ${chartData.labels.length} points from localStorage.`);
    } catch (e) {
        console.warn('[ChartStorage] Gagal memuat:', e);
    }
}

/**
 * Simpan chartData ke localStorage (sinkron, ringan).
 */
function saveChartDataToStorage() {
    try {
        const payload = {};
        CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
        localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        // localStorage penuh (5 MB limit) — pangkas data lama lalu coba lagi
        console.warn('[ChartStorage] Storage penuh, memangkas data lama...');
        CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(-100); });
        try {
            const payload = {};
            CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
            localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
        } catch (_) { /* biarkan jika tetap gagal */ }
    }
}

/**
 * Dipanggil setiap titik baru masuk.
 * Auto-save setiap SAVE_EVERY_N_POINTS; save final saat tab ditutup/reload.
 */
function maybeSaveChartData() {
    _saveCounter++;
    if (_saveCounter >= SAVE_EVERY_N_POINTS) {
        _saveCounter = 0;
        saveChartDataToStorage();
    }
}

/**
 * Hapus chart dari localStorage.
 */
function clearChartDataFromStorage() {
    _saveCounter = 0;
    localStorage.removeItem(CHART_STORAGE_KEY);
}

// ====================================
// CUSTOM MODAL FUNCTIONS
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
            cancelBtn.className = 'modal-btn modal-btn-secondary';
            cancelBtn.textContent = 'BATAL';
            cancelBtn.onclick = () => { closeModal(); resolve(false); };
            modalButtons.appendChild(cancelBtn);

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-primary';
            confirmBtn.textContent = 'YA, LANJUTKAN';
            confirmBtn.onclick = () => { closeModal(); resolve(true); };
            modalButtons.appendChild(confirmBtn);
        } else {
            const okBtn = document.createElement('button');
            okBtn.className = 'modal-btn modal-btn-primary';
            okBtn.textContent = 'OK';
            okBtn.onclick = () => { closeModal(); resolve(true); };
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

document.addEventListener('click', e => {
    if (e.target === document.getElementById('customModal')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ====================================
// ZOOM RESET
// ====================================
function resetZoom() {
    if (realtimeChart) {
        realtimeChart.resetZoom();
        _userIsZoomed = false; // user kembali ke view normal → aktifkan auto-follow
    }
}

// ====================================
// TIME FILTER
// ====================================
function setTimeFilter(filter) {
    timeFilter    = filter;
    _userIsZoomed = false; // reset zoom state saat filter berubah
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
        minute: { buckets: 60, bucketMs: 60_000,            windowMs: 60 * 60_000,           fmt: 'HH:MM'  },
        hour:   { buckets: 24, bucketMs: 60 * 60_000,       windowMs: 24 * 60 * 60_000,      fmt: 'HH:00'  },
        day:    { buckets: 7,  bucketMs: 24 * 60 * 60_000,  windowMs: 7 * 24 * 60 * 60_000,  fmt: 'DD/MM'  }
    };
    return configs[timeFilter] || null;
}

function getAggregatedChartData() {
    const raw = chartData[selectedParameter];
    const ts  = chartData.timestamps;

    if (timeFilter === 'all') return { labels: chartData.labels, values: raw };

    const cfg = getFilterConfig();
    if (!cfg) return { labels: chartData.labels, values: raw };

    const now = Date.now();
    let alignedNow;
    const d = new Date(now);
    if (timeFilter === 'minute') {
        alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + 1, 0, 0).getTime();
    } else if (timeFilter === 'hour') {
        alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
    } else {
        alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
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
        // Selalu gunakan AWAL bucket sebagai label (konsisten semua filter).
        // Bug lama: Hour/Min pakai (i+1)*bucketMs → label satu periode ke depan.
        // Contoh: data jam 14:xx → seharusnya label '14:00', bukan '15:00'.
        const labelTime = new Date(windowStart + i * cfg.bucketMs);
        labels.push(formatBucketLabel(labelTime, cfg.fmt));
        values.push(counts[i] > 0 ? parseFloat((sums[i] / counts[i]).toFixed(4)) : null);
    }

    return { labels, values };
}

function formatBucketLabel(d, fmt) {
    const pad = v => String(v).padStart(2, '0');
    switch (fmt) {
        case 'DD/MM':    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        case 'HH:00':   return `${pad(d.getHours())}:00`;
        case 'HH:MM':   return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        default:         return d.toLocaleTimeString('id-ID');
    }
}

function refreshChartWithFilter() {
    const canvas = document.getElementById('realtimeChart');
    if (!canvas) return;
    const wrap = canvas.parentElement;

    // Fade out
    wrap.style.transition = 'opacity 0.18s ease';
    wrap.style.opacity    = '0';

    setTimeout(() => {
        if (realtimeChart) { realtimeChart.destroy(); realtimeChart = null; }
        initChart();
        // Fade in
        wrap.style.opacity = '1';
    }, 180);
}

function updateFilterInfo(_values) {
    const el = document.getElementById('filterInfo');
    if (el) el.textContent = '';
}

// ====================================
// CHART FUNCTIONS
// ====================================
/**
 * Hitung min/max y-axis dengan padding tetap per parameter.
 * Tujuan: nilai seperti 226–228 V tetap terlihat jarak perubahannya,
 * bukan gepeng di tengah chart.
 */
function getYBounds(values, param) {
    // Padding minimum per parameter (satu sisi)
    const padMap = {
        voltage:     10,    // ±10 V  → range minimal 20 V
        current:     1,     // ±1 A
        power:       50,    // ±50 W
        frequency:   1,     // ±1 Hz
        apparent:    0.05,  // ±0.05 kVA
        reactive:    0.05,  // ±0.05 kVAR
        energy:      0.1,   // ±0.1 kWh
        powerFactor: 0.05   // ±0.05
    };
    const pad = padMap[param] ?? 5;

    const clean = (values || []).filter(v => v !== null && v !== undefined && isFinite(v));
    if (clean.length === 0) return { yMin: undefined, yMax: undefined };

    const dataMin = Math.min(...clean);
    const dataMax = Math.max(...clean);
    const dataRange = dataMax - dataMin;

    // Jika range data lebih kecil dari 2× padding, gunakan padding tetap
    // Jika lebih besar, tambahkan 15% dari range agar tetap ada napas
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

    const info      = parameterInfo[selectedParameter];
    const isBar     = (timeFilter === 'day' || timeFilter === 'hour');
    const isAgg     = (timeFilter !== 'all');
    const isMinute  = (timeFilter === 'minute');

    const { labels, values } = getAggregatedChartData();

    const xTitles = {
        all:    'Waktu',
        minute: '60 Menit Terakhir',
        hour:   '24 Jam Terakhir',
        day:    '7 Hari Terakhir'
    };

    const gradientFill = (() => {
        const c2d  = ctx.getContext('2d');
        const g    = c2d.createLinearGradient(0, 0, 0, ctx.clientHeight || 300);
        // Minute view: fill lebih tebal agar area tren mudah dibaca
        const top  = isMinute ? '88' : '55';
        const bot  = isMinute ? '10' : '05';
        g.addColorStop(0, info.color + top);
        g.addColorStop(1, info.color + bot);
        return g;
    })();

    realtimeChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        data: {
            labels,
            datasets: [{
                label:                   info.unit ? `${info.label} (${info.unit})` : info.label,
                data:                    values,
                borderColor:             info.borderColor,
                backgroundColor:         isBar ? info.color + 'BB' : gradientFill,
                borderWidth:             isBar ? 1.5 : (isMinute ? 2.5 : 2),
                tension:                 isMinute ? 0.5 : 0.4,
                cubicInterpolationMode:  'monotone',
                spanGaps:                isMinute, // sambung garis melewati bucket kosong
                fill:                    !isBar,
                pointRadius:             isBar ? 0 : (isMinute ? 0 : (isAgg ? 4 : (chartData.labels.length > 150 ? 0 : 2))),
                pointHoverRadius:        isBar ? 0 : (isMinute ? 5 : 6),
                pointBackgroundColor:    info.borderColor,
                pointBorderColor:        '#fff',
                pointBorderWidth:        1.5,
                borderRadius:            isBar ? 5 : 0,
                borderSkipped:           false
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
                    display:  true, position: 'top',
                    labels: {
                        font:          { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial', size: 11, weight: 700 },
                        color:         '#666666', usePointStyle: true,
                        pointStyle:    isBar ? 'rect' : 'circle', padding: 12
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(20,20,20,0.9)',
                    titleFont:       { size: 12, weight: 700 },
                    bodyFont:        { size: 11 },
                    padding: 12, cornerRadius: 10, displayColors: false, caretSize: 6,
                    callbacks: {
                        title: items => ({ minute: ' ', hour: ' ', day: ' ', all: ' ' }[timeFilter] || ' ') + (items[0]?.label || ''),
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
                        wheel:   { enabled: true, speed: 0.08 },
                        pinch:   { enabled: true },
                        mode:    'x',
                        onZoom:  () => { _userIsZoomed = true; }
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
                    grid:   { color: 'rgba(0,0,0,0.04)', drawTicks: false },
                    ticks:  { maxRotation: isMinute ? 0 : 45, minRotation: 0, font: { size: 9 }, color: '#999999', maxTicksLimit: isBar ? 7 : (isMinute ? 10 : (isAgg ? 12 : 15)), padding: 4 },
                    offset: isBar
                },
                y: (() => {
                    const { yMin, yMax } = getYBounds(values, selectedParameter);
                    return {
                        display: true,
                        title: { display: true, text: info.unit ? `${info.label} (${info.unit})` : info.label, font: { size: 11, weight: 700 }, color: '#666666' },
                        grid:   { color: 'rgba(0,0,0,0.05)', drawTicks: false },
                        ticks:  {
                            font: { size: 9 }, color: '#999999', padding: 6,
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

/**
 * Tambah titik baru ke chartData dan update chart secara realtime.
 * Firebase TIDAK dipanggil di sini kecuali threshold terpenuhi.
 */
function updateChart(data) {
    if (!realtimeChart) return;

    const now       = new Date();
    const timeLabel = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Tambah titik baru ke array in-memory
    chartData.labels.push(timeLabel);
    chartData.timestamps.push(Date.now());
    chartData.voltage.push(data.Voltage     || 0);
    chartData.current.push(data.Current     || 0);
    chartData.power.push(data.Power         || 0);
    chartData.frequency.push(data.Frequency || 0);
    chartData.apparent.push(data.Apparent   || 0);
    chartData.reactive.push(data.Reactive   || 0);
    chartData.energy.push(data.Energy       || 0);
    chartData.powerFactor.push(data.PowerFactor || 0);

    // Buang titik paling lama jika melebihi batas in-memory
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

    // Cek apakah perlu simpan snapshot ke Firebase (jarang)
    maybeSaveChartData();

    // Update chart tampilan secara realtime (tanpa animasi agar smooth)
    const { labels, values } = getAggregatedChartData();
    realtimeChart.data.labels               = labels;
    realtimeChart.data.datasets[0].data     = values;

    // Sembunyikan titik saat data sudah banyak (performa lebih baik)
    if (timeFilter === 'all') {
        realtimeChart.data.datasets[0].pointRadius = chartData.labels.length > 150 ? 0 : 2;
    }

    realtimeChart.update('none'); // 'none' = tanpa animasi, paling cepat untuk realtime

    // Auto-follow: geser view ke titik terbaru secara otomatis,
    // KECUALI user sedang zoom/pan manual (tidak ingin diganggu).
    if (timeFilter === 'all' && !_userIsZoomed && realtimeChart.data.labels.length > 0) {
        _scrollToLatest();
    }

    updateFilterInfo(values);
}

/**
 * Geser x-axis chart agar titik terbaru selalu terlihat di sisi kanan.
 * Tampilkan maksimal 60 titik terakhir di layar agar tidak terlalu padat.
 */
function _scrollToLatest() {
    const total    = realtimeChart.data.labels.length;
    const visible  = Math.min(60, total);        // jumlah titik yang ditampilkan sekaligus
    const minIndex = total - visible;
    const maxIndex = total - 1;
    try {
        realtimeChart.zoomScale('x', { min: minIndex, max: maxIndex }, 'none');
    } catch (_) { /* chart belum siap */ }
}

function changeParameter() {
    selectedParameter = document.getElementById('parameterSelect').value;
    _switchParameter(selectedParameter);
}

/**
 * Pusat pergantian parameter — dipanggil dari dropdown MAUPUN klik metric card.
 * Sinkronkan dropdown, highlight card aktif, fade chart.
 */
function _switchParameter(param) {
    selectedParameter = param;
    _userIsZoomed     = false;

    // Sinkronkan dropdown
    const sel = document.getElementById('parameterSelect');
    if (sel) sel.value = param;

    // Highlight metric card yang aktif
    document.querySelectorAll('.metric-card-compact').forEach(card => {
        card.classList.toggle('card-active', card.dataset.param === param);
    });

    // Fade chart
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
        realtimeChart.data.labels            = [];
        realtimeChart.data.datasets[0].data  = [];
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

    if (tabName === 'realtime') {
        document.getElementById('realtimeTab').classList.add('active');
        document.getElementById('realtimeContent').classList.add('active');
    } else if (tabName === 'history') {
        document.getElementById('historyTab').classList.add('active');
        document.getElementById('historyContent').classList.add('active');
    } else if (tabName === 'settings') {
        document.getElementById('settingsTab').classList.add('active');
        document.getElementById('settingsContent').classList.add('active');
        loadSettings();
    }
}

// ====================================
// REALTIME DATA LISTENER
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

        // Buat fingerprint dari nilai-nilai sensor utama
        const fp = `${data.Voltage}|${data.Current}|${data.Power}|${data.Energy}|${data.Frequency}`;

        if (_staleFingerprint === null) {
            // Fire PERTAMA = data cached dari Firebase (bisa stale).
            // Simpan fingerprint-nya, tampilkan di card, tapi jangan set ONLINE.
            _staleFingerprint = fp;
            updateDisplayCards(data);
            return;
        }

        if (fp === _staleFingerprint) {
            // Firebase fire ke-2 dengan nilai SAMA = server konfirmasi data lama.
            // Device tidak mengirim data baru → tetap OFFLINE, jangan update chart.
            return;
        }

        // Fingerprint BERUBAH = device benar-benar mengirim data baru → ONLINE
        _staleFingerprint = fp; // update untuk perbandingan berikutnya
        lastDataTimestamp = Date.now();
        isConnected       = true;
        updateRealtimeUI(data);
        updateConnectionStatus(true);
        checkThresholds(data);
    }, () => { isConnected = false; updateConnectionStatus(false); });
}

/** Hanya update card display (nilai sensor), tanpa sentuh chart atau status koneksi. */
function updateDisplayCards(data) {
    const now = new Date();
    document.getElementById('lastUpdate').textContent      = `Last update: ${now.toLocaleTimeString('id-ID')}`;
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
    const now = new Date();
    document.getElementById('lastUpdate').textContent      = `Last update: ${now.toLocaleTimeString('id-ID')}`;
    document.getElementById('voltage').textContent         = data.Voltage?.toFixed(2)     || '---';
    document.getElementById('current').textContent         = data.Current?.toFixed(2)     || '---';
    document.getElementById('power').textContent           = data.Power?.toFixed(2)       || '---';
    document.getElementById('frequency').textContent       = data.Frequency?.toFixed(1)   || '---';
    document.getElementById('apparent').textContent        = data.Apparent?.toFixed(3)    || '---';
    document.getElementById('reactive').textContent        = data.Reactive?.toFixed(3)    || '---';
    document.getElementById('energy').textContent          = data.Energy?.toFixed(3)      || '---';
    document.getElementById('powerFactor').textContent     = data.PowerFactor?.toFixed(3) || '---';
    updateChart(data);
}

// ====================================
// CONNECTION STATUS
// ====================================
function updateConnectionStatus(connected) {
    const statusDot  = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    if (connected) {
        statusDot.classList.add('online');  statusDot.classList.remove('offline');
        statusText.textContent = 'ONLINE';
    } else {
        statusDot.classList.add('offline'); statusDot.classList.remove('online');
        statusText.textContent = 'OFFLINE';
    }
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
// HISTORY DATA LISTENER
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
        ws['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Energy History');

        const metadata = [
            ['Smart Energy Monitor - Export Report'], [''],
            ['Export Date',          new Date().toLocaleString('id-ID')],
            ['Total Records',        historyData.length],
            ['Device ID',            'alat1'], [''],
            ['Summary Statistics'],
            ['Average Voltage (V)',  calculateAverage(historyData, 'Voltage').toFixed(2)],
            ['Average Current (A)',  calculateAverage(historyData, 'Current').toFixed(2)],
            ['Average Power (W)',    calculateAverage(historyData, 'Power').toFixed(2)],
            ['Total Energy (kWh)',   calculateSum(historyData, 'Energy').toFixed(3)],
            ['Average Power Factor', calculateAverage(historyData, 'PowerFactor').toFixed(3)]
        ];
        const ws_meta = XLSX.utils.aoa_to_sheet(metadata);
        ws_meta['!cols'] = [{ wch: 25 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws_meta, 'Summary');

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
    const captureBtn    = document.getElementById('captureBtn');
    const captureStatus = document.getElementById('captureStatus');
    captureActive = !captureActive;

    if (captureActive) {
        captureCount = 0;
        captureBtn.classList.add('active');
        captureBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> STOP CAPTURE`;
        captureStatus.textContent = 'Status: Active (0 captures)';

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
        captureStatus.textContent = 'Status: Inactive';
        await showModal('Capture Dihentikan', `Mode capture telah dihentikan.\n\nTotal data yang tersimpan: ${captureCount} records.`, 'info', ['ok']);
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
        document.getElementById('captureStatus').textContent = `Status: Active (${captureCount} captures)`;
    } catch (error) {
        console.error('Error capturing data:', error);
    }
}

async function setCaptureInterval() {
    const intervalInput   = document.getElementById('intervalInput');
    const intervalUnit    = document.getElementById('intervalUnit');
    const intervalDisplay = document.getElementById('intervalDisplay');
    const value      = parseInt(intervalInput.value);
    const multiplier = parseInt(intervalUnit.value);

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
// SETTINGS FUNCTIONS
// ====================================
function loadSettings() {
    const savedThresholds = localStorage.getItem('thresholds');
    if (savedThresholds) thresholds = JSON.parse(savedThresholds);
    ['voltageMax','voltageMin','currentMax','powerMax','powerFactorMin','energyLimit'].forEach(id => {
        if (document.getElementById(id)) document.getElementById(id).value = thresholds[id];
    });

    const savedPreferences = localStorage.getItem('preferences');
    if (savedPreferences) preferences = JSON.parse(savedPreferences);
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
    const confirmed = await showModal('Konfirmasi Reset', 'Apakah Anda yakin ingin mereset semua threshold ke nilai default?', 'warning', ['confirm']);
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
        osc.connect(gain); gain.connect(ac.destination);
        osc.frequency.value = 800; osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ac.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ac.currentTime + 0.5);
        osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.5);
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
        await showModal('Auto-Export Diaktifkan', `Auto-export diatur ke: ${selectElement.options[selectElement.selectedIndex].text}`, 'success', ['ok']);
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
document.addEventListener('DOMContentLoaded', () => {
    // Muat chart dari localStorage (sinkron, tidak perlu async)
    loadChartDataFromStorage();

    initChart();
    const parameterSelect = document.getElementById('parameterSelect');
    if (parameterSelect) parameterSelect.addEventListener('change', changeParameter);

    // Klik metric card → ganti parameter chart
    document.querySelectorAll('.metric-card-compact').forEach(card => {
        if (!card.dataset.param) return;
        card.addEventListener('click', () => _switchParameter(card.dataset.param));
    });
    // Highlight card aktif awal (voltage)
    document.querySelectorAll('.metric-card-compact').forEach(card => {
        card.classList.toggle('card-active', card.dataset.param === selectedParameter);
    });
    initRealtimeListener();
    initHistoryListener();
    updateConnectionStatus(false);
    startConnectionMonitoring();
    loadSettings();
});

// Simpan chart ke localStorage sesaat sebelum tab ditutup atau di-reload.
// Ini memastikan data terbaru selalu tersimpan meski belum mencapai threshold 60 titik.
window.addEventListener('beforeunload', () => {
    saveChartDataToStorage();
});