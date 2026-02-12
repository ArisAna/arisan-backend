const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your TopHost domain
app.use(cors({
  origin: ['https://arisan.gr', 'http://localhost:3000']
}));

app.use(express.json());

// Test endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint with data
app.get('/api/hello/:name', (req, res) => {
  const { name } = req.params;
  res.json({ 
    message: `Hello, ${name}!`,
    serverTime: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});