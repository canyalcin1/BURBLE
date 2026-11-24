/* BURBLE demo: ingest -> quality -> standardize -> suggest -> expert approval -> output. Plain JS, no build. */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => n == null || isNaN(n) ? '–' : n.toLocaleString('tr-TR', { maximumFractionDigits: d, minimumFractionDigits: d });
const HOUR = 3600e3, DAY = 24 * HOUR;

/* ---------- Sources (raw files, unchanged from the portals) ---------- */
const SOURCES = [
  { id: 'battledim', label: 'BattLeDIM L-Town SCADA (simülasyon)', org: 'Kıbrıs Üniv. KIOS, Zenodo', note: 'ondalık virgül · birim yok · saat dilimi yok', hl: /\d+,\d+/g, file: 'data/battledim_2019_01_scada_flows.csv', tz: null, site: 'L-Town', unitInfo: 'Dosyada yok, yalnızca README’de', timeInfo: 'Yerel, dilim belirtilmemiş, 5 dk' },
  { id: 'iski', label: 'İSKİ baraj doluluk', org: 'İBB Açık Veri', note: 'İngilizce kolon · hacim birimsiz · 2021’de durmuş', hl: /,(\d{3})$/gm, file: 'data/ibb_baraj_doluluk_2005_2021.csv', tz: 3, site: 'İstanbul (genel)', freshDays: 30, unitInfo: 'Oran %, hacim birimsiz', timeInfo: 'Tarih, günlük' },
  { id: 'izsu_dam', label: 'İZSU baraj doluluk', org: 'İzmir BB Açık Veri', note: 'BOM · yükseklik = doluluk?', hl: /(\d+\.\d+);\1(?=;)/g, file: 'data/izsu_baraj_doluluk.csv', tz: 3, freshDays: 30, unitInfo: 'Belirtilmemiş', timeInfo: 'ISO, yerel saat' },
  { id: 'izsu_prod', label: 'İZSU günlük su üretimi', org: 'İzmir BB Açık Veri', note: 'tarih kolonu yok · birim yok', hl: /URETIM_MIKTARI/g, file: 'data/izsu_gunluk_uretim.csv', tz: 3, unitInfo: 'Belirtilmemiş', timeInfo: 'Yok' },
  { id: 'izsu_loss', label: 'İZSU su kayıpları 2019', org: 'İzmir BB Açık Veri', note: 'binlik mi ondalık mı?', pick: /KINIK/, hl: /\d{3},\d{3}(?=;)/g, file: 'data/izsu_su_kayiplari_2019.csv', tz: 3, unitInfo: 'Belirtilmemiş', timeInfo: 'Yalnızca yıl' },
];

/* Allowed target schema. The LLM may only map into these (enforced server-side too). */
const SCHEMA = {
  flow_rate: 'm3/h', pump_flow: 'm3/h', pressure: 'm', tank_level: 'm', water_level: 'm',
  reservoir_fill_pct: '%', reservoir_volume: 'm3', reservoir_usable_volume: 'm3', production_volume: 'm3/d',
  system_input_volume: 'm3/yr', physical_loss: 'm3/yr', apparent_loss: 'm3/yr', water_loss: 'm3/yr',
  non_revenue_water: 'm3/yr', revenue_water: 'm3/yr', energy: 'kWh', turbidity: 'NTU', chlorine: 'mg/L',
  ph: '-', conductivity: 'uS/cm', temperature: 'degC',
};

