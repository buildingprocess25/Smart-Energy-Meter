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
let realtimeData          = null;
let isConnected           = false;
let lastDataTimestamp     = 0;
let connectionCheckInterval = null;
let _initialLoad          = true;

// ====================================
// DEVICE STATE
// ====================================
let selectedDeviceId   = '';
let selectedDeviceName = '';
let _deviceListCache   = [];
let _prevDeviceId      = '';

// ====================================
// SESSION STATE
// ====================================
let currentSessionId   = null;
let sessionsData       = {};
let _renamingSessionId = null;

// ====================================
// DATABASE FILTER STATE
// ====================================
let dbSearchQuery = '';

// ====================================
// CHART STATE
// ====================================
let realtimeChart     = null;
let selectedParameter = 'voltage';
let timeFilter        = 'all';
let _saveCounter      = 0;
let _userIsZoomed     = false;

const MAX_DATA_POINTS     = 300;
const SAVE_EVERY_N_POINTS = 60;

const CHART_KEYS = [
    'labels','timestamps','voltage','current','power',
    'frequency','apparent','reactive','energy','powerFactor'
];

let chartData = {
    labels:[], timestamps:[],
    voltage:[], current:[], power:[], frequency:[],
    apparent:[], reactive:[], energy:[], powerFactor:[]
};

// ====================================
// FIREBASE FIELD MAPPING
// ====================================
function normalizeFirebaseData(raw) {
    if (!raw) return null;
    return {
        Voltage:        parseFloat(raw.V1)     || 0,
        Current:        parseFloat(raw.A1)     || 0,
        Power:         (parseFloat(raw.P_SUM)  || 0) * 1000,
        Frequency:      parseFloat(raw.FREQ)   || 0,
        Apparent:       parseFloat(raw.S_SUM)  || 0,
        Reactive:       parseFloat(raw.Q_SUM)  || 0,
        Energy:         parseFloat(raw.WH)     || 0,
        PowerFactor:    parseFloat(raw.PF_SUM) || 0,
        Phase1:         parseFloat(raw.PHASE1) || 0,
        EnergyApparent: parseFloat(raw.SH)     || 0,
        EnergyReactive: parseFloat(raw.QH)     || 0,
        V1:  parseFloat(raw.V1)  || 0,
        A1:  parseFloat(raw.A1)  || 0,
        P1:  (parseFloat(raw.P1) || 0) * 1000,
        S1:  parseFloat(raw.S1)  || 0,
        Q1:  parseFloat(raw.Q1)  || 0,
        PF1: parseFloat(raw.PF1) || 0,
        DeviceTimestamp: raw.Timestamp || ''
    };
}

// ====================================
// CHART PERSISTENCE
// ====================================
const CHART_STORAGE_KEY = 'sem_chartdata_v1';

function loadChartDataFromStorage() {
    try {
        const raw = localStorage.getItem(CHART_STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!CHART_KEYS.every(k => Array.isArray(saved[k]))) return;
        CHART_KEYS.forEach(k => { chartData[k] = saved[k]; });
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const first  = chartData.timestamps.findIndex(t => t >= cutoff);
        if (first === -1) { CHART_KEYS.forEach(k => { chartData[k] = []; }); return; }
        if (first > 0)    CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(first); });
    } catch (e) { console.warn('[ChartStorage] Load failed:', e); }
}

function saveChartDataToStorage() {
    try {
        const payload = {};
        CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
        localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        CHART_KEYS.forEach(k => { chartData[k] = chartData[k].slice(-100); });
        try {
            const payload = {};
            CHART_KEYS.forEach(k => { payload[k] = chartData[k]; });
            localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(payload));
        } catch (_) {}
    }
}

function maybeSaveChartData() {
    if (++_saveCounter >= SAVE_EVERY_N_POINTS) { _saveCounter = 0; saveChartDataToStorage(); }
}

// ====================================
// DAILY AGGREGATION
// ====================================
const DAILY_AGG_REF  = 'alat1/DailyAgg';
const DAILY_AGG_KEYS = ['voltage','current','power','frequency','apparent','reactive','energy','powerFactor'];
let _dailyAgg = {}, _dailySums = {}, _dailyCounts = {}, _lastDayStr = '';

function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _cutoffStr() {
    const d = new Date(); d.setDate(d.getDate()-7);
    return d.toISOString().slice(0,10);
}

function loadDailyAggFromFirebase() {
    return new Promise(resolve => {
        database.ref(DAILY_AGG_REF).once('value', snap => {
            if (!snap.exists()) { resolve(); return; }
            const raw=snap.val()||{}, cutoff=_cutoffStr();
            Object.keys(raw).forEach(day => {
                if (day<cutoff) database.ref(`${DAILY_AGG_REF}/${day}`).remove();
                else _dailyAgg[day]=raw[day];
            });
            resolve();
        }, ()=>resolve());
    });
}

function _accumulateDailyPoint(data) {
    const today=_todayStr();
    if (_lastDayStr && _lastDayStr!==today) { _flushDailyAgg(_lastDayStr); _pruneOldDailyAgg(); }
    _lastDayStr=today;
    if (!_dailySums[today]) {
        _dailySums[today]={}; _dailyCounts[today]=0;
        DAILY_AGG_KEYS.forEach(k=>{ _dailySums[today][k]=0; });
    }
    const fm={
        voltage:data.Voltage, current:data.Current, power:data.Power,
        frequency:data.Frequency, apparent:data.Apparent, reactive:data.Reactive,
        energy:data.Energy, powerFactor:data.PowerFactor
    };
    DAILY_AGG_KEYS.forEach(k=>{ _dailySums[today][k]+=(fm[k]||0); });
    _dailyCounts[today]++;
    if (_dailyCounts[today]%300===0) _flushDailyAgg(today);
}

function _flushDailyAgg(dayStr) {
    const count=_dailyCounts[dayStr];
    if (!count) return;
    const avg={};
    DAILY_AGG_KEYS.forEach(k=>{ avg[k]=parseFloat((_dailySums[dayStr][k]/count).toFixed(4)); });
    _dailyAgg[dayStr]=avg;
    database.ref(`${DAILY_AGG_REF}/${dayStr}`).set(avg).catch(e=>console.warn('[DailyAgg]',e));
}

