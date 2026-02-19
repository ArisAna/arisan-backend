const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

// Fixed category list
const CATEGORIES = [
  'Ιστορία',
  'Επιστήμη',
  'Γεωγραφία',
  'Αθλητικά',
  'Διασκέδαση',
  'Φαγητό & Ποτό',
  'Ζώα & Φύση',
  'Τέχνη & Πολιτισμός',
  'Περίεργα Στατιστικά',
  'WTF Facts',
];

// Seed sets - each call adds the next batch
const SEED_SETS = [
  // Set 1 (30 questions)
  [
    { question: "Ποιο ζώο δεν μπορεί να πηδήξει;", answer: "Ο ελέφαντας", category: "Ζώα & Φύση" },
    { question: "Πόσα χρόνια κοιμάται μια γάτα στη ζωή της κατά μέσο όρο;", answer: "Περίπου 15 χρόνια (70% της ζωής της)", category: "Ζώα & Φύση" },
    { question: "Ποια χώρα έχει περισσότερες πυραμίδες από την Αίγυπτο;", answer: "Το Σουδάν", category: "Γεωγραφία" },
    { question: "Τι χρώμα είναι ο ιδρώτας του ιπποπόταμου;", answer: "Ροζ/κόκκινο", category: "Ζώα & Φύση" },
    { question: "Ποιο είναι το εθνικό ζώο της Σκωτίας;", answer: "Ο μονόκερος", category: "Περίεργα Στατιστικά" },
    { question: "Πόσο διαρκεί η μνήμη ενός χρυσόψαρου;", answer: "Τουλάχιστον 5 μήνες (όχι 3 δευτερόλεπτα!)", category: "Ζώα & Φύση" },
    { question: "Ποιο φρούτο είναι τεχνικά μούρο: η φράουλα ή η μπανάνα;", answer: "Η μπανάνα", category: "Επιστήμη" },
    { question: "Σε ποια χώρα βρίσκεται η μεγαλύτερη έρημος του κόσμου;", answer: "Ανταρκτική (η μεγαλύτερη έρημος δεν είναι η Σαχάρα!)", category: "Γεωγραφία" },
    { question: "Πόσα στομάχια έχει μια αγελάδα;", answer: "4", category: "Ζώα & Φύση" },
    { question: "Ποιος Έλληνας φιλόσοφος πέθανε κρατώντας την αναπνοή του;", answer: "Ο Διογένης (σύμφωνα με τον θρύλο)", category: "Ιστορία" },
    { question: "Τι ποσοστό του DNA μας μοιραζόμαστε με τις μπανάνες;", answer: "Περίπου 60%", category: "Επιστήμη" },
    { question: "Ποιο ήταν το αρχικό χρώμα των καρότων;", answer: "Μωβ", category: "Φαγητό & Ποτό" },
    { question: "Πόσες φορές χτυπάει η καρδιά ενός κολιβρίου το λεπτό;", answer: "Πάνω από 1.200", category: "Ζώα & Φύση" },
    { question: "Ποια πόλη χτίστηκε πάνω σε 14 νησιά;", answer: "Η Στοκχόλμη", category: "Γεωγραφία" },
    { question: "Τι απαγορεύεται να κάνεις στη Βενετία σύμφωνα με τοπικό νόμο;", answer: "Να ταΐζεις τα περιστέρια", category: "WTF Facts" },
    { question: "Πόσα αστέρια υπάρχουν στο γαλαξία μας κατά προσέγγιση;", answer: "100-400 δισεκατομμύρια", category: "Επιστήμη" },
    { question: "Ποιο ποτό ανακαλύφθηκε κατά λάθος από μοναχούς;", answer: "Η σαμπάνια", category: "Φαγητό & Ποτό" },
    { question: "Σε δημοσκόπηση, τι απάντησαν οι περισσότεροι ότι φοβούνται περισσότερο: τα φίδια ή τις δημόσιες ομιλίες;", answer: "Τις δημόσιες ομιλίες", category: "Περίεργα Στατιστικά" },
    { question: "Ποιο μέρος του σώματος συνεχίζει να μεγαλώνει σε όλη τη ζωή μας;", answer: "Η μύτη και τα αυτιά", category: "Επιστήμη" },
    { question: "Ποια χώρα κατανάλωνε τα περισσότερα donuts ανά κάτοικο;", answer: "Ο Καναδάς", category: "Φαγητό & Ποτό" },
    { question: "Πόσο χρονών ήταν ο νεότερος Ολυμπιονίκης;", answer: "10 ετών (Δημήτριος Λούνδρας, Αθήνα 1896)", category: "Αθλητικά" },
    { question: "Ποιο είναι το πιο κλεμμένο φαγητό στον κόσμο;", answer: "Το τυρί", category: "WTF Facts" },
    { question: "Τι ποσοστό του ωκεανού έχει εξερευνηθεί;", answer: "Μόλις 5%", category: "Επιστήμη" },
    { question: "Ποιος ζωγράφος έκοψε το αυτί του;", answer: "Ο Βαν Γκογκ", category: "Τέχνη & Πολιτισμός" },
    { question: "Πόσες γλώσσες ομιλούνται στην Παπούα Νέα Γουινέα;", answer: "Πάνω από 800", category: "Γεωγραφία" },
    { question: "Ποιο ήταν το πρώτο φαγητό που θερμάνθηκε σε φούρνο μικροκυμάτων;", answer: "Ποπ κορν", category: "Φαγητό & Ποτό" },
    { question: "Σε δημοσκόπηση, ποια μέρα της εβδομάδας θεωρείται η πιο παραγωγική;", answer: "Η Τρίτη", category: "Περίεργα Στατιστικά" },
    { question: "Ποιο ζώο μπορεί να κοιμηθεί ως 3 χρόνια;", answer: "Το σαλιγκάρι", category: "Ζώα & Φύση" },
    { question: "Ποιος εφηύρε το ψαλίδι;", answer: "Ο Λεονάρντο ντα Βίντσι", category: "Ιστορία" },
    { question: "Τι ποσοστό των ανθρώπων σε έρευνα δήλωσε ότι μιλάει στο κατοικίδιό του;", answer: "Πάνω από 80%", category: "Περίεργα Στατιστικά" },
  ],
  // Set 2 (30 more questions)
  [
    { question: "Πόσα λίτρα σάλιο παράγει ένας άνθρωπος στη ζωή του;", answer: "Περίπου 35.000 λίτρα", category: "Επιστήμη" },
    { question: "Ποιο ζώο δεν μπορεί να κάνει εμετό;", answer: "Τα κουνέλια", category: "Ζώα & Φύση" },
    { question: "Ποια ομάδα κέρδισε το πρώτο Παγκόσμιο Κύπελλο ποδοσφαίρου;", answer: "Η Ουρουγουάη (1930)", category: "Αθλητικά" },
    { question: "Ποιο χρώμα δεν υπάρχει στις σημαίες κανενός κράτους;", answer: "Το μωβ", category: "Περίεργα Στατιστικά" },
    { question: "Πόσο ζυγίζει κατά μέσο όρο ένα σύννεφο;", answer: "Περίπου 500 τόνους", category: "Επιστήμη" },
    { question: "Ποια ελληνική λέξη χρησιμοποιείται παγκοσμίως χωρίς μετάφραση;", answer: "Ευρήκα (ή Μούσα, Νέμεσις κ.λπ.)", category: "Τέχνη & Πολιτισμός" },
    { question: "Σε ποια χώρα ήταν παράνομο να μασάς τσίχλα μέχρι πρόσφατα;", answer: "Σιγκαπούρη", category: "WTF Facts" },
    { question: "Πόσα ποδήλατα βρίσκονται στον πάτο των καναλιών του Άμστερνταμ;", answer: "Περίπου 15.000 τον χρόνο", category: "WTF Facts" },
    { question: "Ποιο φρούτο μπορεί να ωριμάσει μπανάνες πιο γρήγορα αν τα βάλεις δίπλα;", answer: "Το μήλο", category: "Φαγητό & Ποτό" },
    { question: "Πόσες φορές τη μέρα γελάει ένα παιδί κατά μέσο όρο;", answer: "Περίπου 300 (ενώ ενήλικας μόνο 15-20)", category: "Περίεργα Στατιστικά" },
    { question: "Ποιος πλανήτης στο ηλιακό μας σύστημα περιστρέφεται ανάποδα;", answer: "Η Αφροδίτη", category: "Επιστήμη" },
    { question: "Ποιο ήταν το πιο σύντομο πόλεμο στην ιστορία;", answer: "Ο πόλεμος Αγγλίας-Ζανζιβάρης (38-45 λεπτά)", category: "Ιστορία" },
    { question: "Τι ποσοστό της γης καλύπτεται από νερό;", answer: "Περίπου 71%", category: "Γεωγραφία" },
    { question: "Ποιο είναι το δημοφιλέστερο κατοικίδιο στην Ελλάδα;", answer: "Η γάτα", category: "Ζώα & Φύση" },
    { question: "Πόσες ώρες κοιμάται ένα κοάλα την ημέρα;", answer: "18-22 ώρες", category: "Ζώα & Φύση" },
    { question: "Ποιο φαγητό αντέχει χιλιάδες χρόνια χωρίς να χαλάσει;", answer: "Το μέλι", category: "Φαγητό & Ποτό" },
    { question: "Ποια πόλη ονομάζεται 'η πόλη που δεν κοιμάται ποτέ';", answer: "Η Νέα Υόρκη", category: "Γεωγραφία" },
    { question: "Ποιο σπορ παίζεται στο φεγγάρι;", answer: "Γκολφ (ο Άλαν Σέπαρντ έπαιξε το 1971)", category: "Αθλητικά" },
    { question: "Σε δημοσκόπηση, τι φοβούνται οι περισσότεροι περισσότερο στο αεροπλάνο;", answer: "Τις αναταράξεις (όχι τη συντριβή)", category: "Περίεργα Στατιστικά" },
    { question: "Ποια ήταν η πρώτη χώρα που έδωσε δικαίωμα ψήφου στις γυναίκες;", answer: "Η Νέα Ζηλανδία (1893)", category: "Ιστορία" },
    { question: "Πόσα εκατομμύρια βακτήρια ζουν σε ένα τετραγωνικό εκατοστό δέρματος;", answer: "Περίπου 6 εκατομμύρια", category: "Επιστήμη" },
    { question: "Ποιο είναι το αρχαιότερο εστιατόριο στον κόσμο;", answer: "Το Sobrino de Botín στη Μαδρίτη (από το 1725)", category: "Φαγητό & Ποτό" },
    { question: "Σε ποια χώρα υπάρχει νόμος που απαγορεύει να πεθάνεις στο κοινοβούλιο;", answer: "Αγγλία", category: "WTF Facts" },
    { question: "Ποιο ήταν το πρώτο βιντεοπαιχνίδι που παίχτηκε στο διάστημα;", answer: "Tetris", category: "Διασκέδαση" },
    { question: "Πόσα δέντρα κόβονται κάθε μέρα παγκοσμίως;", answer: "Περίπου 3,5 εκατομμύρια", category: "Ζώα & Φύση" },
    { question: "Ποιο τραγούδι ήταν το πρώτο που παίχτηκε στον Άρη;", answer: "\"Reach for the Stars\" - will.i.am (2012)", category: "Διασκέδαση" },
    { question: "Σε ποιο ελληνικό νησί απαγορεύονται τα ψηλοτάκουνα σε αρχαιολογικούς χώρους;", answer: "Σε όλη την Ελλάδα (νόμος 2009)", category: "WTF Facts" },
    { question: "Πόσες μυρωδιές μπορεί να αναγνωρίσει η ανθρώπινη μύτη;", answer: "Πάνω από 1 τρισεκατομμύριο", category: "Επιστήμη" },
    { question: "Ποια χώρα έχει τις περισσότερες αργίες στον κόσμο;", answer: "Η Ινδία (με πάνω από 30)", category: "Περίεργα Στατιστικά" },
    { question: "Ποιο είναι το μακρύτερο ελληνικό τοπωνύμιο;", answer: "Παναγία Φανερωμένη Μηχανιώνας (ή παρόμοια μακρά ονομασία)", category: "Τέχνη & Πολιτισμός" },
  ],
];

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

  // POST /api/questions/seed - seed next batch of questions (admin only)
  router.post('/seed', authenticateToken, requireAdmin, async (req, res) => {
    try {
      let totalInserted = 0;

      for (const seedSet of SEED_SETS) {
        for (const q of seedSet) {
          const existing = await pool.query(
            'SELECT id FROM questions WHERE question_text = $1',
            [q.question]
          );
          if (existing.rows.length === 0) {
            await pool.query(
              'INSERT INTO questions (question_text, correct_answer, category, created_by) VALUES ($1, $2, $3, $4)',
              [q.question, q.answer, q.category, req.user.id]
            );
            totalInserted++;
          }
        }
      }

      const total = SEED_SETS.reduce((sum, set) => sum + set.length, 0);
      res.json({
        success: true,
        message: `Προστέθηκαν ${totalInserted} νέες ερωτήσεις (${total - totalInserted} υπήρχαν ήδη)`,
      });
    } catch (err) {
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
