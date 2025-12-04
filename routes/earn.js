//routes>earn.js

const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { authenticateToken } = require('../middleware/auth');

// ---
// GET /api/earn/stakes
// Fetches the user's ACTIVE stakes
// ---
router.get('/stakes', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM stakes 
       WHERE user_id = $1 AND status = 'ACTIVE' 
       ORDER BY created_at DESC`,
      [userId]
    );
    
    // Calculate if it's ready to redeem
    const stakesWithStatus = rows.map(stake => {
      const now = new Date();
      const end = new Date(stake.end_date);
      const isReady = now >= end; // If time has passed, they can redeem
      
      const diffTime = end - now;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

      return {
        ...stake,
        days_left: diffDays > 0 ? diffDays : 0,
        can_redeem: isReady
      };
    });

    res.json(stakesWithStatus);
  } catch (error) {
    console.error("Error fetching stakes:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/stake
// Locks funds
// ---
router.post('/stake', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount, duration_days, daily_rate } = req.body;
  const stakeAmount = parseFloat(amount);

  if (!coin || isNaN(stakeAmount) || stakeAmount <= 0 || !duration_days) {
    return res.status(400).json({ success: false, error: "Invalid staking details." });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check Balance
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );
    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);

    if (currentBalance < stakeAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Insufficient ${coin} balance.` });
    }

    // 2. Deduct Balance
    await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [stakeAmount, userId, coin]
    );

    // 3. Create Stake
    const insertQuery = `
      INSERT INTO stakes (user_id, coin, amount, daily_rate, duration_days, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + make_interval(days => $5), 'ACTIVE')
      RETURNING *
    `;
    await client.query(insertQuery, [userId, coin, stakeAmount, daily_rate, duration_days]);

    await client.query('COMMIT');
    res.json({ success: true, message: "Staked successfully" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error staking:", error);
    res.status(500).json({ success: false, error: "Staking failed." });
  } finally {
    client.release();
  }
});

// ---
// POST /api/earn/redeem
// Payout logic (Principal + Interest)
// ---
router.post('/redeem', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { stakeId } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get the stake
    const { rows } = await client.query(
      "SELECT * FROM stakes WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [stakeId, userId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: "Stake not found." });
    }
    const stake = rows[0];

    // 2. Checks
    if (stake.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Stake already redeemed." });
    }
    
    if (new Date() < new Date(stake.end_date)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Not ready to redeem yet." });
    }

    // 3. Calculate Profit
    // Formula: Amount * (DailyRate / 100) * Days
    const principal = parseFloat(stake.amount);
    const rate = parseFloat(stake.daily_rate);
    const days = parseInt(stake.duration_days);
    const profit = principal * (rate / 100) * days;
    const totalPayout = principal + profit;

    // 4. Pay User (Principal + Profit)
    await client.query(
      `INSERT INTO user_balances (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, stake.coin, totalPayout]
    );

    // 5. Mark as Redeemed
    await client.query(
      "UPDATE stakes SET status = 'REDEEMED' WHERE id = $1",
      [stakeId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Redeemed ${totalPayout.toFixed(4)} ${stake.coin}` });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Redeem error:", error);
    res.status(500).json({ success: false, error: "Redeem failed." });
  } finally {
    client.release();
  }
});

module.exports = router;