/* Mapping library ("Eşleştirme Bilgi Havuzu"). tier: auto | suggest | flag */
const README = 'Zenodo README: "2019_SCADA_Flows … Measurement units: Cubic meters per hour (m^3/h)"';
const CATALOG = [
  { re: /^(timestamp|date|datetime|tarih|zaman|durum_tarihi)$/i, role: 'time' },
  { re: /^yil$/i, role: 'time', annual: true },
  { re: /^(ilce|baraj_kuyu_adi|site|station|tesis)$/i, role: 'site' },
  { re: /^(baraj_kuyu_id|sira|enlem|boylam|tur_adi|baraj_su_durumu_gosterimi|maksimum_.*|minimum_.*|kullanilabilir_gol_su_hacmi)$/i, role: 'meta' },
  { re: /^(temin_|fatura|izin|sayac|depolar)/i, role: 'meta', note: 'IWA alt bileşeni, denge kontrolünde kullanılır' },
  { re: /^p\d+$/i, v: 'flow_rate', factor: 1, tier: 'suggest', conf: .8, ev: 'Dosyada birim yok. ' + README },
  { re: /^pump_\d+$/i, v: 'pump_flow', factor: 1, tier: 'suggest', conf: .8, ev: 'Dosyada birim yok. ' + README },
  { re: /^general_dam_occupancy_rate$/i, v: 'reservoir_fill_pct', factor: 1, tier: 'auto', conf: .97, ev: 'Kolon adı + değerler 0–100 aralığında' },
  { re: /^general_dam_reserved_water$/i, v: 'reservoir_volume', factor: 1e6, tier: 'suggest', conf: .75, ev: 'Birim yok. Değerler 80–861 aralığında; İSKİ toplam kapasitesi ≈ 868 milyon m³ → milyon m³ varsayıldı (×10⁶)' },
  { re: /^doluluk_orani$/i, v: 'reservoir_fill_pct', factor: 1, tier: 'auto', conf: .95, ev: 'Kolon adı + değerler 0–100' },
  { re: /^su_durumu$/i, v: 'reservoir_volume', factor: 1, tier: 'suggest', conf: .8, ev: 'MAKSIMUM_SU_KAPASITESI ile aynı ölçek → m³' },
  { re: /^tuketilebilir_su_kapasitesi$/i, v: 'reservoir_usable_volume', factor: 1, tier: 'suggest', conf: .8, ev: 'SU_DURUMU − MINIMUM_SU_KAPASITESI ile eşit → m³' },
  { re: /^su_yuksekligi$/i, v: 'water_level', factor: 1, tier: 'suggest', conf: .6, ev: 'Kolon adı “yükseklik” → metre beklenir' },
  { re: /^uretim_miktari$/i, v: 'production_volume', factor: 1, tier: 'suggest', conf: .7, ev: 'Kolon adı; birim ve tarih dosyada yok, m³/gün varsayıldı' },
  { re: /^sisteme_giren_su_miktari$/i, v: 'system_input_volume', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA su denge tablosu terimi, yıllık m³' },
  { re: /^fiziki_kayiplar$/i, v: 'physical_loss', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA: fiziki (gerçek) kayıplar' },
  { re: /^idari_kayiplar$/i, v: 'apparent_loss', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA: idari (görünür) kayıplar' },
  { re: /^su_kayiplari$/i, v: 'water_loss', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA: fiziki + idari' },
  { re: /^gelir_getirmeyen_su_miktari$/i, v: 'non_revenue_water', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA: gelir getirmeyen su (NRW)' },
  { re: /^gelir_getiren_su_miktari$/i, v: 'revenue_water', factor: 1, tier: 'suggest', conf: .85, ev: 'IWA: gelir getiren su' },
];

/* Expert approvals persist in the browser (demo of "uzman onayıyla öğrenme"). */
const LIB_KEY = 'burble_lib_v1';
let lib = {};
try { lib = JSON.parse(localStorage.getItem(LIB_KEY) || '{}'); } catch { lib = {}; }
const saveLib = () => { try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch {} };

/* ---------- 1. Ingest ---------- */
const norm = s => s.replace(/^﻿/, '').trim().toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
function ingest(text) {
  const bom = text.charCodeAt(0) === 0xFEFF;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const h = lines[0];
  const delim = [';', ',', '\t'].sort((a, b) => h.split(b).length - h.split(a).length)[0];
  const headers = h.split(delim).map(x => x.trim());
  const rows = lines.slice(1).map(l => l.split(delim));
  let dc = 0, dp = 0, nn = 0;
  for (const r of rows.slice(0, 300)) for (const c of r) { if (/^-?[\d.,]+$/.test(c)) nn++; if (/^-?\d+,\d+$/.test(c)) dc++; else if (/^-?\d+\.\d+$/.test(c)) dp++; }
  return { headers, rows, delim, bom, decimalComma: delim !== ',' && dc > dp && dc > .3 * nn };
}
function num(raw, ing) {
  if (raw == null) return { v: NaN, empty: true };
  const s = raw.trim();
  if (s === '' || /^(na|nan|null|-)$/i.test(s)) return { v: NaN, empty: true };
  if (ing.decimalComma) return { v: +s.replace(/\./g, '').replace(',', '.') };
  if (/^-?\d{1,3}(,\d{3})+$/.test(s) && ing.delim !== ',') return { v: NaN, ambiguous: true, a: +s.replace(/,/g, ''), b: +s.replace(',', '.') };
  return { v: +s };
}
function parseTs(s, tz, annual) {
  if (!s) return NaN; s = s.trim();
  let m;
  if (annual || /^\d{4}$/.test(s)) return Date.UTC(+s.slice(0, 4), 0, 1);
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/))) return Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - (tz || 0) * HOUR;
  if ((m = s.match(/^(\d{2})[./](\d{2})[./](\d{4})(?: (\d{2}):(\d{2}))?/))) return Date.UTC(+m[3], m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) - (tz || 0) * HOUR;
  return NaN;
}

/* ---------- 2–4. Map, standardize, check ---------- */
function mapColumns(src, ing) {
  return ing.headers.map((col, i) => {
    const n = norm(col);
    const rule = CATALOG.find(r => r.re.test(n));
    const libKey = `map:${src.id}:${col}`;
    if (rule) {
      const m = { col, i, ...rule };
      if (m.v && lib[libKey]) { m.tier = 'auto'; m.conf = .95; m.ev += ' · uzman onayı kütüphanede'; }
      if (m.v && lib[libKey + ':v']) Object.assign(m, lib[libKey + ':v']);
      return m;
    }
    if (lib[libKey + ':v']) return { col, i, ...lib[libKey + ':v'], tier: 'auto', conf: .9, ev: 'Uzman onaylı (model önerisi)' };
    const numeric = ing.rows.slice(0, 50).filter(r => /^-?[\d.,]+$/.test((r[i] || '').trim())).length > 25;
    return { col, i, role: numeric ? 'unmapped' : 'meta', unmapped: numeric };
  });
}

function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return NaN; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }

function inject(ing) {
  const H = ing.headers, ix = n => H.findIndex(h => norm(h) === n), R = ing.rows;
  const p227 = ix('p227'), p235 = ix('p235'), pump = ix('pump_1'), t = ix('timestamp');
  for (let k = 2000; k < 2036; k++) R[k][p235] = R[2000][p235];                       // S2 donmuş sensör, 3 saat
  for (let k = 4000; k < 4288; k++) R[k][p227] = (num(R[k][p227], ing).v * 1000).toFixed(0); // S1 birim kayması m³/h → L/h, 1 gün
  for (let k = 6000; k < 6036; k++) { const d = new Date(Date.parse(R[k][t].replace(' ', 'T') + 'Z') + 3 * HOUR); R[k][t] = d.toISOString().slice(0, 19).replace('T', ' '); } // S4 zaman kayması +3 sa
  for (let k = 500; k < 506; k++) R[k][pump] = '-999';                                   // hata kodu
  R.splice(7000, 24);                                                                    // 2 saatlik iletişim kesintisi
  return 5;
}

function process(src, ing) {
  const maps = mapColumns(src, ing);
  const issues = [], series = [];
  const add = (o) => issues.push({ source: src.label, srcId: src.id, ...o });
  const tCol = maps.find(m => m.role === 'time'), sCol = maps.find(m => m.role === 'site');

  // timestamps
  const ts = ing.rows.map(r => tCol ? parseTs(r[tCol.i], src.tz, tCol.annual) : NaN);
  if (!tCol) add({ type: 'Zaman damgası yok', signal: '(tüm dosya)', tier: 'flag', conf: .99, n: ing.rows.length, ev: 'Hiçbir kolon tarih/zaman olarak tanınmadı; kayıtlar zamansız tutulur' });
  else if (src.tz == null && !lib[`tz:${src.id}`]) add({ type: 'Saat dilimi belirsiz', signal: tCol.col, tier: 'suggest', conf: .6, n: ing.rows.length, ev: 'Dosya ve README saat dilimi vermiyor; UTC varsayıldı', key: `tz:${src.id}` });

  // time index checks (per site, in file order)
  if (tCol && !tCol.annual) {
    const bySite = {};
    ing.rows.forEach((r, k) => { (bySite[sCol ? r[sCol.i] : '_'] ||= []).push(ts[k]); });
    let dup = 0, back = 0, gapPts = 0, gaps = 0;
    for (const arr of Object.values(bySite)) {
      if (arr.length < 3) continue;
      const step = median(arr.slice(1).map((x, k) => x - arr[k]).filter(d => d > 0));
      const seen = new Set();
      arr.forEach((x, k) => {
        if (seen.has(x)) dup++; seen.add(x);
        if (k && x < arr[k - 1]) back++;
        if (k && x - arr[k - 1] > 1.5 * step) { gaps++; gapPts += Math.round((x - arr[k - 1]) / step) - 1; }
      });
    }
    if (dup) add({ type: 'Tekrarlı zaman damgası', signal: tCol.col, tier: 'suggest', conf: .95, n: dup, ev: `${dup} kayıt aynı zaman damgasını tekrar ediyor; sonuncusu tutulması önerilir` });
    if (back) add({ type: 'Zaman kayması / geri sıçrama', signal: tCol.col, tier: 'flag', conf: .9, n: back, ev: `${back} noktada zaman geriye gidiyor (saat dilimi/DST veya cihaz saati kayması)` });
    if (gaps) add({ type: 'Veri boşluğu (iletişim kesintisi)', signal: tCol.col, tier: 'auto', conf: .95, n: gapPts, ev: `${gaps} boşlukta ${gapPts} beklenen kayıt yok; “eksik” bayrağı eklenir, değer uydurulmaz` });
    if (src.freshDays) {
      const last = Math.max(...ts.filter(Number.isFinite)), age = Math.round((Date.now() - last) / DAY);
      if (age > src.freshDays) add({ type: 'Güncel olmayan veri', signal: '(kaynak)', tier: 'flag', conf: .99, n: 1, ev: `Son kayıt ${new Date(last + (src.tz || 0) * HOUR).toISOString().slice(0, 10)}, ${age} gün önce` });
    }
  }

  // measures -> standard records
  for (const m of maps.filter(m => m.v || m.unmapped)) {
    if (m.unmapped) { add({ type: 'Şemada karşılığı yok', signal: m.col, tier: 'flag', conf: .5, n: ing.rows.length, ev: 'Kütüphanede eşleşme yok; asistana eşleme önerisi sorulabilir', unmapped: true, samples: ing.rows.slice(0, 5).map(r => r[m.i]) }); continue; }
    if (m.tier !== 'auto') add({ type: m.v === 'water_level' ? 'Belirsiz kolon anlamı' : 'Birimsiz sinyal / şema eşleme', signal: m.col, tier: 'suggest', conf: m.conf, n: ing.rows.length, ev: `${m.col} → ${m.v} [${SCHEMA[m.v]}${m.factor !== 1 ? `, ×${m.factor.toExponential(0)}` : ''}]. ${m.ev}`, key: `map:${src.id}:${m.col}` });
    const recs = ing.rows.map((r, k) => {
      const p = num(r[m.i], ing);
      const site = sCol ? r[sCol.i].trim() : (src.site || src.id) + (/^p\d+|pump/i.test(m.col) ? '/' + m.col : '');
      const rec = { ts: ts[k], source: src.id, site, variable: m.v, value: p.v * m.factor, unit: SCHEMA[m.v], flag: 'good', conf: m.conf ?? .9, raw: `${m.col}=${r[m.i]}` };
      if (p.empty) { rec.flag = 'missing'; rec.value = null; }
      if (p.ambiguous) {
        const key = `num:${src.id}:${m.col}:${r[m.i]}`;
        if (lib[key]) { rec.value = p.a * m.factor; rec.flag = 'estimated'; rec.conf = .9; }
        else { rec.value = null; rec.flag = 'suspect'; rec.amb = p; }
        rec.ambKey = key;
      }
      return rec;
    });
    series.push({ src, m, recs, siteKey: !!sCol });
  }

  // value checks
  for (const s of series) {
    const { m, recs } = s, label = `${m.col}`;
    // ambiguous numbers
    for (const r of recs.filter(r => r.amb)) add({ type: 'Belirsiz sayı biçimi', signal: `${label} · ${r.site}`, tier: 'suggest', conf: .7, n: 1, ev: `"${r.raw.split('=')[1]}" binlik ayraçla ${fmt(r.amb.a)} mi, ondalıkla ${fmt(r.amb.b, 3)} mü? Kolondaki diğer değerler tamsayı → ${fmt(r.amb.a)} önerilir`, key: r.ambKey, recRef: r });
    // sentinel codes
    const sent = recs.filter(r => [-999, -9999, -99999, 9999].includes(r.value));
    if (sent.length) { sent.forEach(r => { r.value = null; r.flag = 'missing'; r.conf = .99; }); add({ type: 'Hata kodu (−999) değer sanılmış', signal: label, tier: 'auto', conf: .99, n: sent.length, ev: 'Katalogdaki hata kodu “eksik” bayrağına çevrildi; ham değer korunuyor' }); }
    // physical plausibility
    const phys = recs.filter(r => r.value != null && ((m.v === 'reservoir_fill_pct' && (r.value < 0 || r.value > 100)) || (/flow|volume|loss/.test(m.v) && r.value < 0)));
    if (phys.length) { phys.forEach(r => { r.flag = 'suspect'; r.conf = .3; }); add({ type: 'Fiziksel olarak imkânsız değer', signal: label, tier: 'flag', conf: .95, n: phys.length, ev: 'Negatif debi/hacim veya %0–100 dışı doluluk' }); }
    // magnitude jump (unit switch) for sub-hourly
    const vals = recs.map(r => r.value).filter(Number.isFinite), med = median(vals.map(Math.abs));
    const step = median(recs.slice(1).map((r, k) => r.ts - recs[k].ts).filter(d => d > 0));
    if (step <= HOUR && med > 0) {
      const jump = recs.filter(r => r.value != null && Math.abs(r.value) > 100 * med);
      if (jump.length) { jump.forEach(r => { r.flag = 'suspect'; r.conf = .2; r.jump = true; }); add({ type: 'Birim kayması (≈×1000)', signal: label, tier: 'suggest', conf: .85, n: jump.length, ev: `Değerler medyanın (${fmt(med, 1)}) ${fmt(median(jump.map(r => r.value)) / med)} katı; m³/h ↔ L/h değişimi olası, ÷1000 önerilir` }); }
      // frozen sensor vs pump-off
      let k = 0, frozen = 0, frozenRuns = 0, off = 0;
      while (k < recs.length) {
        let j = k; while (j + 1 < recs.length && recs[j + 1].value === recs[k].value && recs[k].value != null) j++;
        const len = j - k + 1;
        if (len >= 6) {
          if (recs[k].value === 0 && m.v === 'pump_flow') { off += len; for (let q = k; q <= j; q++) recs[q].state = 'pump_off'; }
          else { frozen += len; frozenRuns++; for (let q = k; q <= j; q++) { recs[q].flag = 'suspect'; recs[q].conf = .4; } }
        }
        k = j + 1;
      }
      if (frozen) add({ type: 'Donmuş sensör şüphesi', signal: label, tier: 'flag', conf: Math.min(.95, .6 + frozenRuns / 200), n: frozen, ev: `${frozenRuns} blokta ≥30 dk boyunca birebir aynı değer; veriye dokunulmaz, bakım uyarısı` });
      if (off) add({ type: 'Pompa kapalı (donma değil)', signal: label, tier: 'auto', conf: .9, info: true, n: off, ev: 'Sıfır debi blokları fiziksel olarak makul; “pump_off” durum etiketi eklendi, şüpheli sayılmadı' });
      // hour-of-day robust outliers
      const byH = Array.from({ length: 24 }, () => []);
      recs.forEach(r => { if (r.value != null && !r.jump) byH[new Date(r.ts).getUTCHours()].push(r.value); });
      const st = byH.map(a => { const md = median(a); return [md, median(a.map(x => Math.abs(x - md))) * 1.4826 || 1]; });
      const out = recs.filter(r => r.value != null && !r.jump && r.flag === 'good' && Math.abs(r.value - st[new Date(r.ts).getUTCHours()][0]) / st[new Date(r.ts).getUTCHours()][1] > 5);
      if (out.length && m.v !== 'pump_flow') { out.forEach(r => { r.flag = 'suspect'; r.conf = .5; }); add({ type: 'Aykırı değer (saatlik profil)', signal: label, tier: 'flag', conf: .75, n: out.length, ev: 'Aynı saat dilimindeki medyandan >5 robust sapma' }); }
    }
  }

  // cross-column physics
  const get = (col) => series.find(s => norm(s.m.col) === col);
  if (src.id === 'izsu_dam') {
    const fill = get('doluluk_orani'), lvl = get('su_yuksekligi');
    const minH = ing.headers.findIndex(h => norm(h) === 'minimum_su_yuksekligi'), maxH = ing.headers.findIndex(h => norm(h) === 'maksimum_su_yuksekligi');
    if (fill && lvl && fill.recs.every((r, k) => r.value === lvl.recs[k].value)) {
      lvl.recs.forEach(r => { r.flag = 'suspect'; r.conf = .2; });
      add({ type: 'Kopya / yanlış etiketli kolon', signal: 'SU_YUKSEKLIGI', tier: 'flag', conf: .9, n: lvl.recs.length, ev: 'SU_YUKSEKLIGI tüm satırlarda DOLULUK_ORANI ile birebir aynı; metre değil yüzde taşıyor olabilir' });
      const below = lvl.recs.filter((r, k) => r.value < +ing.rows[k][minH] || r.value > +ing.rows[k][maxH]).length;
      if (below) add({ type: 'Fiziksel tutarsızlık', signal: 'SU_YUKSEKLIGI', tier: 'flag', conf: .9, n: below, ev: `${below} barajda su yüksekliği min–maks kot aralığının dışında` });
    }
  }
  if (src.id === 'izsu_loss') {
    const v = c => get(c)?.recs;
    const sin = v('sisteme_giren_su_miktari'), rev = v('gelir_getiren_su_miktari'), nrw = v('gelir_getirmeyen_su_miktari');
    const bad = sin ? sin.map((r, k) => ({ r, d: r.value - rev[k].value - nrw[k].value })).filter((x, k) => rev[k].value != null && nrw[k].value != null && Math.abs(x.d) > 10) : [];
    if (bad.length) add({ type: 'Su denge tablosu tutmuyor', signal: 'IWA dengesi', tier: 'flag', conf: .9, n: bad.length, ev: bad.map(x => `${x.r.site}: ${fmt(x.d)} m³ fark`).join(', ') + ' (Sisteme giren ≠ gelir getiren + getirmeyen)' });
  }
  return { maps, issues, series, ing };
}

/* ---------- UI state ---------- */
const state = { raw: {}, results: [], records: [], issues: [], uploads: [] };
const log = (t) => { const el = $('#log'); el.textContent += '\n' + t; el.scrollTop = el.scrollHeight; };

async function loadAll() {
  await Promise.all(SOURCES.map(async s => { try { state.raw[s.id] = await (await fetch(s.file)).text(); } catch { state.raw[s.id] = ''; } }));
  renderSources(); renderRaw();
  drawScope();
  run();
}
function renderSources() {
  const tb = $('#srcTable tbody'); tb.innerHTML = '';
  for (const s of [...SOURCES, ...state.uploads]) {
    const ing = ingest(state.raw[s.id] || 'x');
    tb.insertAdjacentHTML('beforeend', `<tr><td><b>${esc(s.label)}</b><br><small>${s.org}</small></td><td><code>${ing.delim === ';' ? 'CSV “;”' : ing.delim === '\t' ? 'TSV' : 'CSV “,”'}${ing.decimalComma ? ', ondalık “,”' : ''}${ing.bom ? ', BOM' : ''}</code></td><td>${fmt(ing.rows.length)}</td><td><code>${esc(ing.headers.slice(0, 3).join(', '))}${ing.headers.length > 3 ? ` +${ing.headers.length - 3}` : ''}</code></td><td>${s.unitInfo}</td><td>${s.timeInfo}</td></tr>`);
  }
}

async function run() {
  $('#log').textContent = '▶ BURBLE hattı başladı ' + new Date().toLocaleTimeString('tr-TR');
  const steps = [...document.querySelectorAll('#steps li')]; steps.forEach(li => li.classList.remove('on'));
  const on = async n => { steps[n - 1].classList.add('on'); await new Promise(r => setTimeout(r, 180)); };
  state.results = []; state.records = []; state.issues = [];
  await on(1);
  for (const s of [...SOURCES, ...state.uploads]) {
    const ing = ingest(state.raw[s.id] || '');
    if (!ing.headers.length || !ing.rows.length) { log(`✗ ${s.label}: okunamadı`); continue; }
    if (s.id === 'battledim' && $('#inject').checked) log(`⚠ ${s.label}: ${inject(ing)} tip SENTETİK arıza enjekte edildi (S1 birim, S2 donma, S4 zaman, boşluk, −999)`);
    log(`1 · ${s.label}: ${fmt(ing.rows.length)} satır, ayraç "${ing.delim === '\t' ? 'TAB' : ing.delim}", ondalık "${ing.decimalComma ? ',' : '.'}"${ing.bom ? ', UTF-8 BOM' : ''}`);
    state.results.push(process(s, ing));
  }
  await on(2);
  state.issues = state.results.flatMap(r => r.issues);
  log(`2 · ${state.issues.length} bulgu, ${fmt(state.issues.reduce((a, i) => a + i.n, 0))} etkilenen kayıt`);
  await on(3);
  state.records = state.results.flatMap(r => r.series.flatMap(s => s.recs));
  log(`3 · ${fmt(state.records.length)} kayıt ortak şemaya yazıldı (ts_utc, kaynak, tesis, değişken, değer, SI birim, bayrak, güven)`);
  await on(4);
  const cnt = t => state.issues.filter(i => i.tier === t).length;
  countUp($('#tAuto'), cnt('auto')); countUp($('#tSug'), cnt('suggest')); countUp($('#tFlag'), cnt('flag'));
  log(`4 · Karar kuralı: ${cnt('auto')} otomatik, ${cnt('suggest')} öneri (onay bekliyor), ${cnt('flag')} yalnızca işaret`);
  await on(5);
  log(`5 · Uzman kütüphanesinde ${Object.keys(lib).length} onaylı karar var`);
  await on(6);
  const g = state.records.filter(r => r.flag === 'good').length;
  log(`6 · Onaylı çıktı hazır: kayıtların %${fmt(100 * g / state.records.length, 1)}'i “iyi”, kalanı bayraklı. Ham veri değişmedi.`);
  renderIssues(); renderStd(); renderPareto(); renderLoss(); renderForecast(); renderLca();
  renderHeroStats(); document.querySelectorAll('.q').forEach(b => { b.disabled = false; b.classList.remove('on'); });
  $('#aiOut').textContent = 'Hazır. Yukarıdaki sorulardan birini seç.';
  drawScope();
}

const TIER = { auto: 'Otomatik', suggest: 'Öner', flag: 'İşaretle' };
let filter = 'all';
function renderIssues() {
  const tb = $('#issues tbody'); tb.innerHTML = '';
  const order = { suggest: 0, flag: 1, auto: 2 };
  state.issues.sort((a, b) => order[a.tier] - order[b.tier] || b.n - a.n).forEach((i, k) => {
    if (filter !== 'all' && i.tier !== filter) return;
    const approved = i.key && lib[i.key];
    tb.insertAdjacentHTML('beforeend', `<tr><td><span class="tag ${i.tier}">${TIER[i.tier]}</span></td><td>${esc(i.source)}<br><code>${esc(i.signal)}</code></td><td>${i.type}</td><td class="num">${fmt(i.n)}</td><td class="num">${fmt(i.conf * 100)}%</td><td><small>${esc(i.ev)}</small></td><td>${i.key ? `<button class="approve" type="button" data-k="${k}" ${approved ? 'disabled' : ''}>${approved ? 'Onaylı' : 'Onayla'}</button>` : ''}</td></tr>`);
  });
  stagger(tb);
}
$('#issues').addEventListener('click', e => {
  const b = e.target.closest('.approve'); if (!b) return;
  const i = state.issues[+b.dataset.k]; lib[i.key] = { by: 'uzman', at: new Date().toISOString() }; saveLib();
  log(`✓ Onay kaydedildi: ${i.type} · ${i.signal}. Hat yeniden çalışıyor, benzer sinyal artık otomatik.`); run();
});
function renderStd() {
  const tb = $('#std tbody'); tb.innerHTML = '';
  const pick = [];
  for (const res of state.results) { const rs = res.series.flatMap(x => x.recs); const bad = rs.find(r => r.flag !== 'good'); pick.push(...rs.filter(r => r.flag === 'good').slice(0, bad ? 2 : 3)); if (bad) pick.push(bad); }
  pick.forEach(r => tb.insertAdjacentHTML('beforeend', `<tr><td>${Number.isFinite(r.ts) ? new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ') : '<span class="tag flag">zaman yok</span>'}</td><td>${esc(r.site)}</td><td><code>${r.variable}</code></td><td class="num">${r.value == null ? '–' : fmt(r.value, r.value > 999 ? 0 : 2)} <small class="u">${r.unit}</small></td><td><span class="tag ${r.flag === 'good' ? 'auto' : r.flag === 'suspect' ? 'flag' : 'suggest'}">${r.flag}</span></td></tr>`));
  stagger(tb);
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
$('#dlCsv').onclick = () => download('burble_standart.csv', 'ts_utc,source,site,variable,value,unit,quality_flag,state,confidence,raw_ref\n' + state.records.map(r => [Number.isFinite(r.ts) ? new Date(r.ts).toISOString() : '', r.source, `"${r.site}"`, r.variable, r.value ?? '', r.unit, r.flag, r.state || '', r.conf, `"${r.raw}"`].join(',')).join('\n'), 'text/csv');
$('#dlRep').onclick = () => download('burble_kalite_raporu.json', JSON.stringify({ generated: new Date().toISOString(), issues: state.issues.map(({ recRef, ...i }) => i), approvals: lib }, null, 2), 'application/json');

/* ---------- Charts ---------- */
const charts = {};
Chart.defaults.locale = 'tr-TR'; Chart.defaults.color = '#5B6B80'; Chart.defaults.borderColor = '#E5EBF2'; Chart.defaults.font.family = "'Fira Sans', system-ui";
function chart(id, cfg) { charts[id]?.destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }
function paretoCfg(labels, vals, color, unit) {
  const tot = vals.reduce((a, b) => a + b, 0); let c = 0; const cum = vals.map(v => (c += v) / tot * 100);
  return { data: { labels, datasets: [
    { type: 'bar', data: vals, backgroundColor: color, yAxisID: 'y', label: unit },
    { type: 'line', data: cum, borderColor: '#D97706', backgroundColor: '#D97706', pointRadius: 2, borderWidth: 2, yAxisID: 'y1', label: 'Kümülatif %' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { autoSkip: false, maxRotation: 60, font: { size: 10 } } }, y: { beginAtZero: true }, y1: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: v => v + '%' } } } } };
}
function renderPareto() {
  const agg = {}; state.issues.filter(i => !i.info).forEach(i => agg[i.type] = (agg[i.type] || 0) + i.n);
  const e = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  chart('cPareto', paretoCfg(e.map(x => x[0]), e.map(x => x[1]), '#3B82F6', 'kayıt'));
}
function renderLoss() {
  const r = state.results.find(r => r.series[0]?.src.id === 'izsu_loss'); if (!r) return;
  const loss = r.series.find(s => s.m.v === 'water_loss'), inp = r.series.find(s => s.m.v === 'system_input_volume');
  const rows = loss.recs.map((x, k) => ({ site: x.site, v: x.value, pct: 100 * x.value / inp.recs[k].value })).sort((a, b) => b.v - a.v);
  chart('cLoss', paretoCfg(rows.map(x => x.site), rows.map(x => x.v), '#1E40AF', 'm³'));
  const tot = rows.reduce((a, x) => a + x.v, 0), worst = [...rows].sort((a, b) => b.pct - a.pct).slice(0, 3);
  $('#lossNote').textContent = `${rows[0].site} tek başına kaybın %${fmt(100 * rows[0].v / tot)}'ini oluşturuyor. Oransal olarak en kötü üç ilçe: ${worst.map(w => `${w.site} %${fmt(w.pct)}`).join(', ')} (kayıp / sisteme giren su). Hacim için Merkez, verimlilik için bu ilçeler öncelikli.`;
}

