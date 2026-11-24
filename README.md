# BURBLE · Su konuşur, Burble dinler

Dağınık su altyapısı verisini (SCADA, baraj, üretim, kayıp-kaçak) tek bir şemaya oturtan, her değere kalite bayrağı ve güven skoru ekleyen, uzman onayıyla öğrenen veri güvenilirlik katmanının ön eleme demosu.

## Sunum modu
Site sunum ve canlı demoyu tek akışta taşır (13 bölüm, sunumdaki sırayla). Sunarken `→` / `PgDn` (ya da sunum kumandası) sonraki bölüme, `←` / `PgUp` öncekine geçer; uzun bölümler önce kendi içinde kaydırılır. Sağ alttaki kontrol aynı işi fareyle yapar. "Nasıl çalışır" bölümüne gelindiğinde hat gerçek veri üzerinde baştan çalışır.

## Ne yapıyor
1. **Veri alımı:** ayraç, ondalık biçimi ve BOM'u otomatik algılar. Ham dosyalar `data/` içinde, indirildiği haliyle durur.
2. **Kalite analizi:** boşluk, tekrarlı/geri giden zaman damgası, donmuş sensör, pompa kapalı ayrımı, −999 hata kodu, birim kayması, saatlik profile göre aykırı değer, fiziksel tutarlılık, IWA su dengesi, güncel olmayan kaynak.
3. **Standardizasyon:** `ts_utc, source, site, variable, value, unit, quality_flag, state, confidence, raw_ref`.
4. **Karar kuralı:** Otomatik uygula / Öner ve onaylat / Yalnızca işaretle.
5. **Uzman onayı:** “Onayla” kararı tarayıcıdaki kütüphaneye yazılır, hat yeniden çalışır, benzer sinyal artık otomatik geçer.
6. **Çıktı:** standart CSV + JSON kalite raporu, Pareto, 180 günlük tahmin, kayıp suyun enerji/CO₂e karşılığı, Gemini ile şema eşleme ve rapor yorumu.

## Veri kaynakları
| Dosya | Kaynak | Lisans |
|---|---|---|
| `battledim_2019_01_scada_flows.csv` | BattLeDIM L-Town, Ocak 2019, 5 dk SCADA debi ([Zenodo 10.5281/zenodo.4017659](https://doi.org/10.5281/zenodo.4017659)) | CC BY 4.0 |
| `ibb_baraj_doluluk_2005_2021.csv` | [İBB Açık Veri, İSKİ baraj doluluk](https://data.ibb.gov.tr/dataset/istanbul-dam-occupany-rates-data) | İBB Açık Veri Lisansı |
| `izsu_baraj_doluluk.csv`, `izsu_gunluk_uretim.csv`, `izsu_su_kayiplari_2019.csv` | [İzmir BB Açık Veri, İZSU](https://acikveri.bizizmir.com) | İzmir BB Açık Veri Lisansı |

Stres testi kutusu açıkken BattLeDIM verisine eklenen arızalar sentetiktir ve ekranda öyle etiketlenir.

## Yerelde çalıştırma
```bash
python -m http.server 4400      # http://127.0.0.1:4400  (Gemini /api yerelde yok)
npx vercel dev                   # /api/ask dahil, .env.local içinde GEMINI_API_KEY
```

## Canlıya alma (Vercel)
1. Repoyu GitHub'a gönder, vercel.com → **Add New Project** → repoyu seç. Framework: **Other**, build komutu yok.
2. **Settings → Environment Variables:** `GEMINI_API_KEY` (Google AI Studio'dan). İsteğe bağlı `GEMINI_MODEL` (varsayılan `gemini-2.5-flash`).
3. Deploy. Anahtar yalnızca sunucu fonksiyonunda (`api/ask.js`) kullanılır, tarayıcıya gitmez.

Concordia · Ali Talha Gezgin, Arda Özgür, Mert Giray Yalçın, Süleyman Yiğit Demircan
