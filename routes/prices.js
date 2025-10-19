// routes/prices.js — resilient free tier (CoinGecko + Binance + stale cache)
// Response shapes preserved.
//price.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

const SUPPORTED_COINS = ["BTC", "ETH", "USDT", "SOL", "XRP", "TON"];

// Symbol -> CoinGecko ID
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  SOL: "solana",
  XRP: "ripple",
  TON: "toncoin",
  BNB: "binancecoin",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  MATIC: "matic-network",
};

function normalizeSymbol(input) {
  if (!input) return "";
  let s = String(input).trim().toUpperCase().replace(/\s+/g, "");

  // split composite pairs like "TON/USDT" or "eth-usd"
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes("-")) s = s.split("-")[0];

  // only strip the suffix if there's something BEFORE it
  if (s !== "USDT" && s.endsWith("USDT")) s = s.slice(0, -4);
  if (s !== "USD"  && s.endsWith("USD"))  s = s.slice(0, -3);

  return s;
}

/** ---------------- In‑memory caches ---------------- */
let cacheList = { t: 0, data: [], prices: {} }; // for GET /prices
const LIST_REFRESH_MS = 10_000;                 // normal freshness window
const LIST_STALE_OK_MS = 5 * 60_000;            // up to 5 min we’ll still serve stale instead of empty

// per‑symbol cache for GET /prices/:symbol
const symbolCache = {}; // { BTC: { t: ms, price: number }, ... }
const SYMBOL_STALE_OK_MS = 5 * 60_000;

/* -------------------- CHART -------------------- */
router.get("/chart/btcusdt", async (_req, res) => {
  try {
    const url = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=192";
    const { data } = await axios.get(url, { timeout: 8000 });
    const candles = data.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));
    res.json({ candles });
  } catch {
    res.json({ candles: [] });
  }
});

/* -------------------- LIST -------------------- */
router.get("/", async (_req, res) => {
  const now = Date.now();

  // serve hot cache
  if (now - cacheList.t < LIST_REFRESH_MS && cacheList.data.length) {
    return res.json({ data: cacheList.data, prices: cacheList.prices });
  }

  try {
    const perPage = 50;
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=24h`;

    const { data: items } = await axios.get(url, { timeout: 8000 });

    const data = items.map((c) => ({
      id: c.id,
      name: c.name,
      symbol: (c.symbol || "").toUpperCase(),
      quote: {
        USD: {
          price: Number(c.current_price),
          percent_change_24h: Number(c.price_change_percentage_24h ?? 0),
          volume_24h: Number(c.total_volume ?? 0),
          market_cap: Number(c.market_cap ?? 0),
        },
      },
    }));

    const prices = {};
    data.forEach((c) => (prices[c.symbol] = c.quote.USD.price));

    // update caches
    cacheList = { t: now, data, prices };
    Object.entries(prices).forEach(([sym, price]) => {
      symbolCache[sym] = { t: now, price };
    });

    return res.json({ data, prices });
  } catch {
    // On failure, prefer returning stale cache (realistic UX) rather than empty data.
    if (cacheList.data.length && now - cacheList.t <= LIST_STALE_OK_MS) {
      return res.json({ data: cacheList.data, prices: cacheList.prices, stale: true });
    }
    // Optional: allow static fallback if explicitly enabled
    const allowStatic = process.env.ALLOW_STATIC_FALLBACK === "1";
    if (allowStatic) {
      const STATIC_PRICES = { BTC: 107719.98, ETH: 4555.07, SOL: 143.66, XRP: 3, TON: 3.34, USDT: 1 };
      const prices = {};
      SUPPORTED_COINS.forEach((s) => (prices[s] = STATIC_PRICES[s]));
      return res.json({ data: [], prices, fallback: "static" });
    }
    return res.status(503).json({ data: [], prices: {}, error: "LIVE_PRICE_UNAVAILABLE" });
  }
});

/* -------------------- SINGLE -------------------- */
router.get("/:symbol", async (req, res) => {
  const raw = req.params.symbol;
  const symbol = normalizeSymbol(raw);
  const allowStatic = process.env.ALLOW_STATIC_FALLBACK === "1";
  const now = Date.now();

  // If we have a very recent symbol price, serve it immediately.
  if (symbolCache[symbol] && now - symbolCache[symbol].t < LIST_REFRESH_MS) {
    return res.json({ symbol, price: symbolCache[symbol].price });
  }

  // 1) CoinGecko primary
  try {
    const idsToTry =
      symbol === "TON"
        ? ["toncoin", "the-open-network"]
        : [CG_ID[symbol]].filter(Boolean);

    for (const id of idsToTry) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
      const { data } = await axios.get(url, { timeout: 5000 });
      const price = Number(data?.[id]?.usd);
      if (isFinite(price) && price > 0) {
        symbolCache[symbol] = { t: now, price };
        return res.json({ symbol, price });
      }
    }
  } catch {}

  // 2) Binance fallback
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const price = Number(data?.price);
    if (isFinite(price) && price > 0) {
      symbolCache[symbol] = { t: now, price };
      return res.json({ symbol, price });
    }
  } catch {}

  // 3) Coinbase fallback
  try {
    const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`;
    const { data } = await axios.get(url, { timeout: 5000, headers: { "CB-VERSION": "2023-01-01" } });
    const price = Number(data?.data?.amount);
    if (isFinite(price) && price > 0) {
      symbolCache[symbol] = { t: now, price };
      return res.json({ symbol, price });
    }
  } catch {}

  // 4) Stale cache if we have it (up to 5 min)
  if (symbolCache[symbol] && now - symbolCache[symbol].t <= SYMBOL_STALE_OK_MS) {
    return res.json({ symbol, price: symbolCache[symbol].price, stale: true });
  }
  if (cacheList.prices[symbol]) {
    return res.json({ symbol, price: cacheList.prices[symbol], stale: true });
  }

  // 5) Optional static fallback
  if (allowStatic) {
    const STATIC_PRICES = { BTC: 107419.98, ETH: 2453.07, SOL: 143.66, XRP: 0.6, TON: 7.0, USDT: 1 };
    if (STATIC_PRICES[symbol]) return res.json({ symbol, price: STATIC_PRICES[symbol] });
  }

  return res.status(503).json({ error: "LIVE_PRICE_UNAVAILABLE" });
});

module.exports = router;