/* Seasonal analog forecast on the cleaned İSKİ series */
function renderForecast() {
  const s = state.results.find(r => r.series[0]?.src.id === 'iski')?.series.find(x => x.m.v === 'reservoir_fill_pct'); if (!s) return;
  const byDay = new Map(); s.recs.forEach(r => { if (r.value != null) byDay.set(Math.round((r.ts + 3 * HOUR) / DAY), r.value); }); // dedupe: last wins
  const d0 = Math.min(...byDay.keys()), d1 = Math.max(...byDay.keys()); const y = []; let est = 0;
  for (let d = d0; d <= d1; d++) { if (byDay.has(d)) y.push(byDay.get(d)); else { y.push(null); est++; } }
  for (let k = 0; k < y.length; k++) if (y[k] == null) { let a = k - 1, b = k + 1; while (y[b] == null) b++; y[k] = y[a] + (y[b] - y[a]) * (k - a) / (b - a); }
  const T = y.length - 1, H = 180, fc = [], lo = [], hi = [];
  for (let h = 1; h <= H; h++) {
    const deltas = []; for (let k = 1; T - 365 * k + h >= 0 && T - 365 * k >= 0; k++) { const i = T - 365 * k; if (i + h <= T) deltas.push(y[i + h] - y[i]); }
    const mu = deltas.reduce((a, b) => a + b, 0) / deltas.length, sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mu) ** 2, 0) / deltas.length);
    fc.push(Math.min(100, Math.max(0, y[T] + mu))); lo.push(Math.max(0, y[T] + mu - 1.28 * sd)); hi.push(Math.min(100, y[T] + mu + 1.28 * sd));
  }
  const hist = 730, lab = []; for (let k = T - hist; k <= T + H; k++) lab.push(new Date((d0 + k) * DAY).toISOString().slice(0, 10));
  const pad = Array(hist).fill(null);
  chart('cFc', { type: 'line', data: { labels: lab, datasets: [
    { label: 'Gözlem (temizlenmiş)', data: [...y.slice(T - hist), ...Array(H).fill(null)], borderColor: '#1E40AF', pointRadius: 0, borderWidth: 1.5 },
    { label: 'Tahmin', data: [...pad, y[T], ...fc], borderColor: '#D97706', pointRadius: 0, borderDash: [5, 4], borderWidth: 2 },
    { label: '%80 alt', data: [...pad, y[T], ...lo], borderColor: 'transparent', pointRadius: 0, fill: false },
    { label: '%80 aralık', data: [...pad, y[T], ...hi], borderColor: 'transparent', backgroundColor: 'rgba(217,119,6,.14)', pointRadius: 0, fill: '-1' }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { filter: i => i.text !== '%80 alt' } } }, scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } } } });
  $('#fcNote').textContent = `Hattan geçen ${fmt(y.length)} günlük seride ${est} eksik gün doğrusal ara değerle “tahmini” bayrağıyla dolduruldu, tekrarlı günlerde son kayıt tutuldu. Son gözlem ${lab[hist]}: %${fmt(y[T], 1)}; 180 gün sonrası beklenen %${fmt(fc[H - 1], 1)} (aralık %${fmt(lo[H - 1], 0)}–${fmt(hi[H - 1], 0)}). Kaynak 2021’de güncellenmeyi bıraktığı için tahmin de o tarihten başlar; bu, hattın işaretlediği “güncel olmayan veri” bulgusunun pratik sonucudur.`;
}

