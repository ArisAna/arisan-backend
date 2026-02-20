const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = function (pool, io) {
  const router = express.Router({ mergeParams: true });

  // Get personalized round state for this game + user
  async function getRoundState(gameId, userId) {
    const gameRes = await pool.query(
      `SELECT current_round, total_rounds, status FROM games WHERE id = $1`,
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

    // Answers — content depends on phase
    let answers = [];
    if (round.status === 'voting') {
      // Anonymized, no is_correct flag, deterministically shuffled
      const r = await pool.query(
        `SELECT id, answer_text FROM round_answers
         WHERE round_id = $1
         ORDER BY md5($1::text || id::text)`,
        [round.id]
      );
      answers = r.rows;
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
      correct_answer: round.status === 'results' ? round.correct_answer : undefined,
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

  // GET /api/games/:gameId/round
  router.get('/round', authenticateToken, async (req, res) => {
    try {
      const state = await getRoundState(req.params.gameId, req.user.id);
      res.json({ success: true, round: state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/games/:gameId/available-questions
  router.get('/available-questions', authenticateToken, async (req, res) => {
    try {
      const { gameId } = req.params;
      const result = await pool.query(
        `SELECT id, question_text, category FROM questions
         WHERE id NOT IN (SELECT question_id FROM rounds WHERE game_id = $1)
         ORDER BY RANDOM() LIMIT 6`,
        [gameId]
      );
      res.json({ success: true, questions: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
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

      await pool.query(
        `INSERT INTO round_answers (round_id, user_id, answer_text, is_correct)
         VALUES ($1, $2, $3, FALSE)
         ON CONFLICT (round_id, user_id) DO UPDATE SET answer_text = EXCLUDED.answer_text`,
        [round.id, req.user.id, answer_text.trim()]
      );

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

      if (game.current_round >= game.total_rounds) {
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
  // Update votes_received counts
  await pool.query(
    `UPDATE round_answers ra
     SET votes_received = (SELECT COUNT(*)::int FROM round_votes rv WHERE rv.answer_id = ra.id)
     WHERE ra.round_id = $1`,
    [roundId]
  );

  const correctAnswerRes = await pool.query(
    `SELECT id FROM round_answers WHERE round_id = $1 AND is_correct = TRUE`, [roundId]
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