function _pruneOldDailyAgg() {
    const cutoff=_cutoffStr();
    Object.keys(_dailyAgg).forEach(day=>{
        if (day<cutoff) {
            database.ref(`${DAILY_AGG_REF}/${day}`).remove();
            delete _dailyAgg[day]; delete _dailySums[day]; delete _dailyCounts[day];
        }
    });
}

function getDailyChartData(param) {
    const labels=[], values=[];
    for (let i=6;i>=0;i--) {
        const d=new Date(); d.setDate(d.getDate()-i);
        const dayStr=d.toISOString().slice(0,10);
        const label=`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
        labels.push(label);
        if (_dailyAgg[dayStr]?.[param]!==undefined)
            values.push(_dailyAgg[dayStr][param]);
        else if (_dailySums[dayStr]&&_dailyCounts[dayStr]>0)
            values.push(parseFloat((_dailySums[dayStr][param]/_dailyCounts[dayStr]).toFixed(4)));
        else
            values.push(null);
    }
    return {labels,values};
}

// ====================================
// MODAL
// ====================================
function showModal(title, message, type='info', buttons=['ok']) {
    return new Promise(resolve => {
        const modal     =document.getElementById('customModal');
        const modalTitle=document.getElementById('modalTitle');
        const modalMsg  =document.getElementById('modalMessage');
        const modalIcon =document.getElementById('modalIcon');
        const modalBtns =document.getElementById('modalButtons');
        modalTitle.textContent=title;
        modalMsg.textContent=message;
        modalIcon.className='modal-icon '+type;
        const icons={
            success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            warning:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            error:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            info:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
        };
        modalIcon.innerHTML=icons[type]||icons.info;
        modalBtns.innerHTML='';
        if (buttons.includes('confirm')) {
            const cancelBtn=document.createElement('button');
            cancelBtn.className='modal-btn modal-btn-secondary';
            cancelBtn.textContent='BATAL';
            cancelBtn.onclick=()=>{ closeModal(); resolve(false); };
            modalBtns.appendChild(cancelBtn);
            const confirmBtn=document.createElement('button');
            confirmBtn.className='modal-btn modal-btn-primary';
            confirmBtn.textContent='YA, LANJUTKAN';
            confirmBtn.onclick=()=>{ closeModal(); resolve(true); };
            modalBtns.appendChild(confirmBtn);
        } else {
            const okBtn=document.createElement('button');
            okBtn.className='modal-btn modal-btn-primary';
            okBtn.textContent='OK';
            okBtn.onclick=()=>{ closeModal(); resolve(true); };
            modalBtns.appendChild(okBtn);
        }
        modal.classList.add('active');
        document.body.style.overflow='hidden';
    });
}

function closeModal() {
    document.getElementById('customModal').classList.remove('active');
    document.body.style.overflow='';
}

document.addEventListener('click', e=>{ if (e.target===document.getElementById('customModal')) closeModal(); });
document.addEventListener('keydown', e=>{ if (e.key==='Escape') closeModal(); });

// ====================================
// DISPLAY CARDS
// ====================================
function updateDisplayCards(data) {
    const fmt=(val,dec)=>(val!==undefined&&val!==null&&!isNaN(val))?parseFloat(val).toFixed(dec):'---';
    document.getElementById('voltage').textContent    =fmt(data.Voltage,1);
    document.getElementById('current').textContent    =fmt(data.Current,2);
    document.getElementById('power').textContent      =fmt(data.Power,1);
    document.getElementById('frequency').textContent  =fmt(data.Frequency,1);
    document.getElementById('apparent').textContent   =fmt(data.Apparent,3);
    document.getElementById('reactive').textContent   =fmt(data.Reactive,3);
    document.getElementById('energy').textContent     =fmt(data.Energy,3);
    document.getElementById('powerFactor').textContent=fmt(data.PowerFactor,3);
    const el=document.getElementById('lastUpdate');
    if (el) el.textContent='Last update: '+new Date().toLocaleTimeString('id-ID');
}

function updateDisplayCardsBlank() {
    ['voltage','current','power','frequency','apparent','reactive','energy','powerFactor']
        .forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent='---'; });
    const el=document.getElementById('lastUpdate');
    if (el) el.textContent='--- Device offline ---';
}

// ====================================
// TIME FILTER (chart)
// ====================================
function setTimeFilter(filter) {
    timeFilter=filter; _userIsZoomed=false;
    document.querySelectorAll('.time-filter-btn').forEach(btn=>{
        btn.classList.toggle('active',btn.dataset.filter===filter);
    });
    refreshChartWithFilter();
}

// ====================================
// AGGREGATION
// ====================================
function getFilterConfig() {
    const configs={
        minute:{buckets:60,bucketMs:60_000,    windowMs:60*60_000,    fmt:'HH:MM'},
        hour:  {buckets:24,bucketMs:60*60_000, windowMs:24*60*60_000, fmt:'HH:00'},
        '6h':  {buckets:12,bucketMs:30*60_000, windowMs:6*60*60_000,  fmt:'HH:MM'}
    };
    return configs[timeFilter]||null;
}

function getAggregatedChartData() {
    const raw=chartData[selectedParameter], ts=chartData.timestamps;
    if (timeFilter==='all') return {labels:chartData.labels,values:raw};
    if (timeFilter==='day') return getDailyChartData(selectedParameter);
    const cfg=getFilterConfig();
    if (!cfg) return {labels:chartData.labels,values:raw};
    const now=Date.now(), d=new Date(now);
    let alignedNow;
    if (timeFilter==='minute')
        alignedNow=new Date(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes()+1,0,0).getTime();
    else
        alignedNow=new Date(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours()+1,0,0,0).getTime();
    const windowStart=alignedNow-cfg.windowMs;
    const sums=new Array(cfg.buckets).fill(0), counts=new Array(cfg.buckets).fill(0);
    for (let i=0;i<ts.length;i++) {
        const t=ts[i];
        if (t<windowStart||t>now) continue;
        const idx=Math.floor((t-windowStart)/cfg.bucketMs);
        if (idx<0||idx>=cfg.buckets) continue;
        sums[idx]+=raw[i]; counts[idx]++;
    }
    const labels=[], values=[];
    for (let i=0;i<cfg.buckets;i++) {
        labels.push(formatBucketLabel(new Date(windowStart+i*cfg.bucketMs),cfg.fmt));
        values.push(counts[i]>0?parseFloat((sums[i]/counts[i]).toFixed(4)):null);
    }
    return {labels,values};
}

function formatBucketLabel(d,fmt) {
    const pad=v=>String(v).padStart(2,'0');
    if (fmt==='DD/MM') return `${pad(d.getDate())}/${pad(d.getMonth()+1)}`;
    if (fmt==='HH:00') return `${pad(d.getHours())}:00`;
    if (fmt==='HH:MM') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toLocaleTimeString('id-ID');
}

function refreshChartWithFilter() {
    const canvas=document.getElementById('realtimeChart');
    if (!canvas) return;
    const wrap=canvas.parentElement;
    wrap.style.transition='opacity 0.18s ease'; wrap.style.opacity='0';
    setTimeout(()=>{
        if (realtimeChart) { realtimeChart.destroy(); realtimeChart=null; }
        initChart(); wrap.style.opacity='1';
    },180);
}

// ====================================
// CHART
// ====================================
function getYBounds(values,param) {
    const padMap={
        voltage:10,current:1,power:50,frequency:1,
        apparent:0.05,reactive:0.05,energy:0.1,powerFactor:0.05
    };
    const pad=padMap[param]??5;
    const clean=(values||[]).filter(v=>v!==null&&v!==undefined&&isFinite(v));
    if (!clean.length) return {yMin:undefined,yMax:undefined};
    const dataMin=Math.min(...clean), dataMax=Math.max(...clean);
    const actualPad=(dataMax-dataMin)<pad*2?pad:(dataMax-dataMin)*0.15;
    return {yMin:parseFloat((dataMin-actualPad).toFixed(4)),yMax:parseFloat((dataMax+actualPad).toFixed(4))};
}

function initChart() {
    const ctx=document.getElementById('realtimeChart');
    if (!ctx) return;
    const paramInfo={
        voltage:    {label:'Voltage',       unit:'V',   color:'#FFA500',borderColor:'#FF8C00'},
        current:    {label:'Current',       unit:'A',   color:'#0066CC',borderColor:'#0052A3'},
        power:      {label:'Power',         unit:'W',   color:'#00A651',borderColor:'#008040'},
        frequency:  {label:'Frequency',     unit:'Hz',  color:'#6B46C1',borderColor:'#5A3AA0'},
        apparent:   {label:'Apparent Power',unit:'kVA', color:'#FFA500',borderColor:'#FF8C00'},
        reactive:   {label:'Reactive Power',unit:'kVAR',color:'#0066CC',borderColor:'#0052A3'},
        energy:     {label:'Energy',        unit:'kWh', color:'#00A651',borderColor:'#008040'},
        powerFactor:{label:'Power Factor',  unit:'',    color:'#6B46C1',borderColor:'#5A3AA0'}
    };
    const info    =paramInfo[selectedParameter];
    const isBar   =(timeFilter==='day'||timeFilter==='6h'||timeFilter==='hour');
    const isAgg   =(timeFilter!=='all');
    const isMinute=(timeFilter==='minute');
    const {labels,values}=getAggregatedChartData();
    const gradientFill=(()=>{
        const c2d=ctx.getContext('2d');
        const g=c2d.createLinearGradient(0,0,0,ctx.clientHeight||300);
        g.addColorStop(0,info.color+(isMinute?'88':'55'));
        g.addColorStop(1,info.color+(isMinute?'10':'05'));
        return g;
    })();
    const xTitles={all:'Waktu',minute:'60 Menit Terakhir',hour:'24 Jam Terakhir','6h':'6 Jam Terakhir',day:'7 Hari Terakhir'};
    const {yMin,yMax}=getYBounds(values,selectedParameter);
    realtimeChart=new Chart(ctx,{
        type:isBar?'bar':'line',
        data:{
            labels,
            datasets:[{
                label:info.unit?`${info.label} (${info.unit})`:info.label,
                data:values, borderColor:info.borderColor,
                backgroundColor:isBar?info.color+'BB':gradientFill,
                borderWidth:isBar?1.5:(isMinute?2.5:2),
                tension:isMinute?0.5:0.4, cubicInterpolationMode:'monotone',
                spanGaps:isMinute, fill:!isBar,
                pointRadius:isBar?0:(isMinute?0:(isAgg?4:(chartData.labels.length>150?0:2))),
                pointHoverRadius:isBar?0:(isMinute?5:6),
                pointBackgroundColor:info.borderColor, pointBorderColor:'#fff',
                pointBorderWidth:1.5, borderRadius:isBar?5:0, borderSkipped:false
            }]
        },
        options:{
            responsive:true, maintainAspectRatio:false,
            interaction:{intersect:false,mode:'index'},
            animation:{duration:300,easing:'easeInOutQuart'},
            transitions:{active:{animation:{duration:150}}},
            plugins:{
                legend:{display:true,position:'top',labels:{
                    font:{family:'-apple-system, BlinkMacSystemFont, "Segoe UI", Arial',size:11,weight:700},
                    color:'#666666',usePointStyle:true,pointStyle:isBar?'rect':'circle',padding:12
                }},
                tooltip:{
                    backgroundColor:'rgba(20,20,20,0.9)',titleFont:{size:12,weight:700},
                    bodyFont:{size:11},padding:12,cornerRadius:10,displayColors:false,caretSize:6,
                    callbacks:{
                        title:items=>' '+(items[0]?.label||''),
                        label:ctx=>{
                            const val=ctx.parsed.y;
                            if (val===null||val===undefined) return '  Tidak ada data';
                            return `${isAgg?'  Rata-rata: ':'  '}${val.toFixed(3)}${info.unit?' '+info.unit:''}`;
                        }
                    }
                },
                zoom:{
                    zoom:{wheel:{enabled:true,speed:0.08},pinch:{enabled:true},mode:'x',onZoom:()=>{_userIsZoomed=true;}},
                    pan: {enabled:true,mode:'x',onPan:()=>{_userIsZoomed=true;}},
                    limits:{x:{minRange:2}}
                }
            },
            scales:{
                x:{
                    display:true,
                    title:{display:true,text:xTitles[timeFilter]||'Waktu',font:{size:11,weight:700},color:'#666666'},
                    grid:{color:'rgba(0,0,0,0.04)',drawTicks:false},
                    ticks:{
                        maxRotation:isMinute?0:45,minRotation:0,font:{size:9},color:'#999999',
                        maxTicksLimit:isBar?7:(isMinute?10:(isAgg?12:15)),padding:4,autoSkip:true,autoSkipPadding:16
                    },
                    offset:isBar
                },
                y:{
                    display:true,
                    title:{display:true,text:info.unit?`${info.label} (${info.unit})`:info.label,font:{size:11,weight:700},color:'#666666'},
                    grid:{color:'rgba(0,0,0,0.05)',drawTicks:false},
                    ticks:{
                        font:{size:9},color:'#999999',padding:6,
                        callback:val=>val===null?'':val>=1000?(val/1000).toFixed(1)+'k':val
                    },
                    min:yMin, max:yMax
                }
            }
        }
    });
}

function updateChart(data) {
    if (!realtimeChart) return;
    const timeLabel=new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    chartData.labels.push(timeLabel);
    chartData.timestamps.push(Date.now());
    chartData.voltage.push(data.Voltage      ||0);
    chartData.current.push(data.Current      ||0);
    chartData.power.push(data.Power          ||0);
    chartData.frequency.push(data.Frequency  ||0);
    chartData.apparent.push(data.Apparent    ||0);
    chartData.reactive.push(data.Reactive    ||0);
    chartData.energy.push(data.Energy        ||0);
    chartData.powerFactor.push(data.PowerFactor||0);
    if (chartData.labels.length>MAX_DATA_POINTS) CHART_KEYS.forEach(k=>{chartData[k].shift();});
    maybeSaveChartData();
    _accumulateDailyPoint(data);
    const {labels,values}=getAggregatedChartData();
    realtimeChart.data.labels=labels;
    realtimeChart.data.datasets[0].data=values;
    if (timeFilter==='all') {
        realtimeChart.data.datasets[0].pointRadius=chartData.labels.length>150?0:2;
        if (!_userIsZoomed) _scrollToLatest();
    }
    realtimeChart.update('none');
}

function _scrollToLatest() {
    const total=realtimeChart.data.labels.length, visible=Math.min(60,total);
    try { realtimeChart.zoomScale('x',{min:total-visible,max:total-1},'none'); } catch(_){}
}

function changeParameter() { _switchParameter(document.getElementById('parameterSelect').value); }

function _switchParameter(param) {
    selectedParameter=param; _userIsZoomed=false;
    const sel=document.getElementById('parameterSelect');
    if (sel) sel.value=param;
    document.querySelectorAll('.metric-card-compact').forEach(card=>{
        card.classList.toggle('card-active',card.dataset.param===param);
    });
    const canvas=document.getElementById('realtimeChart');
    const wrap  =canvas?.parentElement;
    if (wrap) {
        wrap.style.transition='opacity 0.18s ease'; wrap.style.opacity='0';
        setTimeout(()=>{if(realtimeChart){realtimeChart.destroy();realtimeChart=null;}initChart();wrap.style.opacity='1';},180);
    } else {
        if (realtimeChart){realtimeChart.destroy();realtimeChart=null;} initChart();
    }
}

// ====================================
// TAB SWITCHING
// ====================================
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn=>btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    document.getElementById(tabName+'Tab').classList.add('active');
    document.getElementById(tabName+'Content').classList.add('active');
}

// ====================================
// DEVICE MANAGEMENT
// ====================================
async function loadDevices() {
    try {
        const res     = await fetch('/api/devices');
        const devices = await res.json();
        _deviceListCache = devices;

        const sel = document.getElementById('deviceSelect');
        if (!sel) return;

        sel.innerHTML = devices.length
            ? devices.map(d =>
                `<option value="${d.id}" ${d.id===selectedDeviceId?'selected':''}>
                    ${d.name||d.id} ${d.online?'🟢':'🔴'}
                </option>`).join('')
            : '<option value="">Tidak ada device</option>';

        if (!selectedDeviceId && devices.length) {
            selectedDeviceId   = devices[0].id;
            selectedDeviceName = devices[0].name || devices[0].id;
            sel.value = selectedDeviceId;
            _attachRealtimeListener(selectedDeviceId);
            _attachHistoryListener(selectedDeviceId);
        }

        renderDeviceList(devices);
    } catch (e) {
        console.warn('[Devices] Load failed:', e);
    }
}

function renderDeviceList(devices) {
    const container = document.getElementById('deviceList');
    if (!container) return;
    if (!devices.length) {
        container.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px;padding:8px 0">Belum ada device terdaftar</p>';
        return;
    }
    container.innerHTML = devices.map(d => `
        <div class="device-item">
            <div class="device-item-info">
                <span class="device-online-dot ${d.online?'online':'offline'}"></span>
                <div>
                    <p class="device-item-name">${d.name||d.id}</p>
                    <p class="device-item-id">${d.id} · Last seen: ${d.lastSeen||'---'}</p>
                </div>
            </div>
            <div class="device-item-actions">
                <input type="text" class="device-rename-input" id="rename_${d.id}"
                    value="${d.name||d.id}" maxlength="40" autocomplete="off"
                    onkeydown="if(event.key==='Enter') saveDeviceName('${d.id}')">
                <button class="control-btn btn-set device-save-btn"
                    onclick="saveDeviceName('${d.id}')">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Simpan
                </button>
            </div>
        </div>`).join('');
}

async function saveDeviceName(deviceId) {
    const input   = document.getElementById(`rename_${deviceId}`);
    const newName = input?.value.trim();
    if (!newName) { await showModal('Error','Nama tidak boleh kosong','warning',['ok']); return; }
    try {
        const res  = await fetch(`/api/devices/${deviceId}/rename`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({name: newName})
        });
        const json = await res.json();
        if (json.ok) {
            const opt = document.querySelector(`#deviceSelect option[value="${deviceId}"]`);
            if (opt) {
                const isOnline = opt.textContent.includes('🟢');
                opt.textContent = `${newName} ${isOnline?'🟢':'🔴'}`;
            }
            if (deviceId === selectedDeviceId) selectedDeviceName = newName;
            // Update cache
            const dev = _deviceListCache.find(d => d.id === deviceId);
            if (dev) dev.name = newName;
            await showModal('Berhasil',`Nama device diubah menjadi:\n"${newName}"`, 'success',['ok']);
        } else {
            await showModal('Error', json.error||'Gagal menyimpan','error',['ok']);
        }
    } catch (e) {
        await showModal('Error','Network error: '+e.message,'error',['ok']);
    }
}

