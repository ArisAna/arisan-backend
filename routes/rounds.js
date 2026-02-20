const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { generateQuestionsWithGemini, CATEGORIES } = require('../utils/generateQuestions');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = function (pool, io) {
  const router = express.Router({ mergeParams: true });

  // Get personalized round state for this game + user
  async function getRoundState(gameId, userId) {
    const gameRes = await pool.query(
      `SELECT current_round, total_rounds, status, end_mode, cycles, target_points FROM games WHERE id = $1`,
      [gameId]
    );
    if (!gameRes.rows.length) return null;
    const game = gameRes.rows[0];

    // Scores
    const scoresRes = await pool.query(
      `SELECT gp.user_id, u.display_name, gp.score, gp.turn_order
       FROM game_players gp JOIN users u ON gp.user_id = u.id
       WHERE gp.game_id = $1 ORDER BY gp.score DESC`,
      [gameId]
    );

    // Determine QM for current round (by turn_order, cycling)
    const playersByTurn = await pool.query(
      `SELECT gp.user_id, u.display_name FROM game_players gp
       JOIN users u ON gp.user_id = u.id
       WHERE gp.game_id = $1 ORDER BY gp.turn_order`,
      [gameId]
    );
    const qmIndex = (game.current_round - 1) % playersByTurn.rows.length;
    const currentQm = playersByTurn.rows[qmIndex];

    const base = {
      game,
      scores: scoresRes.rows,
      round_number: game.current_round,
      question_master_id: currentQm.user_id,
      qm_name: currentQm.display_name,
    };

    // Check if round exists for current round number
    const roundRes = await pool.query(
      `SELECT r.id, r.status, r.question_id,
              q.question_text, q.correct_answer
       FROM rounds r
       JOIN questions q ON r.question_id = q.id
       WHERE r.game_id = $1 AND r.round_number = $2`,
      [gameId, game.current_round]
    );

    if (!roundRes.rows.length) {
      return { ...base, status: 'picking', answers: [], my_answer: null, my_vote: null, answered_count: 0 };
    }

    const round = roundRes.rows[0];

    // Count player answers submitted
    const answeredRes = await pool.query(
      `SELECT COUNT(*)::int as count FROM round_answers WHERE round_id = $1 AND user_id IS NOT NULL`,
      [round.id]
    );
    const answeredCount = answeredRes.rows[0].count;

    // My answer
    let myAnswer = null;
    if (userId) {
      const r = await pool.query(
        `SELECT answer_text FROM round_answers WHERE round_id = $1 AND user_id = $2`,
        [round.id, userId]
      );
      myAnswer = r.rows[0]?.answer_text || null;
    }

    // My vote
    let myVote = null;
    if (userId) {
      const r = await pool.query(
        `SELECT answer_id FROM round_votes WHERE round_id = $1 AND voter_id = $2`,
        [round.id, userId]
      );
      myVote = r.rows[0]?.answer_id || null;
    }

    // Vote count
    const voteCountRes = await pool.query(
      `SELECT COUNT(*)::int as count FROM round_votes WHERE round_id = $1`,
      [round.id]
    );

    const isQM = userId === currentQm.user_id;

    // Answers — content depends on phase and whether the viewer is the QM
    let answers = [];
    if (round.status === 'answering') {
      if (isQM) {
        // QM sees who has answered so far with their text (correct-guess highlighted via is_correct)
        const r = await pool.query(
          `SELECT ra.id, ra.user_id, ra.answer_text, ra.is_correct,
                  u.display_name
           FROM round_answers ra
           LEFT JOIN users u ON ra.user_id = u.id
           WHERE ra.round_id = $1 AND ra.user_id IS NOT NULL
           ORDER BY ra.id`,
          [round.id]
        );
        answers = r.rows;
      }
      // regular players see nothing yet — empty array
    } else if (round.status === 'voting') {
      if (isQM) {
        // QM sees deanonymized answers (all player submissions, not the correct-answer row)
        const r = await pool.query(
          `SELECT ra.id, ra.user_id, ra.answer_text, ra.is_correct,
                  u.display_name
           FROM round_answers ra
           LEFT JOIN users u ON ra.user_id = u.id
           WHERE ra.round_id = $1 AND ra.user_id IS NOT NULL
           ORDER BY ra.id`,
          [round.id]
        );
        answers = r.rows;
      } else {
        // Regular players: anonymized, deduplicated, excludes correct-guesses, shuffled
        const r = await pool.query(
          `SELECT MIN(id) as id, answer_text FROM round_answers
           WHERE round_id = $1
             AND NOT (user_id IS NOT NULL AND is_correct = TRUE)
           GROUP BY answer_text
           ORDER BY md5($1::text || MIN(id)::text)`,
          [round.id]
        );
        answers = r.rows;
      }
    } else if (round.status === 'results') {
      const r = await pool.query(
        `SELECT ra.id, ra.user_id, ra.answer_text, ra.is_correct, ra.votes_received,
                u.display_name
         FROM round_answers ra
         LEFT JOIN users u ON ra.user_id = u.id
         WHERE ra.round_id = $1
         ORDER BY ra.votes_received DESC, ra.is_correct DESC`,
        [round.id]
      );
      answers = r.rows;
    }

    return {
      ...base,
      id: round.id,
      status: round.status,
      question_text: round.question_text,
      // Correct answer revealed to QM during answering/voting, and to everyone at results
      correct_answer: (round.status === 'results' || isQM) ? round.correct_answer : undefined,
      answered_count: answeredCount,
      vote_count: voteCountRes.rows[0].count,
      answers,
      my_answer: myAnswer,
      my_vote: myVote,
    };
  }

  // Tell all clients in a game room to reload their round
  function broadcastReload(gameId) {
    io.to(`game:${gameId}`).emit('reload_round');
  }

  // GET /api/games/:gameId/breakdown — per-player scoring breakdown for final results
  router.get('/breakdown', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;

      // Must be a participant or admin
      const inGame = await pool.query(
        `SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [gameId, req.user.id]
      );
      if (!inGame.rows.length && !req.user.is_admin) {
        return res.status(403).json({ error: 'Not in this game' });
      }

      const players = await pool.query(
        `SELECT gp.user_id, u.display_name, gp.score
         FROM game_players gp JOIN users u ON gp.user_id = u.id
         WHERE gp.game_id = $1 ORDER BY gp.score DESC`,
        [gameId]
      );

      // Correct guesses: player submitted the exact correct answer during answering phase
      const correctGuesses = await pool.query(
        `SELECT ra.user_id, COUNT(*)::int AS count
         FROM round_answers ra JOIN rounds r ON ra.round_id = r.id
         WHERE r.game_id = $1 AND ra.user_id IS NOT NULL AND ra.is_correct = TRUE
         GROUP BY ra.user_id`,
        [gameId]
      );

      // Correct votes: player voted for the real answer (user_id IS NULL row)
      const correctVotes = await pool.query(
        `SELECT rv.voter_id AS user_id, COUNT(*)::int AS count
         FROM round_votes rv
         JOIN rounds r ON rv.round_id = r.id
         JOIN round_answers ra ON rv.answer_id = ra.id
         WHERE r.game_id = $1 AND ra.is_correct = TRUE AND ra.user_id IS NULL
         GROUP BY rv.voter_id`,
        [gameId]
      );

      // Bluff votes: total votes other players cast on this player's fake answer
      const bluffVotes = await pool.query(
        `SELECT ra.user_id, SUM(ra.votes_received)::int AS count
         FROM round_answers ra JOIN rounds r ON ra.round_id = r.id
         WHERE r.game_id = $1
           AND ra.user_id IS NOT NULL
           AND ra.is_correct = FALSE
           AND ra.votes_received > 0
         GROUP BY ra.user_id`,
        [gameId]
      );

      // QM bonus: rounds where this player was QM and nobody found the correct answer
      const qmBonuses = await pool.query(
        `SELECT r.question_master_id AS user_id, COUNT(*)::int AS count
         FROM rounds r
         WHERE r.game_id = $1 AND r.status = 'results'
           AND NOT EXISTS (
             SELECT 1 FROM round_votes rv
             JOIN round_answers ra ON rv.answer_id = ra.id
             WHERE rv.round_id = r.id AND ra.is_correct = TRUE AND ra.user_id IS NULL
           )
         GROUP BY r.question_master_id`,
        [gameId]
      );

      const cg = Object.fromEntries(correctGuesses.rows.map(r => [r.user_id, r.count]));
      const cv = Object.fromEntries(correctVotes.rows.map(r => [r.user_id, r.count]));
      const bv = Object.fromEntries(bluffVotes.rows.map(r => [r.user_id, r.count]));
      const qb = Object.fromEntries(qmBonuses.rows.map(r => [r.user_id, r.count]));

      const breakdown = players.rows.map(p => ({
        user_id: p.user_id,
        display_name: p.display_name,
        score: p.score,
        correct_guesses: cg[p.user_id] || 0,
        correct_votes: cv[p.user_id] || 0,
        bluff_votes: bv[p.user_id] || 0,
        qm_bonuses: qb[p.user_id] || 0,
      }));

      res.json({ success: true, breakdown });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/games/:gameId/round
  router.get('/round', authenticateToken, async (req, res) => {
    try {
      const state = await getRoundState(req.params.gameId, req.user.id);
      res.json({ success: true, round: state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/games/:gameId/available-questions?category=X&exclude=1,2,3
  router.get('/available-questions', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;
      const { category, exclude } = req.query;

      const params = [gameId];
      let categoryClause = '';
      if (category) {
        params.push(category);
        categoryClause = ` AND category = $${params.length}`;
      }

      // Exclude already-shown question IDs (for Load More support)
      let excludeClause = '';
      if (exclude) {
        const excludeIds = String(exclude).split(',').map(Number).filter(n => !isNaN(n) && n > 0);
        if (excludeIds.length > 0) {
          const placeholders = excludeIds.map((_, i) => `$${params.length + 1 + i}`).join(',');
          excludeClause = ` AND id NOT IN (${placeholders})`;
          params.push(...excludeIds);
        }
      }

      const result = await pool.query(
        `SELECT id, question_text, correct_answer, category FROM questions
         WHERE id NOT IN (SELECT question_id FROM rounds WHERE game_id = $1)
         AND id NOT IN (
           SELECT DISTINCT r.question_id
           FROM rounds r
           JOIN game_players gp ON gp.game_id = r.game_id
           WHERE gp.user_id IN (SELECT user_id FROM game_players WHERE game_id = $1)
             AND r.status = 'results'
         )
         ${categoryClause}${excludeClause}
         ORDER BY created_at DESC LIMIT 6`,
        params
      );
      res.json({ success: true, questions: result.rows, categories: CATEGORIES });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/games/:gameId/edit-question/:questionId — QM edits question/answer
  router.put('/edit-question/:questionId', authenticateToken, async (req, res) => {
    try {
      const { gameId, questionId } = req.params;
      const { question_text, correct_answer } = req.body;

      if (!question_text?.trim() && !correct_answer?.trim()) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      // Verify user is the current QM
      const gameRes = await pool.query(`SELECT current_round FROM games WHERE id = $1`, [gameId]);
      if (!gameRes.rows.length) return res.status(404).json({ error: 'Game not found' });

      const players = await pool.query(
        `SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY turn_order`, [gameId]
      );
      const qmId = players.rows[(gameRes.rows[0].current_round - 1) % players.rows.length]?.user_id;
      if (req.user.id !== qmId && !req.user.is_admin) {
        return res.status(403).json({ error: 'Only the Question Master can edit questions during the game' });
      }

      const result = await pool.query(
        `UPDATE questions
         SET question_text = COALESCE(NULLIF($1, ''), question_text),
             correct_answer = COALESCE(NULLIF($2, ''), correct_answer)
         WHERE id = $3 RETURNING id, question_text, correct_answer, category`,
        [question_text?.trim() || '', correct_answer?.trim() || '', questionId]
      );

      if (!result.rows.length) return res.status(404).json({ error: 'Question not found' });
      res.json({ success: true, question: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:gameId/seed-questions — any player generates 10 more questions with AI
  router.post('/seed-questions', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;

      // Verify user is in this game
      const inGame = await pool.query(
        `SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [gameId, req.user.id]
      );
      if (!inGame.rows.length) return res.status(403).json({ error: 'You are not in this game' });

      const existing = await pool.query('SELECT question_text FROM questions');
      const existingTexts = new Set(existing.rows.map(r => r.question_text));

      const generated = await generateQuestionsWithGemini(existing.rows, 10);

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
        message: `Δημιουργήθηκαν ${inserted} νέες ερωτήσεις με AI`,
      });
    } catch (err) {
      console.error('Seed error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:gameId/spell-check
  router.post('/spell-check', authenticateToken, async (req, res) => {
    const { text } = req.body;
    if (!text?.trim() || text.trim().length < 3) {
      return res.json({ success: true, suggestion: null });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('Spell-check: GEMINI_API_KEY not set');
      return res.json({ success: true, suggestion: null });
    }

    const inputText = text.trim();

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

      // English instructions perform more reliably for this type of task.
      // Key focus: add missing tonos (accent marks) — the most common Greek mobile typing error.
      const prompt = `You are a Greek spell checker. The input is a short Greek phrase (a trivia game answer). Your task:
1. Add any missing accent marks (tonos) — e.g. "αθηνα" → "Αθήνα", "ελεφαντας" → "ελέφαντας"
2. Fix obvious spelling mistakes (wrong letters, typos)
3. Do NOT change the meaning or add/remove words
4. Return ONLY the corrected text, nothing else — no quotes, no explanation, no punctuation added

Input: ${inputText}`;

      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();

      // Strip any stray quote characters the model might add
      const suggestion = raw.replace(/^["«»""'`]+|["«»""'`]+$/g, '').trim();

      // Compare using NFC normalization so Greek Unicode variants
      // (composed ά U+03AC vs decomposed α+U+0301) don't cause false equality
      const normInput = inputText.normalize('NFC').toLowerCase();
      const normSuggestion = suggestion.normalize('NFC').toLowerCase();

      if (!suggestion || normSuggestion === normInput) {
        return res.json({ success: true, suggestion: null });
      }

      res.json({ success: true, suggestion });
    } catch (err) {
      console.error('Spell-check Gemini error:', err.message);
      res.json({ success: true, suggestion: null });
    }
  });

  // POST /api/games/:gameId/pick-question
  router.post('/pick-question', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;
      const { question_id } = req.body;

      const gameRes = await pool.query(`SELECT * FROM games WHERE id = $1`, [gameId]);
      if (!gameRes.rows.length) return res.status(404).json({ error: 'Game not found' });
      const game = gameRes.rows[0];
      if (game.status !== 'in_progress') return res.status(400).json({ error: 'Game not active' });

      const players = await pool.query(
        `SELECT user_id FROM game_players WHERE game_id = $1 ORDER BY turn_order`, [gameId]
      );
      const qmId = players.rows[(game.current_round - 1) % players.rows.length].user_id;
      if (req.user.id !== qmId) return res.status(403).json({ error: 'Not your turn to pick' });

      const existing = await pool.query(
        `SELECT id FROM rounds WHERE game_id = $1 AND round_number = $2`,
        [gameId, game.current_round]
      );
      if (existing.rows.length) return res.status(400).json({ error: 'Round already started' });

      const roundRes = await pool.query(
        `INSERT INTO rounds (game_id, round_number, question_id, question_master_id, status)
         VALUES ($1, $2, $3, $4, 'answering') RETURNING id`,
        [gameId, game.current_round, question_id, qmId]
      );
      const roundId = roundRes.rows[0].id;

      const qRes = await pool.query(`SELECT correct_answer FROM questions WHERE id = $1`, [question_id]);
      await pool.query(
        `INSERT INTO round_answers (round_id, user_id, answer_text, is_correct) VALUES ($1, NULL, $2, TRUE)`,
        [roundId, qRes.rows[0].correct_answer]
      );

      broadcastReload(gameId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:gameId/answer
  router.post('/answer', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;
      const { answer_text } = req.body;
      if (!answer_text?.trim()) return res.status(400).json({ error: 'Answer required' });

      const roundRes = await pool.query(
        `SELECT id, question_master_id, status FROM rounds
         WHERE game_id = $1 ORDER BY round_number DESC LIMIT 1`,
        [gameId]
      );
      if (!roundRes.rows.length || roundRes.rows[0].status !== 'answering') {
        return res.status(400).json({ error: 'Not in answering phase' });
      }
      const round = roundRes.rows[0];
      if (round.question_master_id === req.user.id) {
        return res.status(400).json({ error: 'Question master cannot answer' });
      }

      const trimmed = answer_text.trim();

      // Check if player's answer matches the correct answer (case-insensitive)
      const correctRes = await pool.query(
        `SELECT answer_text FROM round_answers WHERE round_id = $1 AND user_id IS NULL AND is_correct = TRUE`,
        [round.id]
      );
      const correctText = correctRes.rows[0]?.answer_text?.trim().toLowerCase() || '';
      const isCorrectGuess = correctText && trimmed.toLowerCase() === correctText;

      await pool.query(
        `INSERT INTO round_answers (round_id, user_id, answer_text, is_correct)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (round_id, user_id) DO UPDATE SET answer_text = EXCLUDED.answer_text, is_correct = EXCLUDED.is_correct`,
        [round.id, req.user.id, trimmed, isCorrectGuess]
      );

      // Award 3 pts immediately for guessing correctly — answer excluded from voting pool
      if (isCorrectGuess) {
        await pool.query(
          `UPDATE game_players SET score = score + 3 WHERE game_id = $1 AND user_id = $2`,
          [gameId, req.user.id]
        );
      }

      const playerCount = await pool.query(
        `SELECT COUNT(*)::int as c FROM game_players WHERE game_id = $1`, [gameId]
      );
      const answerCount = await pool.query(
        `SELECT COUNT(*)::int as c FROM round_answers WHERE round_id = $1 AND user_id IS NOT NULL`,
        [round.id]
      );
      if (answerCount.rows[0].c >= playerCount.rows[0].c - 1) {
        await pool.query(`UPDATE rounds SET status = 'voting' WHERE id = $1`, [round.id]);
      }

      broadcastReload(gameId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:gameId/vote
  router.post('/vote', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;
      const { answer_id } = req.body;

      const roundRes = await pool.query(
        `SELECT id, question_master_id, status FROM rounds
         WHERE game_id = $1 ORDER BY round_number DESC LIMIT 1`,
        [gameId]
      );
      if (!roundRes.rows.length || roundRes.rows[0].status !== 'voting') {
        return res.status(400).json({ error: 'Not in voting phase' });
      }
      const round = roundRes.rows[0];
      if (round.question_master_id === req.user.id) {
        return res.status(400).json({ error: 'Question master cannot vote' });
      }

      const ownAnswer = await pool.query(
        `SELECT id FROM round_answers WHERE round_id = $1 AND user_id = $2`,
        [round.id, req.user.id]
      );
      if (ownAnswer.rows.length && ownAnswer.rows[0].id === parseInt(answer_id)) {
        return res.status(400).json({ error: 'Cannot vote for your own answer' });
      }

      await pool.query(
        `INSERT INTO round_votes (round_id, voter_id, answer_id) VALUES ($1, $2, $3)
         ON CONFLICT (round_id, voter_id) DO UPDATE SET answer_id = EXCLUDED.answer_id`,
        [round.id, req.user.id, answer_id]
      );

      const playerCount = await pool.query(
        `SELECT COUNT(*)::int as c FROM game_players WHERE game_id = $1`, [gameId]
      );
      const voteCount = await pool.query(
        `SELECT COUNT(*)::int as c FROM round_votes WHERE round_id = $1`, [round.id]
      );
      if (voteCount.rows[0].c >= playerCount.rows[0].c - 1) {
        await calculateAndAwardPoints(round.id, gameId, round.question_master_id, pool);
        await pool.query(`UPDATE rounds SET status = 'results' WHERE id = $1`, [round.id]);
      }

      broadcastReload(gameId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/games/:gameId/next-round
  router.post('/next-round', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;

      const gameRes = await pool.query(`SELECT * FROM games WHERE id = $1`, [gameId]);
      const game = gameRes.rows[0];

      const roundRes = await pool.query(
        `SELECT * FROM rounds WHERE game_id = $1 ORDER BY round_number DESC LIMIT 1`,
        [gameId]
      );
      const round = roundRes.rows[0];

      if (!round || round.status !== 'results') {
        return res.status(400).json({ error: 'Round not finished' });
      }
      if (round.question_master_id !== req.user.id && !req.user.is_admin) {
        return res.status(403).json({ error: 'Only question master can advance' });
      }

      // Check if game should end (points threshold or last round)
      let shouldFinish = false;
      if (game.end_mode === 'points' && game.target_points) {
        const topScore = await pool.query(
          `SELECT MAX(score)::int AS max FROM game_players WHERE game_id = $1`, [gameId]
        );
        if (topScore.rows[0].max >= game.target_points) shouldFinish = true;
      }
      if (!shouldFinish && game.current_round >= game.total_rounds) shouldFinish = true;

      if (shouldFinish) {
        await pool.query(`UPDATE games SET status = 'finished', finished_at = NOW() WHERE id = $1`, [gameId]);
        const scores = await pool.query(
          `SELECT u.display_name, gp.score FROM game_players gp
           JOIN users u ON gp.user_id = u.id
           WHERE gp.game_id = $1 ORDER BY gp.score DESC`,
          [gameId]
        );
        io.to(`game:${gameId}`).emit('game_finished', { scores: scores.rows });
        return res.json({ success: true, finished: true });
      }

      await pool.query(`UPDATE games SET current_round = current_round + 1 WHERE id = $1`, [gameId]);
      broadcastReload(gameId);
      res.json({ success: true, finished: false });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};

async function calculateAndAwardPoints(roundId, gameId, questionMasterId, pool) {
  // Update votes_received on the answers that actually received votes
  await pool.query(
    `UPDATE round_answers ra
     SET votes_received = (SELECT COUNT(*)::int FROM round_votes rv WHERE rv.answer_id = ra.id)
     WHERE ra.round_id = $1`,
    [roundId]
  );

  // Propagate votes_received to duplicate answers (same text, different player):
  // During voting we show MIN(id) per answer_text; the duplicate rows have votes_received=0.
  // Copy the max votes_received within each answer_text group to all rows of that group.
  await pool.query(
    `UPDATE round_answers ra
     SET votes_received = sub.max_votes
     FROM (
       SELECT answer_text, MAX(votes_received) as max_votes
       FROM round_answers
       WHERE round_id = $1 AND user_id IS NOT NULL AND is_correct = FALSE
       GROUP BY answer_text
     ) sub
     WHERE ra.round_id = $1
       AND ra.user_id IS NOT NULL
       AND ra.is_correct = FALSE
       AND ra.answer_text = sub.answer_text`,
    [roundId]
  );

  // The actual correct answer has user_id IS NULL
  const correctAnswerRes = await pool.query(
    `SELECT id FROM round_answers WHERE round_id = $1 AND is_correct = TRUE AND user_id IS NULL`, [roundId]
  );
  const correctAnswerId = correctAnswerRes.rows[0]?.id;

  const votes = await pool.query(
    `SELECT voter_id, answer_id FROM round_votes WHERE round_id = $1`, [roundId]
  );
  const correctVoters = votes.rows.filter(v => v.answer_id === correctAnswerId);

  if (correctVoters.length === 0) {
    // Nobody found correct answer → QM gets 3 pts
    await pool.query(
      `UPDATE game_players SET score = score + 3 WHERE game_id = $1 AND user_id = $2`,
      [gameId, questionMasterId]
    );
  } else {
    // Correct voters get 2 pts each
    for (const v of correctVoters) {
      await pool.query(
        `UPDATE game_players SET score = score + 2 WHERE game_id = $1 AND user_id = $2`,
        [gameId, v.voter_id]
      );
    }
  }

  // Deceptive answers: 1 pt per vote received
  const deceptive = await pool.query(
    `SELECT user_id, votes_received FROM round_answers
     WHERE round_id = $1 AND user_id IS NOT NULL AND votes_received > 0`,
    [roundId]
  );
  for (const a of deceptive.rows) {
    await pool.query(
      `UPDATE game_players SET score = score + $1 WHERE game_id = $2 AND user_id = $3`,
      [a.votes_received, gameId, a.user_id]
    );
  }
}
