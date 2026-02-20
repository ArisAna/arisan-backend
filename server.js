const express = require('express');
const http = require('http');
const cors = require('cors');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
  : ['http://localhost:3000'];

const corsOptions = {
  origin: function (origin, callback) {
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
};

app.use(cors(corsOptions));
app.use(express.json());

// Socket.IO
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
});

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (!token) return next(new Error('No token provided'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.user.display_name} (${socket.user.id})`);

  // Join lobby room to get game list updates
  socket.on('join_lobby', () => {
    socket.join('lobby');
  });

  socket.on('leave_lobby', () => {
    socket.leave('lobby');
  });

  // Join specific game room
  socket.on('join_game_room', (gameId) => {
    socket.join(`game:${gameId}`);
  });

  socket.on('leave_game_room', (gameId) => {
    socket.leave(`game:${gameId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.user.display_name}`);
  });
});

// Routes
const authRoutes = require('./routes/auth');
const migrateRoutes = require('./routes/migrate');
const questionRoutes = require('./routes/questions');
const adminRoutes = require('./routes/admin');
const gameRoutes = require('./routes/games');
const roundRoutes = require('./routes/rounds');

app.use('/api/auth', authRoutes(pool));
app.use('/api/migrate', migrateRoutes(pool));
app.use('/api/questions', questionRoutes(pool));
app.use('/api/admin', adminRoutes(pool));
app.use('/api/games', gameRoutes(pool, io));
app.use('/api/games/:gameId', roundRoutes(pool, io));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database test
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    res.json({ success: true, database_time: result.rows[0].current_time, postgres_version: result.rows[0].pg_version });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ success: false, error: 'Name, email, and message are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO contacts (name, email, message) VALUES ($1, $2, $3) RETURNING *',
      [name, email, message]
    );
    res.json({ success: true, contact: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, message, created_at FROM contacts ORDER BY created_at DESC');
    res.json({ success: true, contacts: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
