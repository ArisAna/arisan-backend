const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

module.exports = function (pool, connectedSessions, io) {
  // GET /api/admin/users - list all users
  router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, email, display_name, is_admin, created_at FROM users ORDER BY created_at DESC'
      );
      res.json({ success: true, users: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/admin/users/:id/toggle-admin
  router.post('/users/:id/toggle-admin', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING id, email, display_name, is_admin',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      res.json({ success: true, user: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/admin/sessions - all users with online/offline status
  router.get('/sessions', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, display_name, email, is_admin FROM users ORDER BY display_name ASC'
      );
      const sessions = result.rows.map(u => {
        const live = connectedSessions.get(u.id);
        return {
          user_id: u.id,
          display_name: u.display_name,
          email: u.email,
          is_admin: u.is_admin,
          is_online: !!live,
          connection_count: live?.socketIds.size || 0,
          connected_at: live?.connectedAt || null,
          current_game: live?.currentGame || null,
        };
      });
      // Online users first, then offline alphabetically
      sessions.sort((a, b) => {
        if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
        return a.display_name.localeCompare(b.display_name);
      });
      res.json({ success: true, sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/admin/users/:id/kick - force-disconnect a user's sockets
  router.post('/users/:id/kick', authenticateToken, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot kick yourself' });
    }

    const session = connectedSessions.get(userId);
    if (!session || session.socketIds.size === 0) {
      return res.json({ success: true, message: 'User is not connected' });
    }

    // Emit force_logout to all their sockets before disconnecting
    for (const socketId of session.socketIds) {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.emit('force_logout');
        s.disconnect(true);
      }
    }
    connectedSessions.delete(userId);

    res.json({ success: true, message: 'User disconnected' });
  });

  return router;
};
