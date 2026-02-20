const { GoogleGenerativeAI } = require('@google/generative-ai');

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

async function generateQuestionsWithGemini(existingQuestions) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const existingList = existingQuestions.length > 0
    ? `\n\nΗΔΗ ΥΠΑΡΧΟΥΝ αυτές οι ερωτήσεις στη βάση (ΜΗΝ τις επαναλάβεις):\n${existingQuestions.map(q => `- ${q.question_text}`).join('\n')}`
    : '';

  const prompt = `Δημιούργησε ακριβώς 30 ερωτήσεις trivia στα Ελληνικά. Κάθε ερώτηση πρέπει να είναι ένα ενδιαφέρον, αστείο ή εκπληκτικό fact. Μπορεί να είναι του τύπου "Τι ψήφισαν οι περισσότεροι σε δημοσκόπηση", "Ποιο ζώο...", "Πόσοι...", κλπ.

Κατηγορίες (χρησιμοποίησε ΜΟΝΟ αυτές, μοίρασέ τες ομοιόμορφα):
${CATEGORIES.join(', ')}

Η απάντηση πρέπει να είναι σύντομη (1-10 λέξεις) και μπορεί να περιλαμβάνει μια παρένθεση με extra πληροφορία.

ΣΗΜΑΝΤΙΚΟ: Απάντησε ΜΟΝΟ με valid JSON array, χωρίς markdown, χωρίς backticks, χωρίς τίποτα άλλο. Μόνο το JSON.

Format:
[{"question":"...","answer":"...","category":"..."},...]${existingList}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Clean up potential markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const questions = JSON.parse(cleaned);

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('AI returned invalid format');
  }

  return questions
    .filter(q => q.question && q.answer && q.category)
    .map(q => ({
      question: q.question,
      answer: q.answer,
      category: CATEGORIES.includes(q.category) ? q.category : null,
    }))
    .slice(0, 30);
}

module.exports = { generateQuestionsWithGemini, CATEGORIES };
