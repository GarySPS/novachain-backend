// routes/prices.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// --- Config ---
const TWELVE_API_KEY = process.env.TWELVE_API_KEY; // Read Twelve Data key from .env

// --- Mappings ---
// Crypto Frontend API Symbol -> CoinGecko ID
const CG_ID = {
  bitcoin: "bitcoin",
  ethereum: "ethereum",
  tether: "tether", // Assuming frontend sends 'tether' if needed
  solana: "solana",
  ripple: "ripple",
  toncoin: "toncoin",
};

// Forex/Commodity Frontend API Symbol -> Twelve Data Symbol
const TWELVE_SYMBOL = {
  // Commodities
  xau: "XAU/USD",
  xag: "XAG/USD",
  wti: "CL=F", // Crude Oil Futures (Check if Twelve Data supports this ticker)
             // Alternatively: Use an Oil ETF like 'USO' or Spot price 'BRENT'/'WTI' if available
  natgas: "NG=F",// Natural Gas Futures (Check if Twelve Data supports this ticker)
             // Alternatively: Use an ETF like 'UNG'
  xcu: "HG=F", // Copper Futures (Check if Twelve Data supports this ticker)
             // Alternatively: Use an ETF like 'CPER'

  // Forex (Add more if needed)
  eurusd: "EUR/USD",
  gbpusd: "GBP/USD",
  usdjpy: "USD/JPY",
  audusd: "AUD/USD",
  // Add other forex pairs your frontend might request
};

// Helper to check if it's a known Forex/Commodity for Twelve Data
function isForexOrCommodity(apiSymbol) {
    return !!TWELVE_SYMBOL[apiSymbol?.toLowerCase()];
}
// Helper to check if it's a known Crypto for CoinGecko
function isCrypto(apiSymbol) {
    return !!CG_ID[apiSymbol?.toLowerCase()];
}


// --- Caches (Keep as is) ---
const symbolCache = {}; // Cache structure: { 'bitcoin': { t: ms, price, high_24h, ... }, 'xau': { ... } }
const LIST_REFRESH_MS = 10_000;
const SYMBOL_STALE_OK_MS = 5 * 60_000;

// --- Routes ---

