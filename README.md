# ⚡ Smart Energy Meter

Aplikasi **monitoring penggunaan daya listrik secara real-time** berbasis web. Sistem ini menerima data telemetri dari perangkat IoT (ESP32) yang dipasang di panel listrik, menyimpannya ke database PostgreSQL, dan menampilkannya dalam bentuk dashboard interaktif.

> **⚠️ Catatan Arsitektur:** Project ini berdiri **sendiri dan terpisah** dari aplikasi utama `sparta-energy` (Next.js/Vercel). Pemisahan ini **disengaja sebagai langkah disaster recovery** — jika database atau infrastruktur utama `sparta-energy` bermasalah, sistem monitoring energi ini tetap berjalan independen. Aplikasi `sparta-energy` me-*link* ke web ini sebagai panel monitoring eksternalnya.

---

## 🏗️ Arsitektur Sistem

```
[ ESP32 / Sensor Fisik ]
         │  (Kirim data via MQTT)
         ▼
[ MQTT Broker (HiveMQ Cloud) ]
         │  (Subscribe 24/7)
         ▼
[ Python Flask Backend (backend/app.py) ] ──► [ PostgreSQL Database ]
         │  (Serve REST API + static frontend)
         ▼
[ Browser — membuka http://localhost:5000 ]
         ▲
         │  (Embedded link / redirect)
[ sparta-energy (Next.js/Vercel) ]
```

### Yang Penting Dipahami
- **Frontend TIDAK berjalan sendiri.** File `frontend/index.html`, `app.js`, dan `style.css` di-*serve* oleh Flask backend. Kamu **tidak perlu** membuka file HTML-nya langsung.
- **Cukup jalankan backend** → frontend otomatis bisa diakses di browser.
- **Tidak ada Node.js / npm** yang perlu dijalankan. Stack-nya murni Python di sisi server.

---

## 📁 Struktur Direktori

```
Smart-Energy-Meter/
├── backend/
│   ├── app.py              # ← INI yang dijalankan. Flask app utama (REST API + MQTT + serve frontend)
│   └── requirements.txt    # Dependensi Python
├── frontend/
│   ├── index.html          # Di-serve oleh Flask (jangan buka langsung)
│   ├── app.js              # Logika dashboard (fetch API, charts, UI)
│   ├── style.css           # Stylesheet
│   └── img/                # Aset gambar
├── .env                    # ⚠️ TIDAK di-commit — buat manual (lihat bagian setup)
├── Dockerfile              # Untuk build image Docker
├── docker-compose.yml      # Untuk jalankan lokal via Docker
├── render.yaml             # Konfigurasi auto-deploy ke Render
└── README.md
```

---

## 🚀 Cara Menjalankan di Lokal

Ada **dua cara**. Pilih salah satu:

---

### ✅ Cara 1: Python Langsung (Direkomendasikan untuk Development)

**Prasyarat:** Python 3.11+, sudah punya akses ke PostgreSQL & MQTT broker.

```powershell
# 1. Aktifkan virtual environment (sudah ada folder .venv di project)
.venv\Scripts\activate

# 2. Install dependensi (cukup sekali, atau kalau requirements.txt berubah)
pip install -r backend/requirements.txt

# 3. Pastikan file .env sudah ada di root folder (lihat bagian Konfigurasi di bawah)

# 4. Jalankan backend Flask
python backend/app.py
```

Setelah muncul output seperti `Running on http://0.0.0.0:5000`, buka browser ke:
**➜ http://localhost:5000**

---

### 🐳 Cara 2: Docker Compose (Sama persis dengan environment Render)

**Prasyarat:** Docker Desktop terinstall dan sedang berjalan.

```powershell
# 1. Pastikan file .env sudah ada di root folder

# 2. Build dan jalankan
docker-compose up --build

# Untuk jalan di background:
docker-compose up --build -d

# Untuk stop:
docker-compose down
```

Buka browser ke: **➜ http://localhost:5000**

