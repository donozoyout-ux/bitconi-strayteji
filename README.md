# Dip Hunter Crypto Bot - Otomatik Algo-Trading

Bollinger Bands + Stoch RSI "Dip Avcisi" stratejisiyle calisan otomatik kripto ticaret botu. TradingView Webhook alarmlarini alir ve **Binance Testnet**'te (CCXT ile) market emirleri verir.

## Mimari / Akis

```
[TradingView Webhook Alert] --> [Render.com (Node.js / Express)] --> [Binance Testnet API (CCXT)]
```

## Dosya Yapisi

```
BİTCOİN ALİM/
├── package.json
├── .env.example          # (.env gizlidir, .gitignore'da)
├── .gitignore
├── server.js             # Giris noktasi (npm start)
├── logs/app.log          # Calisma zaman loglari (otomatik olusur)
├── strategies/
│   └── dip-hunter-btc.pine   # TradingView Pine Script v5
└── src/
    ├── app.js                    # Express app + middleware
    ├── config/env.js             # Ortam degiskenleri
    ├── config/binance.js         # ccxt.binance + sandboxMode(true)
    ├── routes/webhook.routes.js  # POST /webhook
    ├── controllers/webhook.controller.js
    ├── services/order.service.js # BUY/SELL market emirleri
    └── utils/logger.js           # Konsol + logs/app.log
```

## Endpoint

- `POST /webhook` — gelen JSON ornegi:
  ```json
  { "action": "BUY", "symbol": "BTCUSDT", "budget": "30" }
  ```
- `GET /health` — Render health check ve canli kontrol.

## Yerel Kurulum

```bash
npm install
copy .env.example .env      # Windows (Linux/Mac: cp .env.example .env)
# .env dosyasini doldurun (Testnet anahtarlari: https://testnet.binance.vision/)
npm run dev                 # gelistirme (nodemon)
npm start                   # uretim
```

Dogrulama:
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d "{\"action\":\"BUY\",\"symbol\":\"BTCUSDT\",\"budget\":\"30\"}"
```

## TradingView Kurulumu

1. `strategies/dip-hunter-btc.pine` dosyasini Pine Editor'e yapistirin ve "Chart'a Ekle" deyin. Strateji 4H ve 1D grafiklerde calisir (grafik periyodunu secin).
2. Girdilerden `Take Profit (%)` (varsayilan 5.0), `Stop Loss (%)` (varsayilan 2.5), `Islem Sembolu`, `Emir Miktari` degerlerini ayarlayin.
3. Backtest: Bu bir `strategy()` scripti oldugundan TradingView alt panelindeki **"Strateji Test Cihazi"** (Strategy Tester) sekmesinde kâr/zarar, kazanma orani ve islem listesi otomatik gorunur.
4. Sag tiklama -> "Alarm Olustur":
   - **Alarm:** "BUY Sinyali"
   - **Sart:** Her
   - **Yontem:** "Webhook URL" -> Render sunucu adresi: `https://SENIN-APP.onrender.com/webhook`
   - **Message:** otomatik gonderilir (Pine'ta `alert()` ile JSON uretilir)

## Git + Render Deployment

### 1) GitHub'a aktarma

```bash
git init
git add .
git commit -m "Dip Hunter crypto bot ilk surum"
git branch -M main
git remote add origin https://github.com/KULLANICI-ADI/REPO-ADI.git
git push -u origin main
```

> `.gitignore` sayesinde `.env`, `node_modules/` ve `logs/` repoya gitmez. Sifreleriniz guvende.

### 2) Render.com'a deploy

1. [render.com](https://render.com) -> **New** -> **Web Service** -> GitHub repo'nuzu baglayin.
2. **Runtime:** Node; **Build Command:** `npm install`; **Start Command:** `node server.js`.
3. **Environment** bolumune su degiskenleri ekleyin:
   | Anahtar | Deger |
   |---|---|
   | `PORT` | `3000` |
   | `BINANCE_TESTNET_API_KEY` | Testnet API anahtariniz |
   | `BINANCE_TESTNET_SECRET_KEY` | Testnet gizli anahtariniz |
   | `TELEGRAM_BOT_TOKEN` | (opsiyonel) Telegram bot token |
   | `TELEGRAM_CHAT_ID` | (opsiyonel) Telegram chat id |
   | `COMMISSION_RATE` | `0.001` (komisyon %0.1) |
   | `TRADING_MODE` | `on` |
   | `DRY_RUN` | `true` (sanal) / `false` (gercek testnet emri) |
   | `ANALYSIS_TIMEFRAME` | `1d` |
   | `CHECK_INTERVAL_MIN` | `15` |
   | `BUDGET_USDT` | `30` |
   | `TP_PERCENT` | `5` |
   | `SL_PERCENT` | `2.5` |
   | `COOLDOWN_MIN` | `1440` |
   | `TRADING_SYMBOL` | `BTC/USDT` |
4. **Deploy** butonu. Yesil "Live" durumunu bekleyin.
5. `https://SENIN-APP.onrender.com/health` acilirsa deploy basarili.

## Otonom Strateji Motoru (Analizli)

Bot sadece webhook beklemekle kalmaz, kendisi de analiz yapar:

- Her `CHECK_INTERVAL_MIN` dakikada bir Binance public API'sinden 1D mumlari ceker.
- **Bollinger(20,2) + Stoch RSI(14,3,3)** hesaplar (Pine Script stratejisiyle birebir ayni):
  - Alim: fiyat alt banda degiyor + Stoch RSI `%K` `%D`'yi 20 altinda yukari kesiyor.
  - Cikis: giris fiyatina gore `+TP_PERCENT` / `-SL_PERCENT` seviyesinde otomatik satis.
- `DRY_RUN=true` iken gercek emir ACMAZ, sadece simule eder (sanal bakiye). Dogru calistigini gorunce `DRY_RUN=false`.
- Pozisyon durumu `data/state.json`'da tutulur. **Dikkat:** Render ucretsiz tier'da bu dosya yeniden deploy'da sifirlanir; pozisyon acikken redeploy yapmayin.
- Panelden `GET /api/trader` (durum), `POST /api/trader/check` (simdi analiz), `POST /api/trader/reset` (sifirla) kullanilabilir.

### 3) Canli (Production) Uyarilari

- Render **ucretsiz tier** sunucuyu ~15 dakika islemsizlikte uyutur. Webhook geldiginde sunucu uyanana kadar emir gecikebilir. Gercek kullanim icin ucretli plan ($7/ay) onerilir.
- Testnet (sanal para) ile baslayin; canli Binance hesabi icin `setSandboxMode(false)` yapip gercek API anahtarlari girmeniz gerekir (sorumluluk size ait).
- Ticaret sinyalleri "BUY" odaklidir; `SELL` emri sunucu tarafinda desteklenir ancak Pine'ta yalnizca alim sinyali uretilir.