/* GET /api/prices/:symbol - Handles Crypto, Forex, and Commodities */
router.get("/:symbol", async (req, res) => {
  const requestedApiSymbol = req.params.symbol.toLowerCase(); // e.g., 'bitcoin', 'xau', 'eurusd'
  const now = Date.now();

  console.log(`Received price request for: ${requestedApiSymbol}`);

  // --- Check Cache First ---
  if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t < LIST_REFRESH_MS) {
    console.log(`Serving cached data for ${requestedApiSymbol}`);
    return res.json({
      symbol: requestedApiSymbol,
      ...symbolCache[requestedApiSymbol],
      cached: true
    });
  }

  // --- Determine Asset Type and Fetch ---
  try {
    let priceData = null;

    // Check if it's Forex or Commodity first
    if (isForexOrCommodity(requestedApiSymbol)) {
        console.log(`Identified ${requestedApiSymbol} as Forex/Commodity.`);
        if (!TWELVE_API_KEY) throw new Error("Twelve Data API Key not configured");

        const twelveSymbol = TWELVE_SYMBOL[requestedApiSymbol];
        if (!twelveSymbol) throw new Error(`No Twelve Data symbol mapping for ${requestedApiSymbol}`);

        // --- Fetch from Twelve Data ---
        // 1. Get current price
        const priceUrl = `https://api.twelvedata.com/price?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
        console.log(`Fetching Twelve Data price for ${requestedApiSymbol} (${twelveSymbol}) from: ${priceUrl}`);
        const { data: priceResponse } = await axios.get(priceUrl, { timeout: 8000 });
        console.log(`Received Twelve Data price response:`, JSON.stringify(priceResponse));

        const currentPrice = Number(priceResponse?.price);
        if (!isFinite(currentPrice) || currentPrice <= 0) {
            throw new Error(`Invalid price received from Twelve Data price endpoint: ${priceResponse?.price}`);
        }

        // 2. Get 24h High/Low/Volume (using Time Series - might be limited on free plan)
        // Note: Free plan might only allow daily interval. This gives *yesterday's* high/low/vol.
        // For real-time 24h stats, a paid plan or different endpoint/API might be needed.
        let high_24h = null;
        let low_24h = null;
        let volume_24h = null;
        try {
            const tsUrl = `https://api.twelvedata.com/time_series?symbol=${twelveSymbol}&interval=1day&outputsize=1&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data time series for ${requestedApiSymbol} (${twelveSymbol}) from: ${tsUrl}`);
            const { data: tsResponse } = await axios.get(tsUrl, { timeout: 8000 });
            console.log(`Received Twelve Data time series response:`, JSON.stringify(tsResponse));

            if (tsResponse?.values && tsResponse.values.length > 0) {
                const latestDailyData = tsResponse.values[0];
                high_24h = Number(latestDailyData.high);
                low_24h = Number(latestDailyData.low);
                volume_24h = Number(latestDailyData.volume); // Volume might be for the day, not rolling 24h
            } else {
                 console.warn(`No time series data found for ${twelveSymbol} to get H/L/V.`);
            }
        } catch (tsError) {
             console.error(`Error fetching time series data for ${twelveSymbol}: ${tsError.message}. Proceeding without H/L/V.`);
             // Don't throw, just proceed without H/L/V if time series fails
        }


        priceData = {
            price: currentPrice,
            high_24h: isFinite(high_24h) ? high_24h : null,
            low_24h: isFinite(low_24h) ? low_24h : null,
            volume_24h: isFinite(volume_24h) ? volume_24h : null,
        };
        console.log(`Mapped Twelve Data priceData for ${requestedApiSymbol}:`, priceData);

    } else if (isCrypto(requestedApiSymbol)) {
        // --- Fetch Crypto Data using CoinGecko ---
        console.log(`Identified ${requestedApiSymbol} as Crypto.`);
        const coingeckoId = requestedApiSymbol; // Frontend sends the ID like 'bitcoin'
        const symbol = Object.keys(CG_ID).find(key => CG_ID[key] === coingeckoId) || coingeckoId.toUpperCase();

        const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coingeckoId}&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=24h`;
        console.log(`Fetching CoinGecko data for ${coingeckoId} from: ${cgUrl}`);
        const { data: cgDataArr } = await axios.get(cgUrl, { timeout: 8000 });
        console.log(`Received CoinGecko response for ${coingeckoId}:`, JSON.stringify(cgDataArr));

        if (!cgDataArr || cgDataArr.length === 0) throw new Error(`No market data found from CoinGecko for ${coingeckoId}`);
        const marketData = cgDataArr[0];

        priceData = {
            price: Number(marketData.current_price),
            high_24h: Number(marketData.high_24h),
            low_24h: Number(marketData.low_24h),
            volume_24h: Number(marketData.total_volume),
        };
        console.log(`Mapped CoinGecko priceData for ${coingeckoId}:`, priceData);

    } else {
        // --- Neither known Crypto nor Forex/Commodity ---
        throw new Error(`Unsupported symbol/id: ${requestedApiSymbol}`);
    }

    // --- Validate and Respond ---
    if (!priceData || !isFinite(priceData.price) || priceData.price <= 0) {
        throw new Error(`Invalid or zero price data processed for ${requestedApiSymbol}`);
    }

    // Update cache
    symbolCache[requestedApiSymbol] = { t: now, ...priceData };
    console.log(`Successfully processed data for ${requestedApiSymbol}, updating cache.`);

    return res.json({ symbol: requestedApiSymbol, ...priceData });

  } catch (err) {
    console.error(`ERROR processing ${requestedApiSymbol}:`, err.message);
    if (err.response) {
        console.error("Axios Response Error Data:", err.response.data);
        console.error("Axios Response Error Status:", err.response.status);
    } else if (err.request) {
        console.error("Axios Request Error:", err.request);
    }

    // --- Stale Cache Fallback ---
    if (symbolCache[requestedApiSymbol] && now - symbolCache[requestedApiSymbol].t <= SYMBOL_STALE_OK_MS) {
      console.warn(`Serving stale cache for ${requestedApiSymbol} due to error.`);
      return res.json({
        symbol: requestedApiSymbol,
        ...symbolCache[requestedApiSymbol],
        stale: true
      });
    }

    // --- Final Error ---
    console.error(`No live or stale data available for ${requestedApiSymbol}. Sending 503.`);
    return res.status(503).json({ error: "LIVE_DATA_UNAVAILABLE", symbol: requestedApiSymbol, detail: err.message });
  }
});


// --- Other routes (Chart, List) - Keep as they were if needed ---
// You might need to adjust or remove these if they are no longer used or accurate
router.get("/chart/btcusdt", async (_req, res) => { /* ... keep existing ... */ });
router.get("/", async (_req, res) => { /* ... keep existing ... */ });


module.exports = router;