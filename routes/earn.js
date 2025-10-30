//routes>earn.js

const express = require('express');
const router = express.Router();
const pool = require('../db'); // Use 'pool' to match your balance.js
const { authenticateToken } = require('../middleware/auth'); // Use 'authenticateToken' to match your balance.js

// ---
// GET /api/earn/balance
// Fetches the user's savings wallet balances
// ---
router.get('/balance', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      // We use 'symbol' as an alias for 'coin' to match the frontend's expected data structure
      "SELECT coin as symbol, balance FROM earn_wallet WHERE user_id = $1 AND balance > 0",
      [userId]
    );
    
    // The frontend expects { assets: [...] }
    res.json({ assets: rows });
  } catch (error) {
    console.error("Error fetching earn balance:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/deposit (Save)
// Moves funds from the main 'user_balances' wallet to the 'earn_wallet'
// ---
router.post('/deposit', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const depositAmount = parseFloat(amount);

  if (!coin || isNaN(depositAmount) || depositAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const client = await pool.connect(); // Get client from pool for transaction

  try {
    await client.query('BEGIN'); // Start PostgreSQL transaction

    // 1. Check if user has enough in their MAIN wallet (user_balances)
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);
    if (currentBalance < depositAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in main wallet." });
    }

    // 2. Subtract from MAIN wallet (user_balances)
    await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [depositAmount, userId, coin]
    );

    // 3. Add to EARN wallet (using PostgreSQL's ON CONFLICT)
    await client.query(
      `INSERT INTO earn_wallet (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = earn_wallet.balance + $3`,
      [userId, coin, depositAmount]
    );

    // 4. If all good, commit the transaction
    await client.query('COMMIT');
    res.json({ success: true });

  } catch (error) {
    await client.query('ROLLBACK'); // Roll back on any error
    console.error("Error in earn deposit transaction:", error);
    res.status(500).json({ success: false, error: "Transaction failed." });
  } finally {
    client.release(); // Always release the client back to the pool
  }
});

// ---
// POST /api/earn/withdraw (Redeem)
// Moves funds from the 'earn_wallet' back to the main 'user_balances' wallet
// ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const redeemAmount = parseFloat(amount);

  if (!coin || isNaN(redeemAmount) || redeemAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const client = await pool.connect(); // Get client for transaction

  try {
    await client.query('BEGIN');

    // 1. Check if user has enough in their EARN wallet
    const earnRes = await client.query(
      "SELECT balance FROM earn_wallet WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentEarnBalance = parseFloat(earnRes.rows[0]?.balance || 0);
    if (currentEarnBalance < redeemAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in savings." });
    }

    // 2. Subtract from EARN wallet
    await client.query(
      "UPDATE earn_wallet SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [redeemAmount, userId, coin]
    );

    // 3. Add to MAIN wallet (user_balances)
    // This assumes your user_balances table ALSO has a unique key on (user_id, coin)
    await client.query(
      `INSERT INTO user_balances (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, coin, redeemAmount]
    );

    // 4. If all good, commit the transaction
    await client.query('COMMIT');
    res.json({ success: true });

  } catch (error)
    {
    await client.query('ROLLBACK'); // Roll back on any error
    console.error("Error in earn withdraw transaction:", error);
    res.status(500).json({ success: false, error: "Transaction failed." });
  } finally {
    client.release(); // Always release the client
  }
});

module.exports = router;