function renderLca() {
  const s = state.results.find(r => r.series[0]?.src.id === 'izsu_loss')?.series.find(x => x.m.v === 'physical_loss'); if (!s) return;
  const loss = s.recs.reduce((a, r) => a + (r.value || 0), 0), ei = +$('#ei').value, ef = +$('#ef').value;
  countUp($('#kLoss'), loss / 1e6, 1, ' M'); countUp($('#kMwh'), loss * ei / 1000); countUp($('#kCo2'), loss * ei * ef / 1000);
}
$('#ei').oninput = $('#ef').oninput = renderLca;

/* ---------- Burble asistanı (demo modu) ----------
   Yanıtlar ağ çağrısı yapmadan, bu sayfada çalışan hattın gerçek sonuçlarından üretilir.
   Final sürümde aynı soru/yanıt sözleşmesi api/ask.js üzerinden canlı dil modeline bağlanacak. */
const TIER_TR = { auto: 'otomatik', suggest: 'öner', flag: 'işaretle' };
const ACTIONS = {
  'Birimsiz sinyal / şema eşleme': 'Önerilen eşlemeleri uzman onayına sun. Onaylanan eşleme kütüphaneye yazılır, aynı kolon bir daha sorulmaz.',
  'Saat dilimi belirsiz': 'Kaynağın saat dilimini işletmeden teyit et. Teyide kadar UTC varsayımı bayrakla taşınır.',
  'Donmuş sensör şüphesi': 'Sensörü bakım listesine ekle. Değerler silinmez, “şüpheli” bayrağıyla kalır.',
  'Zaman damgası yok': 'Yayıncıdan tarih alanı iste. O zamana kadar dosya zaman serisi analizine alınmaz.',
  'Tekrarlı zaman damgası': 'Tekrarlarda son kaydı tutma önerisini onayla.',
  'Veri boşluğu (iletişim kesintisi)': 'Boşluklar “eksik” olarak işaretlendi, değer uydurulmadı. İletişim hattı kontrol edilmeli.',
  'Güncel olmayan veri': 'Kaynağın güncel sürümünü iste. Tahminler son kayıt tarihinden başlar.',
  'Kopya / yanlış etiketli kolon': 'Yayıncıya kolon tanımını sor. Netleşene kadar bu kolon analizde kullanılmaz.',
  'Fiziksel tutarsızlık': 'Değeri tasarım sınırlarıyla karşılaştır; netleşene kadar şüpheli kalır.',
  'Belirsiz sayı biçimi': 'Su dengesiyle doğrulanan okumayı onayla.',
  'Su denge tablosu tutmuyor': 'Farkı yayıncıyla mutabık kıl. Denge dışı ilçeler kayıp analizinde ayrı gösterilir.',
  'Birim kayması (≈×1000)': '÷1000 düzeltmesini onaya sun; ham değer korunur.',
  'Hata kodu (−999) değer sanılmış': 'Otomatik olarak “eksik” bayrağına çevrildi, ek işlem gerekmez.',
  'Aykırı değer (saatlik profil)': 'Saha gözlemiyle karşılaştır; doğrulanana kadar şüpheli kalır.',
  'Zaman kayması / geri sıçrama': 'Cihaz saatini ve yaz saati ayarını kontrol et.',
  'Belirsiz kolon anlamı': 'Kolonun ne ölçtüğünü yayıncıdan teyit et.',
  'Şemada karşılığı yok': 'Kolonu şemaya eşle ya da kapsam dışı olarak işaretle.',
};
const MAINT = ['Donmuş sensör şüphesi', 'Aykırı değer (saatlik profil)', 'Birim kayması (≈×1000)', 'Zaman kayması / geri sıçrama', 'Veri boşluğu (iletişim kesintisi)', 'Fiziksel tutarsızlık', 'Hata kodu (−999) değer sanılmış'];
const GUESS = [[/debi|flow|q_?in|q_?out/i, 'flow_rate'], [/bas[ıi]n[çc]|press/i, 'pressure'], [/seviye|level/i, 'tank_level'], [/s[ıi]cakl|temp/i, 'temperature'], [/^ph$/i, 'ph'], [/klor|chlor|cl2?/i, 'chlorine'], [/bulan|turb|ntu/i, 'turbidity'], [/iletken|cond/i, 'conductivity'], [/enerji|kwh|energy/i, 'energy']];

