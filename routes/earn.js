//routes>earn.js

const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const { authenticateToken } = require('../middleware/auth');

// ---
// GET /api/earn/stakes
// Fetches the user's ACTIVE stakes to show on the card
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
    
    // Calculate days left for display purposes
    const stakesWithTime = rows.map(stake => {
      const now = new Date();
      const end = new Date(stake.end_date);
      const diffTime = Math.abs(end - now);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      return {
        ...stake,
        days_left: diffDays > 0 ? diffDays : 0
      };
    });

    res.json(stakesWithTime);
  } catch (error) {
    console.error("Error fetching stakes:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/stake
// Locks funds from Main Wallet -> Creates a Stake Record
// ---
router.post('/stake', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // Frontend sends: { coin, amount, duration_days, daily_rate }
  const { coin, amount, duration_days, daily_rate } = req.body;
  const stakeAmount = parseFloat(amount);

  if (!coin || isNaN(stakeAmount) || stakeAmount <= 0 || !duration_days) {
    return res.status(400).json({ success: false, error: "Invalid staking details." });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check Main Wallet Balance (user_balances)
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);

    if (currentBalance < stakeAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Insufficient ${coin} balance.` });
    }

    // 2. Deduct from Main Wallet
    await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [stakeAmount, userId, coin]
    );

    // 3. Create Stake Record
    // We calculate end_date by adding duration_days to NOW()
    const insertQuery = `
      INSERT INTO stakes (user_id, coin, amount, daily_rate, duration_days, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + make_interval(days => $5), 'ACTIVE')
      RETURNING *
    `;
    
    await client.query(insertQuery, [userId, coin, stakeAmount, daily_rate, duration_days]);

    // 4. Commit Transaction
    await client.query('COMMIT');
    res.json({ success: true, message: "Staked successfully" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in staking transaction:", error);
    res.status(500).json({ success: false, error: "Staking failed. Please try again." });
  } finally {
    client.release();
  }
});

module.exports = router;