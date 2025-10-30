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
  xau: "XAU/USD",    // This one works
  xag: "XAG/USD",    // Standard spot symbol
  wti: "WTI/USD",    // Standard spot symbol (instead of CL=F)
  natgas: "NG/USD",    // Standard spot symbol (instead of NG=F)
  xcu: "XCU/USD",    // Standard spot symbol (instead of HG=F)

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


        // WITH THIS (around line 143):
        // 3. Get % Change (Requires another endpoint, e.g., Quote or Time Series with comparison)
        // NOTE: Twelve Data free plan might not provide real-time 24h % change easily.
        // We'll attempt using the 'quote' endpoint.
        let percent_change_24h = null;
        try {
            const quoteUrl = `https://api.twelvedata.com/quote?symbol=${twelveSymbol}&apikey=${TWELVE_API_KEY}`;
            console.log(`Fetching Twelve Data quote for % change for ${requestedApiSymbol} (${twelveSymbol}) from: ${quoteUrl}`);
            const { data: quoteResponse } = await axios.get(quoteUrl, { timeout: 8000 });
            console.log(`Received Twelve Data quote response:`, JSON.stringify(quoteResponse));
            // Adjust based on the actual field name in the quote response, common names are 'percent_change', 'change_percent'
            if (quoteResponse && isFinite(Number(quoteResponse.percent_change))) {
                 percent_change_24h = Number(quoteResponse.percent_change);
            } else {
                 console.warn(`Could not find valid percent_change in quote for ${twelveSymbol}.`);
            }
        } catch (quoteError) {
             console.error(`Error fetching quote data for ${twelveSymbol}: ${quoteError.message}. Proceeding without % change.`);
             // Don't throw, just proceed without % change if quote fails
        }


        priceData = {
            price: currentPrice,
            high_24h: isFinite(high_24h) ? high_24h : null,
            low_24h: isFinite(low_24h) ? low_24h : null,
            volume_24h: isFinite(volume_24h) ? volume_24h : null,
            percent_change_24h: isFinite(percent_change_24h) ? percent_change_24h : null, // <-- ADD THIS LINE
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
            percent_change_24h: Number(marketData.price_change_percentage_24h), // <-- ADD THIS LINE
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
// --- Add this back ---

// Cache for the full list
let listCache = { t: 0, data: [] };
const LIST_CACHE_DURATION = 10_000; // Cache the full list for 10 seconds

/* GET /api/prices - Fetches the list of top cryptocurrencies */
router.get("/", async (req, res) => {
  const now = Date.now();
  // Vercel Hobby plan might limit concurrent requests or timeout. Reduce limit?
  const limit = Math.min(parseInt(req.query.limit) || 100, 100); // Limit to 100 max

  console.log(`Received price list request with limit: ${limit}`);

  // --- Check List Cache ---
  if (listCache.data.length > 0 && now - listCache.t < LIST_CACHE_DURATION) {
    console.log(`Serving cached list data (first ${limit} items).`);
    return res.json({ data: listCache.data.slice(0, limit) });
  }

  // --- Fetch fresh list from CoinGecko ---
  try {
    const cgUrl = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false&price_change_percentage=24h`;
    console.log(`Fetching CoinGecko market list from: ${cgUrl}`);

    // Increased timeout for potentially slower Vercel Hobby plan network
    const { data: cgDataArr } = await axios.get(cgUrl, { timeout: 15000 });
    console.log(`Received CoinGecko market list response. Count: ${cgDataArr?.length}`);

    if (!cgDataArr || !Array.isArray(cgDataArr)) {
      throw new Error("Invalid data received from CoinGecko markets endpoint");
    }

    // --- Map CoinGecko data ---
    const formattedData = cgDataArr.map(coin => ({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol.toUpperCase(),
        cmc_rank: coin.market_cap_rank,
        quote: {
            USD: {
                price: coin.current_price,
                volume_24h: coin.total_volume,
                percent_change_24h: coin.price_change_percentage_24h, // Already included by CoinGecko
                market_cap: coin.market_cap,
            }
        },
    }));

    console.log(`Successfully formatted ${formattedData.length} coins.`);

    // Update list cache only if data is valid
    if (formattedData.length > 0) {
        listCache = { t: now, data: formattedData };
        console.log(`Updated list cache.`);
    }

    return res.json({ data: formattedData });

  } catch (err) {
    console.error("ERROR fetching CoinGecko market list:", err.message);
     if (err.response) {
       console.error("Axios Response Error Data:", err.response.data);
       console.error("Axios Response Error Status:", err.response.status);
     } else if (err.request) {
       // Log request details if available (might be large)
       console.error("Axios Request Error:", "Request made but no response received or network error.");
     }


    // --- Stale List Cache Fallback ---
    if (listCache.data.length > 0 && now - listCache.t <= SYMBOL_STALE_OK_MS) {
        console.warn(`Serving stale list cache due to error (first ${limit} items).`);
        return res.json({ data: listCache.data.slice(0, limit), stale: true });
    }

    // --- Final Error ---
    console.error(`No live or stale list data available. Sending 503.`);
    // Send a clearer error message
    return res.status(503).json({ error: "MARKET_DATA_UNAVAILABLE", message: "Could not fetch market list data.", detail: err.message });
  }
});
// --- End of list route ---


module.exports = router;