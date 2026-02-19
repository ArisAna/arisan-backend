const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

module.exports = function (pool) {
  const JWT_SECRET = process.env.JWT_SECRET;
  const JWT_EXPIRES_IN = '7d';

  // POST /api/auth/register
  router.post('/register', async (req, res) => {
    const { email, password, display_name } = req.body;

    if (!email || !password || !display_name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and display name are required',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters',
      });
    }

    try {
      const existing = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'Email already registered',
        });
      }

      const password_hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, is_admin, created_at',
        [email.toLowerCase(), password_hash, display_name]
      );

      const user = result.rows[0];
      const token = jwt.sign(
        { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.status(201).json({
        success: true,
        token,
        user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin },
      });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ success: false, error: 'Registration failed' });
    }
  });

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    try {
      const result = await pool.query(
        'SELECT id, email, password_hash, display_name, is_admin FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      const user = result.rows[0];
      const validPassword = await bcrypt.compare(password, user.password_hash);

      if (!validPassword) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.json({
        success: true,
        token,
        user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin },
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  });

  // GET /api/auth/me
  router.get('/me', authenticateToken, async (req, res) => {
    res.json({
      success: true,
      user: req.user,
    });
  });

  return router;
};