function onDeviceChange(deviceId) {
    if (!deviceId || deviceId === selectedDeviceId) return;

    // Detach old listeners
    if (_prevDeviceId) {
        database.ref(`devices/${_prevDeviceId}/RealTime`).off();
        database.ref(`devices/${_prevDeviceId}/History`).off();
    }

    selectedDeviceId = deviceId;
    const dev = _deviceListCache.find(d => d.id === deviceId);
    selectedDeviceName = dev?.name || deviceId;

    // Reset chart
    CHART_KEYS.forEach(k => { chartData[k] = []; });
    if (realtimeChart) { realtimeChart.destroy(); realtimeChart = null; }
    initChart();
    updateConnectionStatus(false);
    updateDisplayCardsBlank();
    lastDataTimestamp = 0;

    // Reset history
    historyData = []; recordsBySession = {}; sessionsData = {};
    buildSessionUI();

    // Attach new listeners
    _attachRealtimeListener(deviceId);
    _attachHistoryListener(deviceId);
}

// ====================================
// REALTIME LISTENER
// ====================================
function _attachRealtimeListener(deviceId) {
    _prevDeviceId = deviceId;
    let _firstSnap = true;
    database.ref(`devices/${deviceId}/RealTime`).on('value', snapshot => {
        if (!snapshot.exists()) { updateConnectionStatus(false); return; }
        const raw  = snapshot.val();
        const data = normalizeFirebaseData(raw);
        if (!data) { updateConnectionStatus(false); return; }
        if (_firstSnap) { _firstSnap = false; return; }
        const isZero = data.Voltage===0 && data.Current===0 && data.Power===0;
        if (isZero) { updateConnectionStatus(false); return; }
        lastDataTimestamp = Date.now();
        realtimeData = data;
        isConnected  = true;
        updateDisplayCards(data);
        updateChart(data);
        updateConnectionStatus(true);
    }, () => updateConnectionStatus(false));
}

