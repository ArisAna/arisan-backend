const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

module.exports = function (pool) {
  // POST /api/migrate/game-tables
  router.post('/game-tables', authenticateToken, requireAdmin, async (req, res) => {
    try {
      // Add is_admin to users if not exists
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE
      `);

      // Questions table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS questions (
          id SERIAL PRIMARY KEY,
          question_text TEXT NOT NULL,
          correct_answer TEXT NOT NULL,
          category VARCHAR(100),
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Games table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS games (
          id SERIAL PRIMARY KEY,
          created_by INTEGER NOT NULL REFERENCES users(id),
          status VARCHAR(20) NOT NULL DEFAULT 'lobby',
          current_round INTEGER DEFAULT 0,
          total_rounds INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          started_at TIMESTAMP,
          finished_at TIMESTAMP
        )
      `);

      // Game players
      await pool.query(`
        CREATE TABLE IF NOT EXISTS game_players (
          id SERIAL PRIMARY KEY,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          turn_order INTEGER NOT NULL,
          score INTEGER DEFAULT 0,
          is_connected BOOLEAN DEFAULT FALSE,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(game_id, user_id)
        )
      `);

      // Rounds
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rounds (
          id SERIAL PRIMARY KEY,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          round_number INTEGER NOT NULL,
          question_id INTEGER NOT NULL REFERENCES questions(id),
          question_master_id INTEGER NOT NULL REFERENCES users(id),
          status VARCHAR(20) NOT NULL DEFAULT 'picking',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(game_id, round_number)
        )
      `);

      // Round answers
      await pool.query(`
        CREATE TABLE IF NOT EXISTS round_answers (
          id SERIAL PRIMARY KEY,
          round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id),
          answer_text TEXT NOT NULL,
          is_correct BOOLEAN DEFAULT FALSE,
          votes_received INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(round_id, user_id)
        )
      `);

      // Round votes
      await pool.query(`
        CREATE TABLE IF NOT EXISTS round_votes (
          id SERIAL PRIMARY KEY,
          round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
          voter_id INTEGER NOT NULL REFERENCES users(id),
          answer_id INTEGER NOT NULL REFERENCES round_answers(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(round_id, voter_id)
        )
      `);

      res.json({ success: true, message: 'All game tables created successfully' });
    } catch (err) {
      console.error('Migration error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