const answers = {
  map() {
    const items = state.issues.filter(i => i.key?.startsWith('map:') || i.unmapped);
    if (!items.length) return 'Onay bekleyen kolon eşlemesi yok. Tüm kolonlar kütüphanedeki onaylı eşlemelerle geçti.';
    const out = items.slice(0, 10).map(i => {
      if (i.unmapped) { const g = GUESS.find(([re]) => re.test(i.signal)); return g ? `${i.signal} → ${g[1]} [${SCHEMA[g[1]]}]  güven %55\n   kanıt: kolon adı “${g[1]}” ile örtüşüyor; birim dosyada yok, uzman teyidi gerekli` : `${i.signal} → UNMAPPED\n   kanıt: kolon adı ve örnek değerler şemadaki hiçbir alanla örtüşmüyor; uydurma eşleme yapılmadı`; }
      const r = state.results.find(x => x.issues.includes(i)), m = r?.maps.find(x => x.col === i.signal);
      return `${i.signal} → ${m?.v} [${SCHEMA[m?.v]}]  güven %${fmt(i.conf * 100)}\n   kanıt: ${(m?.ev || '').replace(/^Dosyada birim yok\. /, '')}`;
    });
    return `${items.length} kolon için eşleme önerisi (yalnızca şemadaki ${Object.keys(SCHEMA).length} alandan seçildi):\n\n${out.join('\n\n')}${items.length > 10 ? `\n\n… ve ${items.length - 10} kolon daha.` : ''}\n\nÖnerileri “Bulgular” tablosundaki Onayla düğmesiyle kütüphaneye yazabilirsin.`;
  },
  priority() {
    const agg = {}; state.issues.filter(i => !i.info).forEach(i => agg[i.type] = (agg[i.type] || 0) + i.n);
    const e = Object.entries(agg).sort((a, b) => b[1] - a[1]), tot = e.reduce((a, x) => a + x[1], 0); let c = 0;
    const top = e.slice(0, 3).map(([t, n], k) => { c += n; return `${k + 1}. ${t}: ${fmt(n)} kayıt (kümülatif %${fmt(100 * c / tot, 1)})\n   aksiyon: ${ACTIONS[t] || 'Kanıtı incele ve karar ver.'}`; });
    return `Pareto'ya göre ilk üç sorun, etkilenen ${fmt(tot)} kaydın %${fmt(100 * c / tot, 1)}'ini oluşturuyor:\n\n${top.join('\n\n')}\n\nGeri kalan ${e.length - 3} sorun tipi toplam kaydın %${fmt(100 - 100 * c / tot, 1)}'i; bunlar ikinci turda ele alınabilir.`;
  },
  maint() {
    const m = state.issues.filter(i => MAINT.includes(i.type) && (i.srcId === 'battledim' || i.srcId.startsWith('upload')));
    if (!m.length) return 'Bu çalıştırmada sensör veya iletişim kaynaklı bakım uyarısı yok.\nNot: gerçek veride sensör arızası bulgusu zayıf; “Sentetik arıza ekle” kutusunu açıp hattı yeniden çalıştırarak uyarıların nasıl oluştuğunu görebilirsin.';
    return `Bakım ekibine gidecek ${m.length} uyarı:\n\n` + m.map(i => `• [${TIER_TR[i.tier]}] ${i.source} · ${i.signal}\n  ${i.type}, ${fmt(i.n)} kayıt. ${ACTIONS[i.type] || ''}`).join('\n\n') + ($('#inject').checked ? '\n\nNot: Stres testi açık; bu uyarıların bir kısmı sentetik olarak eklenen arızalardan geliyor.' : '');
  },
  ready() {
    const lines = state.results.map(r => {
      const src = r.series[0]?.src || SOURCES.find(s => r.issues[0]?.srcId === s.id); if (!src) return null;
      const recs = r.series.flatMap(s => s.recs), good = recs.filter(x => x.flag === 'good').length;
      const open = r.issues.filter(i => i.tier === 'suggest' && !(i.key && lib[i.key])).length, flags = r.issues.filter(i => i.tier === 'flag').length;
      const noTime = r.issues.some(i => i.type === 'Zaman damgası yok');
      const verdict = noTime ? 'hazır değil (zaman damgası yok)' : open ? `koşullu: ${open} öneri onay bekliyor` : flags ? `kullanılabilir, ${flags} işaret not edilmeli` : 'hazır';
      return `• ${src.label}: kayıtların %${fmt(100 * good / Math.max(1, recs.length), 1)}'i “iyi” → ${verdict}`;
    }).filter(Boolean);
    return `Kaynak bazında modele hazırlık:\n\n${lines.join('\n')}\n\nKural: onay bekleyen öneri varken veri modele “onaylı” etiketiyle verilmez; işaretli kayıtlar bayraklarıyla birlikte geçer, model bunları dışlayabilir.`;
  },
};
let typing;
function say(q, text) {
  clearInterval(typing);
  const out = $('#aiOut'), head = `▸ ${q}\n\n`;
  if (RM) { out.textContent = head + text; return; }
  out.textContent = head + 'Burble asistanı bulguları okuyor…';
  setTimeout(() => {
    let k = 0; out.textContent = head;
    typing = setInterval(() => { k = Math.min(text.length, k + 6); out.textContent = head + text.slice(0, k); out.scrollTop = out.scrollHeight; if (k >= text.length) clearInterval(typing); }, 16);
  }, 650);
}
document.querySelector('.qs').addEventListener('click', e => {
  const b = e.target.closest('.q'); if (!b || b.disabled) return;
  document.querySelectorAll('.q').forEach(x => x.classList.toggle('on', x === b));
  say(b.textContent, answers[b.dataset.q]());
});