// ====================================
// CONNECTION STATUS
// ====================================
function updateConnectionStatus(connected) {
    const statusDot =document.getElementById('statusDot');
    const statusText=document.getElementById('statusText');
    if (connected) {
        statusDot.classList.add('online'); statusDot.classList.remove('offline');
        statusText.textContent='ONLINE';
        _initialLoad=false;
    } else {
        statusDot.classList.add('offline'); statusDot.classList.remove('online');
        statusText.textContent='OFFLINE';
        updateDisplayCardsBlank();
    }
}

function checkDataFreshness() {
    const age  = Date.now()-lastDataTimestamp;
    const fresh= lastDataTimestamp!==0 && age<=3000;
    if (isConnected && !fresh) {
        isConnected=false; realtimeData=null;
        updateConnectionStatus(false);
    }
}

function startConnectionMonitoring() {
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(checkDataFreshness, 2000);
}

// ====================================
// DATABASE SEARCH
// ====================================
function onDbSearchInput(value) {
    dbSearchQuery = value.trim().toLowerCase();
    const clearBtn = document.getElementById('dbSearchClear');
    if (clearBtn) clearBtn.classList.toggle('visible', dbSearchQuery.length > 0);
    buildSessionUI();
}

function clearDbSearch() {
    const input = document.getElementById('dbSearchInput');
    if (input) input.value = '';
    dbSearchQuery = '';
    const clearBtn = document.getElementById('dbSearchClear');
    if (clearBtn) clearBtn.classList.remove('visible');
    buildSessionUI();
    input?.focus();
}