---

## 🔑 Konfigurasi `.env`

Buat file bernama `.env` di **root folder** (`Smart-Energy-Meter/.env`) dengan isi:

```env
# ── PostgreSQL ───────────────────────────────────────────────────────
# Format: postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME
DATABASE_URL=postgresql://postgres:password@localhost:5432/energy_meter

# ── MQTT Broker (HiveMQ Cloud) ───────────────────────────────────────
MQTT_BROKER=your-broker-host.hivemq.cloud
MQTT_PORT=8883
MQTT_USERNAME=your_mqtt_username
MQTT_PASSWORD=your_mqtt_password
MQTT_USE_TLS=true
```

> File `.env` sudah ada di `.gitignore` sehingga **tidak akan ter-commit ke Git**. Isi nilai yang benar dari dashboard HiveMQ dan database provider yang dipakai.

Untuk deployment Render, nilai-nilai ini diisi manual di **Render Dashboard → Environment**.

---

## 🌐 Status Deployment

Project ini sudah di-deploy di **Render** via Docker:

- Render membaca `render.yaml` → build image dari `Dockerfile`
- Flask/Gunicorn berjalan dengan **1 worker** (penting agar koneksi MQTT tidak terpecah antar proses)
- Environment variables diisi manual di Render Dashboard

---

## 🗄️ Skema Database (PostgreSQL)

Tabel dibuat **otomatis** saat backend pertama kali dijalankan (`CREATE TABLE IF NOT EXISTS`) — tidak perlu migration manual.

| Tabel | Fungsi |
|---|---|
| `devices` | Daftar perangkat IoT, nama kustom, status online, konfigurasi fase/sensor |
| `telemetry` | Snapshot otomatis tiap 15 menit (grafik harian/mingguan) |
| `history` | Rekaman intensif saat sesi *capture* aktif, dikelompokkan by `session_id` |

---

## ✨ Fitur Utama

1. **Real-time Monitoring** — Tegangan (V), Arus (A), Daya (W), Frekuensi (Hz), Power Factor, Energi (kWh) per fase (L1, L2, L3)
2. **Capture Session** — Mulai/hentikan perekaman data ke sesi bernama, lihat grafik per sesi
3. **Histori Harian** — Grafik trend konsumsi daya per hari
4. **Multi-device** — Mendukung beberapa perangkat ESP32 sekaligus
5. **Device Settings** — Atur nama perangkat, aktifkan/nonaktifkan fase, beri nama kustom tiap sensor

---

## 🔗 Hubungan dengan sparta-energy

| | Smart-Energy-Meter | sparta-energy |
|---|---|---|
| **Stack** | Python Flask + HTML/CSS/JS | Next.js + TypeScript + Vercel |
| **Database** | PostgreSQL (psycopg2) | PostgreSQL (Prisma ORM) |
| **Tujuan** | Monitoring energi real-time | Aplikasi utama/portal |
| **Ketergantungan** | **Berdiri sendiri** | Nge-link ke project ini |

Pemisahan ini memastikan: jika `sparta-energy` atau infrastructure Vercel-nya crash, dashboard monitoring energi **tetap dapat diakses** secara independen.

---

## 🐛 Troubleshooting

| Masalah | Solusi |
|---|---|
| `ModuleNotFoundError` | Pastikan virtual env aktif: `.venv\Scripts\activate`, lalu `pip install -r backend/requirements.txt` |
| Error koneksi database | Periksa `DATABASE_URL` di `.env`, pastikan PostgreSQL bisa diakses |
| MQTT tidak terkoneksi | Periksa kredensial MQTT, pastikan `MQTT_USE_TLS=true` untuk HiveMQ Cloud |
| Port 5000 sudah dipakai | Tambahkan `FLASK_PORT=5001` di `.env`, atau hentikan proses lain di port 5000 |
| Docker build gagal | Pastikan Docker Desktop jalan, coba `docker-compose down` lalu `up --build` lagi |