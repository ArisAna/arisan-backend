const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to the database:', err.stack);
  } else {
    console.log('Successfully connected to database');
    release();
  }
});

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000']; // Default to localhost for development

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
const migrateRoutes = require('./routes/migrate');
const questionRoutes = require('./routes/questions');
const adminRoutes = require('./routes/admin');

app.use('/api/auth', authRoutes(pool));
app.use('/api/migrate', migrateRoutes(pool));
app.use('/api/questions', questionRoutes(pool));
app.use('/api/admin', adminRoutes(pool));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Database test endpoint
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    res.json({ 
      success: true, 
      database_time: result.rows[0].current_time,
      postgres_version: result.rows[0].pg_version
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Example: Create a simple contacts table and endpoints
app.post('/api/init-db', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    res.json({ success: true, message: 'Database initialized' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Initialize users table
app.post('/api/init-users', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    res.json({ success: true, message: 'Users table initialized' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bootstrap: set first user as admin (one-time setup)
app.post('/api/bootstrap-admin', async (req, res) => {
  try {
    const admins = await pool.query('SELECT id FROM users WHERE is_admin = true');
    if (admins.rows.length > 0) {
      return res.json({ success: false, message: 'Admin already exists' });
    }
    const result = await pool.query(
      'UPDATE users SET is_admin = true WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1) RETURNING id, email, display_name'
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No users found' });
    }
    res.json({ success: true, message: 'First user set as admin', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Migration endpoint to add name column to existing tables
app.post('/api/migrate-add-name', async (req, res) => {
  try {
    // Check if name column already exists
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name = 'name'
    `);

    if (columnCheck.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Name column already exists, no migration needed'
      });
    }

    // Add name column with a default value for existing rows
    await pool.query(`
      ALTER TABLE contacts
      ADD COLUMN name VARCHAR(255) DEFAULT 'Anonymous'
    `);

    // Remove the default constraint after adding the column
    await pool.query(`
      ALTER TABLE contacts
      ALTER COLUMN name DROP DEFAULT
    `);

    res.json({
      success: true,
      message: 'Name column added successfully. Existing contacts set to "Anonymous"'
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({
      success: false,
      error: 'Name, email, and message are required'
    });
  }

  try {
    const result = await pool.query(
      'INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3) RETURNING *',
      [name, email, message]
    );
    res.json({
      success: true,
      contact: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, message, created_at FROM contacts ORDER BY created_at DESC'
    );
    res.json({
      success: true,
      contacts: result.rows
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});