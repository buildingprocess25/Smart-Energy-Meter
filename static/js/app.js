// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// State
let realtimeData = null;
let historyData = [];
let isConnected = false;
let lastDataTimestamp = 0;
let connectionCheckInterval = null;

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
const MAX_DATA_POINTS = 1000;
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
// CUSTOM MODAL FUNCTIONS
// ====================================
function showModal(title, message, type = 'info', buttons = ['ok']) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalMessage = document.getElementById('modalMessage');
        const modalIcon = document.getElementById('modalIcon');
        const modalButtons = document.getElementById('modalButtons');

        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalIcon.className = 'modal-icon ' + type;

        let iconSVG = '';
        if (type === 'success') {
            iconSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        } else if (type === 'warning') {
            iconSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
        } else if (type === 'error') {
            iconSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
        } else {
            iconSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
        }
        modalIcon.innerHTML = iconSVG;

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
    const modal = document.getElementById('customModal');
    modal.classList.remove('active');
    document.body.style.overflow = '';
}

document.addEventListener('click', (e) => {
    const modal = document.getElementById('customModal');
    if (e.target === modal) closeModal();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});

// ====================================
// ZOOM RESET
// ====================================
function resetZoom() {
    if (realtimeChart) realtimeChart.resetZoom();
}

// ====================================
// TIME FILTER
// ====================================
function setTimeFilter(filter) {
    timeFilter = filter;
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
        minute: {
            buckets: 60,
            bucketMs: 60_000,           // 1 menit per bucket
            windowMs: 60 * 60_000,      // 60 menit total
            fmt: 'HH:MM'
        },
        hour: {
            buckets: 24,
            bucketMs: 60 * 60_000,      // 1 jam per bucket
            windowMs: 24 * 60 * 60_000, // 24 jam total
            fmt: 'HH:00'
        },
        day: {
            buckets: 7,
            bucketMs: 24 * 60 * 60_000, // 1 hari per bucket
            windowMs: 7 * 24 * 60 * 60_000, // 7 hari total
            fmt: 'DD/MM'
        }
    };
    return configs[timeFilter] || null;
}

function getAggregatedChartData() {
    const param = selectedParameter;
    const raw   = chartData[param];
    const ts    = chartData.timestamps;

    if (timeFilter === 'all') {
        return { labels: chartData.labels, values: raw };
    }

    const cfg = getFilterConfig();
    if (!cfg) return { labels: chartData.labels, values: raw };

    // SESUDAH (kode baru):
    const now = Date.now();

    // Sejajarkan windowStart ke boundary jam clock yang sebenarnya,
    // agar bucket i = menit/jam/hari clock yang nyata — bukan "mengambang".
    let alignedNow;
    {
        const d = new Date(now);
        if (timeFilter === 'minute') {
            // Batas atas = awal menit BERIKUTNYA → label "13:01" = data 13:00:00–13:00:59
            alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                                d.getHours(), d.getMinutes() + 1, 0, 0).getTime();
        } else if (timeFilter === 'hour') {
            // Batas atas = awal jam berikutnya
            alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                                d.getHours() + 1, 0, 0, 0).getTime();
        } else { // day
            // Batas atas = tengah malam hari berikutnya
            alignedNow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1,
                                0, 0, 0, 0).getTime();
        }
    }
    const windowStart = alignedNow - cfg.windowMs;

    // Hitung rata-rata per bucket
    const sums   = new Array(cfg.buckets).fill(0);
    const counts = new Array(cfg.buckets).fill(0);
    const mins   = new Array(cfg.buckets).fill(Infinity);
    const maxs   = new Array(cfg.buckets).fill(-Infinity);

    for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t < windowStart || t > now) continue;
        const idx = Math.floor((t - windowStart) / cfg.bucketMs);
        if (idx < 0 || idx >= cfg.buckets) continue;
        sums[idx]   += raw[i];
        counts[idx] += 1;
        if (raw[i] < mins[idx]) mins[idx] = raw[i];
        if (raw[i] > maxs[idx]) maxs[idx] = raw[i];
    }

    const labels = [];
    const values = [];

    for (let i = 0; i < cfg.buckets; i++) {
        // Label = AKHIR bucket (end-of-bucket), bukan awal.
        // Contoh: data 13:00:00–13:00:59 → label "13:01"
        // Khusus 'day': tampilkan hari bucket itu sendiri (awal bucket)
        const labelTime = timeFilter === 'day'
            ? new Date(windowStart + i * cfg.bucketMs)
            : new Date(windowStart + (i + 1) * cfg.bucketMs);
        labels.push(formatBucketLabel(labelTime, cfg.fmt));

        if (counts[i] > 0) {
            values.push(parseFloat((sums[i] / counts[i]).toFixed(4)));
        } else {
            // Bucket kosong — null agar spanGaps bisa menghubungkan
            values.push(null);
        }
    }

    return { labels, values };
}

