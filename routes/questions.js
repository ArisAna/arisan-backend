const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

const SEED_QUESTIONS = [
  { question: "What is the capital of Australia?", answer: "Canberra", category: "Geography" },
  { question: "In what year did the Titanic sink?", answer: "1912", category: "History" },
  { question: "What is the smallest planet in our solar system?", answer: "Mercury", category: "Science" },
  { question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci", category: "Art" },
  { question: "What is the chemical symbol for gold?", answer: "Au", category: "Science" },
  { question: "Which country has the longest coastline in the world?", answer: "Canada", category: "Geography" },
  { question: "What is the hardest natural substance on Earth?", answer: "Diamond", category: "Science" },
  { question: "In which city was the first modern Olympic Games held?", answer: "Athens", category: "Sports" },
  { question: "What is the largest organ in the human body?", answer: "Skin", category: "Science" },
  { question: "Who wrote 'Romeo and Juliet'?", answer: "William Shakespeare", category: "Literature" },
  { question: "What is the speed of light in km/s (approximately)?", answer: "300,000 km/s", category: "Science" },
  { question: "Which planet is known as the Red Planet?", answer: "Mars", category: "Science" },
  { question: "What language has the most native speakers in the world?", answer: "Mandarin Chinese", category: "Language" },
  { question: "What is the tallest mountain in the world?", answer: "Mount Everest", category: "Geography" },
  { question: "Who discovered penicillin?", answer: "Alexander Fleming", category: "Science" },
  { question: "What is the largest desert in the world?", answer: "Antarctic Desert", category: "Geography" },
  { question: "In what year did World War II end?", answer: "1945", category: "History" },
  { question: "What is the main ingredient in guacamole?", answer: "Avocado", category: "Food" },
  { question: "Which element has the atomic number 1?", answer: "Hydrogen", category: "Science" },
  { question: "What is the longest river in the world?", answer: "Nile", category: "Geography" },
  { question: "Who was the first person to walk on the moon?", answer: "Neil Armstrong", category: "History" },
  { question: "What is the currency of Japan?", answer: "Yen", category: "General" },
  { question: "How many bones does an adult human body have?", answer: "206", category: "Science" },
  { question: "What is the national animal of Scotland?", answer: "Unicorn", category: "General" },
  { question: "Which ocean is the deepest?", answer: "Pacific Ocean", category: "Geography" },
];

module.exports = function (pool) {
  // GET /api/questions - list all questions
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const { category } = req.query;
      let query = 'SELECT id, question_text, correct_answer, category, created_at FROM questions';
      const params = [];

      if (category) {
        query += ' WHERE category = $1';
        params.push(category);
      }

      query += ' ORDER BY created_at DESC';
      const result = await pool.query(query, params);
      res.json({ success: true, questions: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/questions - create question (admin only)
  router.post('/', authenticateToken, requireAdmin, async (req, res) => {
    const { question_text, correct_answer, category } = req.body;

    if (!question_text || !correct_answer) {
      return res.status(400).json({
        success: false,
        error: 'Question text and correct answer are required',
      });
    }

    try {
      const result = await pool.query(
        'INSERT INTO questions (question_text, correct_answer, category, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [question_text, correct_answer, category || null, req.user.id]
      );
      res.status(201).json({ success: true, question: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/questions/seed - seed initial questions (admin only)
  router.post('/seed', authenticateToken, requireAdmin, async (req, res) => {
    try {
      let inserted = 0;
      for (const q of SEED_QUESTIONS) {
        const existing = await pool.query(
          'SELECT id FROM questions WHERE question_text = $1',
          [q.question]
        );
        if (existing.rows.length === 0) {
          await pool.query(
            'INSERT INTO questions (question_text, correct_answer, category, created_by) VALUES ($1, $2, $3, $4)',
            [q.question, q.answer, q.category, req.user.id]
          );
          inserted++;
        }
      }
      res.json({ success: true, message: `Seeded ${inserted} new questions (${SEED_QUESTIONS.length - inserted} already existed)` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/questions/:id - update question (admin only)
  router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { question_text, correct_answer, category } = req.body;

    try {
      const result = await pool.query(
        'UPDATE questions SET question_text = COALESCE($1, question_text), correct_answer = COALESCE($2, correct_answer), category = COALESCE($3, category) WHERE id = $4 RETURNING *',
        [question_text, correct_answer, category, req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Question not found' });
      }
      res.json({ success: true, question: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/questions/:id - delete question (admin only)
  router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM questions WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Question not found' });
      }
      res.json({ success: true, message: 'Question deleted' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