/* ---------- Upload ---------- */
$('#upload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const id = 'upload_' + state.uploads.length;
  state.raw[id] = await f.text();
  state.uploads.push({ id, label: f.name, org: 'Senin dosyan', tz: 3, site: f.name.replace(/\.\w+$/, ''), unitInfo: 'Hat tespit edecek', timeInfo: 'Hat tespit edecek' });
  renderSources(); log(`+ ${f.name} eklendi. Hattı yeniden çalıştır.`);
};

/* ---------- Hero oscilloscope: real p227 trace, flags in amber ---------- */
let scopeT = 0, scopeRAF;
function drawScope() {
  const cv = $('#scope'), ctx = cv.getContext('2d'); const ing = ingest(state.raw.battledim || ''); if (!ing.rows.length) return;
  const s = state.results.find(r => r.series[0]?.src.id === 'battledim')?.series[0];
  const vals = s ? s.recs.map(r => r.value ?? NaN) : ing.rows.map(r => num(r[1], ing).v);
  const flagged = new Set();
  s?.recs.forEach((r, k) => { if (r.flag !== 'good') flagged.add(k); });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  cancelAnimationFrame(scopeRAF);
  const frame = () => {
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const N = 576, off = Math.floor(scopeT) % (vals.length - N), seg = vals.slice(off, off + N);
    const mx = 210, y0 = h * .08, yh = h * .84;
    ctx.lineWidth = 1.6 * devicePixelRatio; ctx.strokeStyle = '#3B82F6'; ctx.beginPath();
    seg.forEach((v, i) => { const x = i / (N - 1) * w, y = y0 + yh * (1 - Math.min(v, mx) / mx); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.fillStyle = '#F59E0B';
    seg.forEach((v, i) => { if (flagged.has(off + i)) { ctx.beginPath(); ctx.arc(i / (N - 1) * w, y0 + yh * (1 - Math.min(v, mx) / mx), 3 * devicePixelRatio, 0, 7); ctx.fill(); } });
    scopeT += .6; if (!reduce && !document.hidden) scopeRAF = requestAnimationFrame(frame);
  };
  frame();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) drawScope(); });