function formatBucketLabel(d, fmt) {
    const pad = v => String(v).padStart(2, '0');
    switch (fmt) {
        case 'DD/MM':    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        case 'HH:00':   return `${pad(d.getHours())}:00`;
        case 'HH:MM':   return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        case 'HH:MM:SS':return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        default:         return d.toLocaleTimeString('id-ID');
    }
}

function refreshChartWithFilter() {
    if (realtimeChart) { realtimeChart.destroy(); realtimeChart = null; }
    initChart();
}

function updateFilterInfo(values) {
    const el = document.getElementById('filterInfo');
    if (!el) return;

    if (timeFilter === 'all') {
        el.textContent = `${chartData.labels.length} titik data (raw)`;
        return;
    }

    const nonNull = (values || []).filter(v => v !== null).length;
    const desc = {
        minute: '60 bucket · avg/menit',
        hour:   '24 bucket · avg/jam',
        day:    '7 bucket  · avg/hari'
    }[timeFilter] || '';
    el.textContent = `${nonNull} bucket aktif · ${desc}`;
}

// ====================================
// CHART FUNCTIONS
// ====================================
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

    const info = parameterInfo[selectedParameter];

    // Semua view pakai line, hanya day pakai bar
    const isBar  = (timeFilter === 'day');
    const isAgg  = (timeFilter !== 'all');

    const { labels, values } = getAggregatedChartData();

    const xTitles = {
        all:    'Waktu',
        minute: 'Menit (60 menit terakhir)',
        hour:   'Jam (24 jam terakhir)',
        day:    'Hari (7 hari terakhir)'
    };

    // Gradient fill — dibuat setelah chart dibuat untuk akses ctx
    const gradientFill = (() => {
        const c2d = ctx.getContext('2d');
        const g   = c2d.createLinearGradient(0, 0, 0, ctx.clientHeight || 300);
        g.addColorStop(0, info.color + '55');
        g.addColorStop(1, info.color + '05');
        return g;
    })();

    realtimeChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        data: {
            labels,
            datasets: [{
                label: info.unit ? `${info.label} (${info.unit})` : info.label,
                data: values,

                // Line style
                borderColor:              info.borderColor,
                backgroundColor:          isBar ? info.color + 'BB' : gradientFill,
                borderWidth:              isBar ? 1.5 : 2,

                // Smooth curve — monotone agar tidak overshoot
                tension:                  0.4,
                cubicInterpolationMode:   'monotone',
                fill:                     !isBar,

                // Point styling
                pointRadius:              isBar ? 0 : (isAgg ? 4 : (chartData.labels.length > 200 ? 0 : 2)),
                pointHoverRadius:         isBar ? 0 : 6,
                pointBackgroundColor:     info.borderColor,
                pointBorderColor:         '#fff',
                pointBorderWidth:         1.5,

                // Bar style
                borderRadius:             isBar ? 5 : 0,
                borderSkipped:            false,

                // Smooth step animation
                stepped:                  false
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            interaction:         { intersect: false, mode: 'index' },

            // Animasi lebih smooth
            animation: {
                duration: 400,
                easing:   'easeInOutQuart'
            },
            transitions: {
                active: {
                    animation: { duration: 200 }
                }
            },

            plugins: {
                legend: {
                    display:  true,
                    position: 'top',
                    labels: {
                        font:           { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial', size: 11, weight: 700 },
                        color:          '#666666',
                        usePointStyle:  true,
                        pointStyle:     isBar ? 'rect' : 'circle',
                        padding:        12
                    }
                },
                tooltip: {
                    backgroundColor:  'rgba(20,20,20,0.9)',
                    titleFont:        { size: 12, weight: 700 },
                    bodyFont:         { size: 11 },
                    padding:          12,
                    cornerRadius:     10,
                    displayColors:    false,
                    caretSize:        6,
                    callbacks: {
                        title: function(items) {
                            const label = items[0]?.label || '';
                            const prefix = {
                                minute: ' ',
                                hour:   ' ',
                                day:    ' ',
                                all:    ' '
                            }[timeFilter] || '';
                            return prefix + label;
                        },
                        label: function(ctx) {
                            const val = ctx.parsed.y;
                            if (val === null || val === undefined) return '  Tidak ada data';
                            const unit   = info.unit ? ` ${info.unit}` : '';
                            const prefix = isAgg ? '  Rata-rata: ' : '  ';
                            return `${prefix}${val.toFixed(3)}${unit}`;
                        }
                    }
                },
                zoom: {
                    zoom: { wheel: { enabled: true, speed: 0.08 }, pinch: { enabled: true }, mode: 'x' },
                    pan:  { enabled: true, mode: 'x' },
                    limits: { x: { minRange: 2 } }
                }
            },

            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text:    xTitles[timeFilter] || 'Waktu',
                        font:    { size: 11, weight: 700 },
                        color:   '#666666'
                    },
                    grid: {
                        color:     'rgba(0,0,0,0.04)',
                        drawTicks: false
                    },
                    ticks: {
                        maxRotation:   45,
                        minRotation:   0,
                        font:          { size: 9 },
                        color:         '#999999',
                        maxTicksLimit: isBar ? 7 : (isAgg ? 12 : 15),
                        padding:       4
                    },
                    // Sedikit padding kiri-kanan agar garis tidak mentok tepi
                    offset: isBar
                },
                y: {
                    display: true,
                    title: {
                        display: true,
                        text:    info.unit ? `${info.label} (${info.unit})` : info.label,
                        font:    { size: 11, weight: 700 },
                        color:   '#666666'
                    },
                    grid: {
                        color:     'rgba(0,0,0,0.05)',
                        drawTicks: false
                    },
                    ticks: {
                        font:    { size: 9 },
                        color:   '#999999',
                        padding: 6,
                        // Format angka dengan presisi yang bagus
                        callback: function(val) {
                            if (val === null) return '';
                            return val >= 1000 ? (val/1000).toFixed(1)+'k' : val;
                        }
                    },
                    beginAtZero: selectedParameter !== 'powerFactor' && selectedParameter !== 'voltage' && selectedParameter !== 'frequency',
                    // Tambah sedikit padding atas agar puncak garis tidak terpotong
                    grace: '5%'
                }
            }
        }
    });

    updateFilterInfo(values);
}

