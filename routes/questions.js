const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { generateQuestionsWithGemini, CATEGORIES } = require('../utils/generateQuestions');

const router = express.Router();

module.exports = function (pool) {
  // GET /api/questions/categories - get fixed category list
  router.get('/categories', authenticateToken, (req, res) => {
    res.json({ success: true, categories: CATEGORIES });
  });

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

    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid category',
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

  // POST /api/questions/seed - generate 30 new questions with AI (admin only)
  router.post('/seed', authenticateToken, requireAdmin, async (req, res) => {
    try {
      // Get existing questions to avoid duplicates
      const existing = await pool.query('SELECT question_text FROM questions');
      const existingTexts = new Set(existing.rows.map(r => r.question_text));

      // Generate with Gemini
      const generated = await generateQuestionsWithGemini(existing.rows);

      let inserted = 0;
      for (const q of generated) {
        if (!existingTexts.has(q.question)) {
          await pool.query(
            'INSERT INTO questions (question_text, correct_answer, category, created_by) VALUES ($1, $2, $3, $4)',
            [q.question, q.answer, q.category, req.user.id]
          );
          inserted++;
          existingTexts.add(q.question);
        }
      }

      res.json({
        success: true,
        message: `Δημιουργήθηκαν ${inserted} νέες ερωτήσεις με AI (${generated.length - inserted} ήταν διπλότυπες)`,
      });
    } catch (err) {
      console.error('Seed error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/questions/:id - update question (admin only)
  router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { question_text, correct_answer, category } = req.body;

    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: 'Invalid category' });
    }

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

  // DELETE /api/questions/:id - delete single question (admin only)
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

  // DELETE /api/questions - delete ALL questions (admin only)
  router.delete('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM questions');
      res.json({ success: true, message: `Διαγράφηκαν ${result.rowCount} ερωτήσεις` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
