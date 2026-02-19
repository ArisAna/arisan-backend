const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

module.exports = function (pool) {
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

  return router;
};