function updateChart(data) {
    if (!realtimeChart) return;

    const now = new Date();
    const timeLabel = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    chartData.labels.push(timeLabel);
    chartData.timestamps.push(Date.now());
    chartData.voltage.push(data.Voltage || 0);
    chartData.current.push(data.Current || 0);
    chartData.power.push(data.Power || 0);
    chartData.frequency.push(data.Frequency || 0);
    chartData.apparent.push(data.Apparent || 0);
    chartData.reactive.push(data.Reactive || 0);
    chartData.energy.push(data.Energy || 0);
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

    const { labels, values } = getAggregatedChartData();
    realtimeChart.data.labels = labels;
    realtimeChart.data.datasets[0].data = values;

    // Update titik — sembunyikan titik kalau data terlalu banyak (mode all)
    if (timeFilter === 'all') {
        realtimeChart.data.datasets[0].pointRadius = chartData.labels.length > 200 ? 0 : 2;
    }

    realtimeChart.update('none'); // 'none' = tanpa animasi saat update live (lebih smooth)
    updateFilterInfo(values);
}

function changeParameter() {
    selectedParameter = document.getElementById('parameterSelect').value;
    if (realtimeChart) realtimeChart.destroy();
    initChart();
}

function clearChartData() {
    chartData = {
        labels: [], timestamps: [],
        voltage: [], current: [], power: [], frequency: [],
        apparent: [], reactive: [], energy: [], powerFactor: []
    };
    if (realtimeChart) {
        realtimeChart.data.labels = [];
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
    const realtimeRef = database.ref('alat1/RealTime');
    realtimeRef.on('value', (snapshot) => {
        if (snapshot.exists()) {
            realtimeData = snapshot.val();
            lastDataTimestamp = Date.now();
            isConnected = true;
            updateRealtimeUI(realtimeData);
            updateConnectionStatus(true);
            checkThresholds(realtimeData);
        } else {
            isConnected = false;
            updateConnectionStatus(false);
        }
    }, () => { isConnected = false; updateConnectionStatus(false); });
}

function updateRealtimeUI(data) {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = `Last update: ${now.toLocaleTimeString('id-ID')}`;
    document.getElementById('voltage').textContent     = data.Voltage?.toFixed(2)    || '---';
    document.getElementById('current').textContent     = data.Current?.toFixed(2)     || '---';
    document.getElementById('power').textContent       = data.Power?.toFixed(2)       || '---';
    document.getElementById('frequency').textContent   = data.Frequency?.toFixed(1)   || '---';
    document.getElementById('apparent').textContent    = data.Apparent?.toFixed(3)    || '---';
    document.getElementById('reactive').textContent    = data.Reactive?.toFixed(3)    || '---';
    document.getElementById('energy').textContent      = data.Energy?.toFixed(3)      || '---';
    document.getElementById('powerFactor').textContent = data.PowerFactor?.toFixed(3) || '---';
    updateChart(data);
}

// ====================================
// CONNECTION STATUS
// ====================================
function updateConnectionStatus(connected) {
    const statusDot  = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    if (connected) {
        statusDot.classList.add('online'); statusDot.classList.remove('offline');
        statusText.textContent = 'ONLINE';
    } else {
        statusDot.classList.add('offline'); statusDot.classList.remove('online');
        statusText.textContent = 'OFFLINE';
    }
}

function checkDataFreshness() {
    const age   = Date.now() - lastDataTimestamp;
    const fresh = lastDataTimestamp !== 0 && age <= 10000;
    isConnected = fresh;
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
    const historyRef = database.ref('alat1/History');
    historyRef.on('value', (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.val();
            historyData = Object.values(data);
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
        const [h, m, s] = time.split(':').map(Number);
        const [d, mo, y] = date.split('/').map(Number);
        return new Date(y, mo - 1, d, h, m, s);
    } catch (e) { return new Date(); }
}

function updateHistoryUI(data) {
    const tbody = document.getElementById('historyTableBody');
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
        await showModal(
            'Capture Diaktifkan',
            `Mode capture telah diaktifkan.\n\nEnergy counter otomatis direset ke nol.\nData akan disimpan setiap ${captureInterval / 1000} detik ke Firebase History.`,
            'success', ['ok']
        );
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
    intervalDisplay.textContent = multiplier === 1   ? `Current: ${value} seconds`
        : multiplier === 60  ? `Current: ${value} minutes (${intervalSeconds}s)`
        : `Current: ${value} hours (${intervalSeconds}s)`;
    if (captureActive) startCaptureInterval();
    await showModal('Interval Diperbarui', `Interval capture berhasil diubah menjadi ${value} ${intervalUnit.options[intervalUnit.selectedIndex].text.toLowerCase()}.`, 'success', ['ok']);
}

// ====================================
// SETTINGS FUNCTIONS
// ====================================
function loadSettings() {
    const savedThresholds = localStorage.getItem('thresholds');
    if (savedThresholds) thresholds = JSON.parse(savedThresholds);

    const tIds = ['voltageMax','voltageMin','currentMax','powerMax','powerFactorMin','energyLimit'];
    tIds.forEach(id => { if (document.getElementById(id)) document.getElementById(id).value = thresholds[id]; });

    const savedPreferences = localStorage.getItem('preferences');
    if (savedPreferences) preferences = JSON.parse(savedPreferences);

    const pIds = ['decimalPlaces','updateRate'];
    pIds.forEach(id => { if (document.getElementById(id)) document.getElementById(id).value = preferences[id]; });
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
    autoExportInterval = selectElement.value;
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
    initChart();
    const parameterSelect = document.getElementById('parameterSelect');
    if (parameterSelect) parameterSelect.addEventListener('change', changeParameter);
    initRealtimeListener();
    initHistoryListener();
    updateConnectionStatus(false);
    startConnectionMonitoring();
    loadSettings();
});