function renderRaw() {
  const box = $('#rawList'); box.innerHTML = '';
  for (const s of SOURCES) {
    const lines = (state.raw[s.id] || '').split(/\r?\n/).filter(Boolean);
    const body = [lines[0], ...(s.pick ? [lines.find(l => s.pick.test(l))] : lines.slice(1, 3))].filter(Boolean)
      .map(l => { l = l.replace(/^﻿/, '‹BOM›'); return l.length > 118 ? l.slice(0, 118) + '…' : l; })
      .map(l => `<span class="ln">${esc(l).replace(s.hl || /$^/, m => `<mark style="--d:${mk++}">${m}</mark>`)}</span>`).join('');
    box.insertAdjacentHTML('beforeend', `<div class="rawfile"><div class="fn"><span>${esc(s.file.split('/').pop())}</span><em>${esc(s.note || '')}</em></div><pre>${body}</pre></div>`);
  }
}
let mk = 0;
/* count-up for numbers; respects reduced motion */
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
function countUp(el, to, dec = 0, suffix = '') {
  if (RM || !Number.isFinite(to)) { el.textContent = fmt(to, dec) + suffix; return; }
  const from = parseFloat((el.dataset.v || '0')), t0 = performance.now(), dur = 900; el.dataset.v = to;
  const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e, dec) + suffix; if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const stagger = tb => [...tb.children].forEach((tr, i) => tr.style.setProperty('--i', Math.min(i, 24)));
function renderHeroStats() {
  countUp($('#hRec'), state.records.length); countUp($('#hIss'), state.issues.length); $('#insState').textContent = 'hat tamamlandı';
  const rows = state.results.reduce((a, r) => a + r.ing.rows.length, 0);
  const agg = {}; state.issues.forEach(i => agg[i.type] = (agg[i.type] || 0) + i.n);
  const kb = new Blob([JSON.stringify({ pareto: Object.entries(agg), issues: state.issues.slice(0, 25).map(({ recRef, samples, ...i }) => i) })]).size / 1024;
  $('#fRows').textContent = fmt(rows); $('#fIss').textContent = state.issues.length; $('#fKb').textContent = fmt(kb, 1);
}
document.querySelector('.chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return; filter = c.dataset.f;
  document.querySelectorAll('.chip').forEach(x => { x.classList.toggle('on', x === c); x.setAttribute('aria-pressed', x === c); });
  renderIssues();
});
$('#run').onclick = run;
loadAll();
