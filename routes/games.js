const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

module.exports = function (pool, io) {
  const router = express.Router();

  // Helper: get full game with players
  async function getGame(gameId) {
    const gameRes = await pool.query(
      `SELECT g.id, g.status, g.current_round, g.total_rounds, g.created_at, g.started_at,
              u.display_name AS creator_name, g.created_by
       FROM games g
       JOIN users u ON g.created_by = u.id
       WHERE g.id = $1`,
      [gameId]
    );
    if (gameRes.rows.length === 0) return null;

    const playersRes = await pool.query(
      `SELECT gp.user_id, gp.turn_order, gp.score, gp.is_connected,
              u.display_name
       FROM game_players gp
       JOIN users u ON gp.user_id = u.id
       WHERE gp.game_id = $1
       ORDER BY gp.turn_order`,
      [gameId]
    );

    return { ...gameRes.rows[0], players: playersRes.rows };
  }

  // Helper: broadcast game update to lobby and game room
  async function broadcastGame(gameId) {
    const game = await getGame(gameId);
    if (!game) return;
    io.to(`game:${gameId}`).emit('game_updated', game);
    io.to('lobby').emit('lobby_updated');
  }

  // GET /api/games - list lobby + in_progress games
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT g.id, g.status, g.current_round, g.created_at, g.started_at,
                u.display_name AS creator_name,
                COUNT(gp.user_id)::int AS player_count
         FROM games g
         JOIN users u ON g.created_by = u.id
         LEFT JOIN game_players gp ON gp.game_id = g.id
         WHERE g.status IN ('lobby', 'in_progress')
         GROUP BY g.id, u.display_name
         ORDER BY g.created_at DESC`
      );
      res.json({ success: true, games: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/games/:id - get single game with players
  router.get('/:id', authenticateToken, async (req, res) => {
    try {
      const game = await getGame(req.params.id);
      if (!game) return res.status(404).json({ success: false, error: 'Game not found' });
      res.json({ success: true, game });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games - create game (admin only)
  router.post('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        `INSERT INTO games (created_by, status) VALUES ($1, 'lobby') RETURNING id`,
        [req.user.id]
      );
      const gameId = result.rows[0].id;

      // Creator auto-joins with turn_order 1
      await pool.query(
        `INSERT INTO game_players (game_id, user_id, turn_order) VALUES ($1, $2, 1)`,
        [gameId, req.user.id]
      );

      const game = await getGame(gameId);
      io.to('lobby').emit('lobby_updated');
      res.status(201).json({ success: true, game });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:id/join - join a game
  router.post('/:id/join', authenticateToken, async (req, res) => {
    try {
      const gameRes = await pool.query(
        `SELECT id, status FROM games WHERE id = $1`,
        [req.params.id]
      );
      if (gameRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Game not found' });
      }
      if (gameRes.rows[0].status !== 'lobby') {
        return res.status(400).json({ success: false, error: 'Game is not in lobby' });
      }

      // Check already joined
      const existing = await pool.query(
        `SELECT id FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (existing.rows.length > 0) {
        return res.json({ success: true, message: 'Already in game' });
      }

      // Get next turn order
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS count FROM game_players WHERE game_id = $1`,
        [req.params.id]
      );
      const turnOrder = countRes.rows[0].count + 1;

      await pool.query(
        `INSERT INTO game_players (game_id, user_id, turn_order) VALUES ($1, $2, $3)`,
        [req.params.id, req.user.id, turnOrder]
      );

      await broadcastGame(req.params.id);
      res.json({ success: true, message: 'Joined game' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:id/leave - leave lobby (not during game)
  router.post('/:id/leave', authenticateToken, async (req, res) => {
    try {
      const gameRes = await pool.query(
        `SELECT id, status, created_by FROM games WHERE id = $1`,
        [req.params.id]
      );
      if (gameRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Game not found' });
      }
      if (gameRes.rows[0].status !== 'lobby') {
        return res.status(400).json({ success: false, error: 'Cannot leave a game in progress' });
      }
      if (gameRes.rows[0].created_by === req.user.id) {
        return res.status(400).json({ success: false, error: 'Creator cannot leave - delete the game instead' });
      }

      await pool.query(
        `DELETE FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );

      await broadcastGame(req.params.id);
      res.json({ success: true, message: 'Left game' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:id/start - start game (creator or admin)
  router.post('/:id/start', authenticateToken, async (req, res) => {
    try {
      const gameRes = await pool.query(
        `SELECT id, status, created_by FROM games WHERE id = $1`,
        [req.params.id]
      );
      if (gameRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Game not found' });
      }

      const game = gameRes.rows[0];
      if (game.status !== 'lobby') {
        return res.status(400).json({ success: false, error: 'Game already started' });
      }
      if (game.created_by !== req.user.id && !req.user.is_admin) {
        return res.status(403).json({ success: false, error: 'Only the creator or admin can start' });
      }

      const playerCount = await pool.query(
        `SELECT COUNT(*)::int AS count FROM game_players WHERE game_id = $1`,
        [req.params.id]
      );
      if (playerCount.rows[0].count < 2) {
        return res.status(400).json({ success: false, error: 'Need at least 2 players to start' });
      }

      await pool.query(
        `UPDATE games SET status = 'in_progress', started_at = NOW(), current_round = 1 WHERE id = $1`,
        [req.params.id]
      );

      const updatedGame = await getGame(req.params.id);
      io.to(`game:${req.params.id}`).emit('game_started', updatedGame);
      io.to('lobby').emit('lobby_updated');
      res.json({ success: true, game: updatedGame });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