// ====================================
// HISTORY LISTENER
// ====================================
let historyData = [];
let recordsBySession = {};

function _attachHistoryListener(deviceId) {
    database.ref(`devices/${deviceId}/History`).on('value', snap => {
        historyData=[]; recordsBySession={}; sessionsData={};
        if (snap.exists()) {
            snap.forEach(sessionSnap => {
                const sid = sessionSnap.key;
                recordsBySession[sid] = [];
                sessionSnap.forEach(recordSnap => {
                    if (recordSnap.key==='_meta') { sessionsData[sid]=recordSnap.val(); return; }
                    const record = {...recordSnap.val(), sessionId: sid};
                    historyData.push(record); recordsBySession[sid].push(record);
                });
            });
        }
        buildSessionUI();
    });
}

function buildSessionUI() {
    const tbody      = document.getElementById('historyTableBody');
    const hc         = document.getElementById('historyCount');
    const allSessions= Object.values(sessionsData).sort((a,b)=>(b.startTimestamp||0)-(a.startTimestamp||0));

    const filtered = allSessions.filter(session => {
        if (dbSearchQuery) {
            const name = (session.name||session.id||'').toLowerCase();
            if (!name.includes(dbSearchQuery)) return false;
        }
        return true;
    });

    if (dbSearchQuery) {
        hc.textContent = `${filtered.length} dari ${allSessions.length} sesi · ${historyData.length} total record`;
    } else {
        hc.textContent = `${allSessions.length} sesi · ${historyData.length} total record`;
    }

    if (!filtered.length) {
        const msg = dbSearchQuery ? 'Tidak ada sesi yang cocok.' : 'Belum ada data rekaman';
        tbody.innerHTML=`<tr><td colspan="5" class="loading-cell">${msg}</td></tr>`;
        return;
    }

    const openSessions = new Set();
    document.querySelectorAll('.session-detail-row').forEach(row => {
        if (row.style.display !== 'none') openSessions.add(row.id.replace('detail_',''));
    });

    tbody.innerHTML = filtered.map(session => {
        const records  = (recordsBySession[session.id]||[]).sort((a,b)=>parseTimestamp(b.timestamp)-parseTimestamp(a.timestamp));
        const count    = records.length;
        const isActive = session.id===currentSessionId && captureActive;

        const innerRows = count ? records.map(entry => {
            const isOffline  = !!entry.offline;
            const rowStyle   = isOffline ? ' style="opacity:0.5;font-style:italic;"' : '';
            const offlineTag = isOffline
                ? ' <span style="color:#9CA3AF;font-size:9px;font-weight:700">[offline]</span>' : '';
            const pfColor    = isOffline ? '#9CA3AF' : (entry.PowerFactor>=0.95?'#00A651':'#ED1C24');
            return `<tr class="inner-record-row"${rowStyle}>
                <td>${entry.timestamp}${offlineTag}</td>
                <td>${entry.Voltage?.toFixed(2)    ??'---'}</td>
                <td>${entry.Current?.toFixed(2)    ??'---'}</td>
                <td>${entry.Power?.toFixed(2)      ??'---'}</td>
                <td>${entry.Energy?.toFixed(3)     ??'---'}</td>
                <td style="color:${pfColor}">${entry.PowerFactor?.toFixed(3)??'---'}</td>
            </tr>`;
        }).join('') : `<tr><td colspan="6" class="loading-cell" style="padding:20px !important">Belum ada record</td></tr>`;

        const innerTable = `<div class="session-inner-wrap"><table class="data-table inner-table">
            <thead><tr><th>Timestamp</th><th>Voltage (V)</th><th>Current (A)</th><th>Power (W)</th><th>Energy (kWh)</th><th>PF</th></tr></thead>
            <tbody>${innerRows}</tbody></table></div>`;

        const endTimeCell = isActive
            ? `<td><span style="color:#00A651;font-weight:700">Sedang berlangsung...</span></td>`
            : `<td>${session.endTime||'---'}</td>`;

        const rawName = session.name || 'Tanpa nama';
        const displayName = dbSearchQuery
            ? rawName.replace(new RegExp(`(${dbSearchQuery.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'),
                '<mark class="search-highlight">$1</mark>')
            : rawName;

        return `
        <tr class="session-row${isActive?' session-active':''}" onclick="toggleSessionDetail('${session.id}')">
            <td class="session-toggle-cell">
                <span class="session-chevron" id="chevron_${session.id}">&#9658;</span>
                <span class="session-id-badge" title="${session.id}">${session.id.replace('session_','')}</span>
            </td>
            <td class="session-name-cell">
                <span class="session-name">${displayName}</span>
                ${isActive?'<span class="session-live-badge">&#9679; LIVE</span>':''}
            </td>
            <td>${session.startTime||'---'}</td>
            ${endTimeCell}
            <td style="text-align:right; padding-right:16px">
                <div class="session-actions">
                    <span class="record-count-badge">${count} record</span>
                    ${!isActive?`
                    <button class="session-export-btn" onclick="exportSession('${session.id}','${(session.name||'').replace(/'/g,"\\'")}',event)" title="Export">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </button>
                    <button class="session-rename-btn" onclick="openRenameModal('${session.id}','${(session.name||'').replace(/'/g,"\\'")}',event)" title="Rename">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="session-delete-btn" onclick="deleteSession('${session.id}','${(session.name||'').replace(/'/g,"\\'")}',event)" title="Hapus">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6m4-6v6"></path></svg>
                    </button>`:''}
                </div>
            </td>
        </tr>
        <tr class="session-detail-row" id="detail_${session.id}" style="display:none">
            <td colspan="5" style="padding:0">${innerTable}</td>
        </tr>`;
    }).join('');

    openSessions.forEach(sessionId => {
        const detail  = document.getElementById(`detail_${sessionId}`);
        const chevron = document.getElementById(`chevron_${sessionId}`);
        if (detail)  detail.style.display  = 'table-row';
        if (chevron) chevron.textContent   = '▼';
    });
}

function toggleSessionDetail(sessionId) {
    const detail  = document.getElementById(`detail_${sessionId}`);
    const chevron = document.getElementById(`chevron_${sessionId}`);
    if (!detail) return;
    const isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : 'table-row';
    if (chevron) chevron.textContent = isOpen ? '\u25B6' : '\u25BC';
}

function parseTimestamp(timestamp) {
    try {
        const [time,date] = timestamp.split(' ');
        const [h,m,s]     = time.split(':').map(Number);
        const [d,mo,y]    = date.split('/').map(Number);
        return new Date(y,mo-1,d,h,m,s);
    } catch(e) { return new Date(); }
}

// ====================================
// EXCEL HELPERS
// ====================================
function _buildExcelRow(entry, sessionLabel) {
    const row = {};
    if (sessionLabel!==undefined) row['Sesi'] = sessionLabel;
    row['Timestamp']               = entry.timestamp      ?? '';
    row['Status']                  = entry.offline ? 'OFFLINE' : 'online';
    row['Voltage (V)']             = entry.Voltage        != null ? parseFloat(entry.Voltage.toFixed(2))        : '';
    row['Current (A)']             = entry.Current        != null ? parseFloat(entry.Current.toFixed(2))        : '';
    row['Power (W)']               = entry.Power          != null ? parseFloat(entry.Power.toFixed(2))          : '';
    row['Apparent Power (kVA)']    = entry.Apparent       != null ? parseFloat(entry.Apparent.toFixed(4))       : '';
    row['Reactive Power (kVAR)']   = entry.Reactive       != null ? parseFloat(entry.Reactive.toFixed(4))       : '';
    row['Power Factor']            = entry.PowerFactor    != null ? parseFloat(entry.PowerFactor.toFixed(4))    : '';
    row['Phase Angle (°)']         = entry.Phase1         != null ? parseFloat(entry.Phase1.toFixed(3))         : '';
    row['Frequency (Hz)']          = entry.Frequency      != null ? parseFloat(entry.Frequency.toFixed(1))      : '';
    row['Active Energy (kWh)']     = entry.Energy         != null ? parseFloat(entry.Energy.toFixed(4))         : '';
    row['Apparent Energy (kVAh)']  = entry.EnergyApparent != null ? parseFloat(entry.EnergyApparent.toFixed(4)) : '';
    row['Reactive Energy (kVARh)'] = entry.EnergyReactive != null ? parseFloat(entry.EnergyReactive.toFixed(4)) : '';
    return row;
}

const _COL_WIDTHS = [
    {wch:20},{wch:10},
    {wch:13},{wch:13},{wch:13},
    {wch:20},{wch:20},{wch:14},
    {wch:16},{wch:14},
    {wch:20},{wch:22},{wch:22}
];

// ====================================
// EXPORT SESSION
// ====================================
async function exportSession(sessionId, sessionName, event) {
    event.stopPropagation();
    const records = recordsBySession[sessionId] || [];
    if (!records.length) { await showModal('Tidak Ada Data',`Sesi "${sessionName}" belum memiliki record.`,'warning',['ok']); return; }
    const confirmed = await showModal('Export Sesi',
        `Ekspor ${records.length} record dari sesi:\n"${sessionName}"\n\nData Firebase TIDAK dihapus. Lanjutkan?`,'info',['confirm']);
    if (!confirmed) return;
    try {
        const session    = sessionsData[sessionId];
        const onlineRows = records.filter(e=>!e.offline);
        const excelData  = records.sort((a,b)=>parseTimestamp(a.timestamp)-parseTimestamp(b.timestamp)).map(e=>_buildExcelRow(e));
        const ws         = XLSX.utils.json_to_sheet(excelData);
        ws['!cols']      = _COL_WIDTHS;
        const avg = f => onlineRows.length ? onlineRows.reduce((s,e)=>s+(e[f]||0),0)/onlineRows.length : 0;
        const sum = f => onlineRows.reduce((s,e)=>s+(e[f]||0),0);
        const wsMeta = XLSX.utils.aoa_to_sheet([
            ['Smart Energy Monitor - Session Export'],[''],
            ['Nama Sesi',sessionName],
            ['Export Date',new Date().toLocaleString('id-ID')],
            ['Waktu Mulai',session?.startTime||'---'],
            ['Waktu Selesai',session?.endTime||'Berlangsung'],
            ['Total Records',records.length],
            ['Records Online',onlineRows.length],
            ['Records Offline',records.length-onlineRows.length],
            ['Device ID', selectedDeviceId],[''],
            ['Summary Statistics (online saja)'],[''],
            ['Parameter','Rata-rata','Satuan'],
            ['Voltage',avg('Voltage').toFixed(2),'V'],
            ['Current',avg('Current').toFixed(2),'A'],
            ['Power',avg('Power').toFixed(2),'W'],
            ['Apparent Power',avg('Apparent').toFixed(4),'kVA'],
            ['Reactive Power',avg('Reactive').toFixed(4),'kVAR'],
            ['Power Factor',avg('PowerFactor').toFixed(4),''],
            ['Phase Angle',avg('Phase1').toFixed(3),'°'],
            ['Frequency',avg('Frequency').toFixed(1),'Hz'],
            ['Total Active Energy',sum('Energy').toFixed(4),'kWh'],
            ['Total Apparent Energy',sum('EnergyApparent').toFixed(4),'kVAh'],
            ['Total Reactive Energy',sum('EnergyReactive').toFixed(4),'kVARh'],
        ]);
        wsMeta['!cols'] = [{wch:28},{wch:18},{wch:10}];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        XLSX.utils.book_append_sheet(wb, wsMeta, 'Summary');
        XLSX.writeFile(wb, `${sessionName.replace(/[\\/:*?"<>|]/g,'_')}.xlsx`);
        await showModal('Export Berhasil!',`${records.length} record dari "${sessionName}" berhasil diekspor.`,'success',['ok']);
    } catch(error) { await showModal('Export Gagal','Error: '+error.message,'error',['ok']); }
}

// ====================================
// CLEAR ALL RECORDS
// ====================================
async function clearRecords() {
    if (!historyData.length && !Object.keys(sessionsData).length) {
        await showModal('Tidak Ada Data','Tidak ada history yang perlu dihapus.','info',['ok']); return;
    }
    const confirmed = await showModal('Konfirmasi Hapus Record',
        `Hapus SEMUA sesi & record device "${selectedDeviceName}"?\n\nData TIDAK DAPAT dikembalikan.`,'warning',['confirm']);
    if (!confirmed) return;
    try {
        await database.ref(`devices/${selectedDeviceId}/History`).remove();
        historyData=[]; recordsBySession={}; sessionsData={};
        buildSessionUI();
        await showModal('Berhasil Dihapus','Semua data rekaman telah dihapus.','success',['ok']);
    } catch(error) { await showModal('Error','Gagal menghapus! Error: '+error.message,'error',['ok']); }
}

// ====================================
// CAPTURE UI STATE
// ====================================
let captureActive   = false;
let captureInterval = 3000;
let _captureStatusPollId = null;

async function syncCaptureStatus() {
    try {
        const res  = await fetch('/api/capture/status');
        const json = await res.json();
        _applyCaptureStatus(json);
    } catch (e) { console.warn('[Capture] Status poll failed:', e); }
}

function _applyCaptureStatus(status) {
    captureActive    = status.active;
    captureInterval  = (status.interval || 3) * 1000;
    currentSessionId = status.session_id || null;
    _updateCaptureButtonUI(status.active);
    const id = document.getElementById('intervalDisplay');
    if (id && status.interval) id.textContent = `Current: ${status.interval} seconds (server)`;
    buildSessionUI();
}

function _startStatusPolling() {
    if (_captureStatusPollId) return;
    _captureStatusPollId = setInterval(syncCaptureStatus, 4000);
}

// ====================================
// CAPTURE BUTTON
// ====================================
function _captureStartHTML() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg> Start Capture`;
}
function _captureStopHTML() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Stop Capture`;
}

function _updateCaptureButtonUI(active) {
    const btn = document.getElementById('captureBtn');
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.innerHTML = active ? _captureStopHTML() : _captureStartHTML();
}

// ====================================
// TOGGLE CAPTURE
// ====================================
async function toggleCapture() {
    if (!captureActive) {
        if (!selectedDeviceId) { await showModal('Pilih Device','Pilih device terlebih dahulu.','warning',['ok']); return; }
        if (!isConnected) {
            await showModal('Device Offline','Tidak dapat memulai capture.\nPastikan device menyala.','error',['ok']); return;
        }
        openSessionNameModal();
    } else {
        const confirmed = await showModal('Hentikan Rekaman',
            'Hentikan sesi rekaman yang sedang berlangsung?\n\nData sudah tersimpan di Firebase.','warning',['confirm']);
        if (!confirmed) return;
        await _apiStopCapture();
    }
}

async function _apiStopCapture() {
    try {
        const res  = await fetch('/api/capture/stop', {method:'POST'});
        const json = await res.json();
        if (json.ok) {
            captureActive=false; currentSessionId=null;
            _updateCaptureButtonUI(false);
            buildSessionUI();
        } else {
            await showModal('Error','Gagal menghentikan: '+json.error,'error',['ok']);
        }
    } catch(e) { await showModal('Error','Network error: '+e.message,'error',['ok']); }
}

// ====================================
// SESSION NAME MODAL
// ====================================
function openSessionNameModal() {
    const modal = document.getElementById('sessionNameModal');
    const input = document.getElementById('sessionNameInput');
    const now   = new Date(), pad = v => String(v).padStart(2,'0');
    input.value = `Rekaman ${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    modal.classList.add('active'); document.body.style.overflow='hidden';
    setTimeout(()=>{ input.focus(); input.select(); },120);
}

function closeSessionNameModal() {
    document.getElementById('sessionNameModal').classList.remove('active');
    document.body.style.overflow='';
    _renamingSessionId=null; _resetSessionModal();
}

function _resetSessionModal() {
    const modal = document.getElementById('sessionNameModal');
    modal.querySelector('.modal-title').textContent   = 'Mulai Rekaman Baru';
    modal.querySelector('.modal-message').textContent = 'Beri nama sesi rekaman ini sebelum memulai.';
    const btn = modal.querySelector('.modal-btn-primary');
    btn.innerHTML = '&#9654; MULAI REKAM'; btn.onclick = confirmStartCapture;
}

function openRenameModal(sessionId, currentName, event) {
    event.stopPropagation();
    _renamingSessionId = sessionId;
    const modal = document.getElementById('sessionNameModal');
    const input = document.getElementById('sessionNameInput');
    modal.querySelector('.modal-title').textContent   = 'Rename Sesi';
    modal.querySelector('.modal-message').textContent = 'Ubah nama sesi rekaman ini.';
    const btn = modal.querySelector('.modal-btn-primary');
    btn.innerHTML = 'SIMPAN NAMA'; btn.onclick = confirmRenameSession;
    input.value = currentName;
    modal.classList.add('active'); document.body.style.overflow='hidden';
    setTimeout(()=>{ input.focus(); input.select(); },120);
}

async function confirmRenameSession() {
    const input   = document.getElementById('sessionNameInput');
    const newName = input.value.trim();
    if (!newName) { await showModal('Nama Kosong','Nama sesi tidak boleh kosong.','warning',['ok']); return; }
    const targetId = _renamingSessionId;
    closeSessionNameModal();
    if (!targetId) return;
    try {
        await database.ref(`devices/${selectedDeviceId}/History/${targetId}/_meta`).update({name: newName});
        if (sessionsData[targetId]) sessionsData[targetId].name = newName;
        buildSessionUI();
        await showModal('Berhasil',`Nama sesi diubah menjadi:\n"${newName}"`,'success',['ok']);
    } catch(e) { await showModal('Error','Gagal mengubah nama! Error: '+e.message,'error',['ok']); }
}

async function confirmStartCapture() {
    const input       = document.getElementById('sessionNameInput');
    const sessionName = (input.value.trim()) || `Rekaman ${new Date().toLocaleTimeString('id-ID')}`;
    const intervalSec = Math.round(captureInterval/1000) || 3;
    closeSessionNameModal();

    try {
        const res  = await fetch('/api/capture/start', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({sessionName, interval: intervalSec, deviceId: selectedDeviceId})
        });
        const json = await res.json();
        if (!json.ok) { await showModal('Error','Gagal memulai capture: '+(json.error||''),'error',['ok']); return; }

        captureActive    = true;
        currentSessionId = json.session_id;
        _updateCaptureButtonUI(true);
        buildSessionUI();

        await showModal('Capture Diaktifkan',
            `Sesi: "${json.session_name}"\nDevice: ${selectedDeviceName}\n\nRekaman berjalan di server.\nInterval: ${intervalSec}s`,
            'success',['ok']);
    } catch(e) { await showModal('Error','Network error: '+e.message,'error',['ok']); }
}

// ====================================
// DELETE SESSION
// ====================================
async function deleteSession(sessionId, sessionName, event) {
    event.stopPropagation();
    const confirmed = await showModal('Hapus Sesi',
        `Hapus sesi:\n"${sessionName}"\n\nSemua record akan ikut terhapus.`,'warning',['confirm']);
    if (!confirmed) return;
    try {
        await database.ref(`devices/${selectedDeviceId}/History/${sessionId}`).remove();
        delete sessionsData[sessionId]; delete recordsBySession[sessionId];
        historyData = historyData.filter(r=>r.sessionId!==sessionId);
        buildSessionUI();
        await showModal('Sesi Dihapus',`Sesi "${sessionName}" berhasil dihapus.`,'success',['ok']);
    } catch(e) { await showModal('Error','Gagal menghapus! Error: '+e.message,'error',['ok']); }
}

// ====================================
// SET CAPTURE INTERVAL
// ====================================
async function setCaptureInterval() {
    const ii = document.getElementById('intervalInput');
    const iu = document.getElementById('intervalUnit');
    const id = document.getElementById('intervalDisplay');
    const value = parseInt(ii.value), multiplier = parseInt(iu.value);
    if (isNaN(value) || value < 1) {
        await showModal('Input Tidak Valid','Masukkan nilai interval yang valid (minimal 1)!','warning',['ok']); return;
    }
    const totalSec  = value * multiplier;
    captureInterval = totalSec * 1000;
    const unitLabel = iu.options[iu.selectedIndex].text.toLowerCase();
    id.textContent  = multiplier===1 ? `Current: ${value} seconds` : `Current: ${value} ${unitLabel} (${totalSec}s)`;

    if (captureActive) {
        try {
            await fetch('/api/capture/interval', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({interval: totalSec})
            });
        } catch(e) { console.warn('[Capture] Could not update server interval:', e); }
    }
    await showModal('Interval Diperbarui',`Interval diubah menjadi ${value} ${unitLabel}.`,'success',['ok']);
}

// ====================================
// INITIALIZE APP
// ====================================
document.addEventListener('DOMContentLoaded', async () => {
    loadChartDataFromStorage();
    await loadDailyAggFromFirebase();
    initChart();

    document.getElementById('parameterSelect')?.addEventListener('change', changeParameter);
    document.querySelectorAll('.metric-card-compact').forEach(card => {
        if (!card.dataset.param) return;
        card.addEventListener('click', () => _switchParameter(card.dataset.param));
        card.classList.toggle('card-active', card.dataset.param === selectedParameter);
    });

    // Load devices — will also attach realtime & history listeners for first device
    await loadDevices();
    setInterval(loadDevices, 30000); // refresh device list every 30s

    updateConnectionStatus(false);
    startConnectionMonitoring();

    await syncCaptureStatus();
    _startStatusPolling();

    document.getElementById('sessionNameInput')?.addEventListener('keydown', e => {
        if (e.key==='Enter') { _renamingSessionId ? confirmRenameSession() : confirmStartCapture(); }
    });
});

window.addEventListener('beforeunload', () => {
    saveChartDataToStorage();
    if (_lastDayStr) _flushDailyAgg(_lastDayStr);
});