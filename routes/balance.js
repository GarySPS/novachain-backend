// routes/balance.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/balance (JWT-protected, returns all coins)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT coin, balance, frozen FROM user_balances WHERE user_id = $1",
      [req.user.id]
    );
    // Always show all coins (including 0 balance)
    const allCoins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    const assets = allCoins.map(symbol => {
      const row = rows.find(r => r.coin === symbol);
      return {
        symbol,
        balance: row ? parseFloat(row.balance) : 0,
        frozen: row ? parseFloat(row.frozen) : 0 // <-- ADD THIS LINE
      };
    });
    res.json({ assets });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
