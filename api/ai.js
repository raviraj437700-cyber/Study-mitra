export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tested & Working Gemini Models
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash'
];

async function gemini(parts, json) {
  let lastError = 'AI se jawab nahi aaya';

  for (const model of MODELS) {
    const URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = { contents: [{ parts }] };
        if (json) {
          body.generationConfig = { responseMimeType: 'application/json' };
        }

        const r = await fetch(URL, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            'x-goog-api-key': process.env.GEMINI_API_KEY 
          },
          body: JSON.stringify(body)
        });

        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('');

        if (text) return { text };

        lastError = data?.error?.message || `Status ${r.status}`;
        if (![429, 500, 503].includes(r.status)) break;
      } catch (e) {
        lastError = e.message || 'Server error';
      }
      await sleep(1500 * (attempt + 1));
    }
  }

  return { error: 'AI abhi busy hai, 1-2 minute baad dobara try karo. 🙏\n\n(' + lastError + ')' };
}

const parseJSON = (t) => JSON.parse(t.replace(/```json|```/g, '').trim());

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY missing! Vercel Environment Variable me set karein.' });
  }

  const b = req.body || {};
  const LANG = ['Hinglish', 'Hindi', 'English'].includes(b.lang) ? b.lang : 'Hinglish';
  const bad = (msg) => res.status(400).json({ error: msg });

  /* ---------- ROADMAP ---------- */
  if (b.mode === 'roadmap') {
    const { name, days, hours, subjects } = b;
    if (!days || !hours || !Array.isArray(subjects) || !subjects.length) return bad('Data adhoora hai');
    
    const list = subjects.slice(0, 12).map(s => `- ${String(s.name).slice(0, 40)}: ${Number(s.chapters)} chapters`).join('\n');
    const total = subjects.reduce((a, s) => a + (Number(s.chapters) || 0), 0);
    
    const prompt = `Tum ek expert study planner ho. Student ka naam: ${String(name || 'Student').slice(0, 40)}.
Exam me bache din: ${Number(days)}. Roz padhne ke ghante: ${Number(hours)}.
Subjects:
${list}
Total chapters: ${total}. Total available hours: ${Number(days) * Number(hours)}.

Hinglish me ek practical roadmap banao:
1. Short summary: total time, har subject ko kitna time
2. Plan: din-wise ya week-wise plan
3. Revision & Mock Test advice
4. 4-5 practical tips. Markdown tables mat use karo.`;

    const out = await gemini([{ text: prompt }], false);
    return out.text ? res.status(200).json(out) : res.status(500).json(out);
  }

  /* ---------- FLASHCARDS / QUIZ / SUMMARY ---------- */
  if (['flashcards', 'quiz', 'summary'].includes(b.mode)) {
    if (!b.pdf) return bad('PDF nahi mila');
    const pdfPart = { inline_data: { mime_type: 'application/pdf', data: b.pdf } };

    if (b.mode === 'flashcards') {
      const n = Math.min(80, Math.max(5, parseInt(b.count) || 15));
      const prompt = `Is chapter ke PDF se ${n} flashcards banao. Bhasha: ${LANG}.
Sirf JSON array do: [{"q":"sawal","a":"jawab"}]`;

      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (!out.text) return res.status(500).json(out);

      try {
        const cards = parseJSON(out.text).filter(c => c && c.q && c.a);
        return res.status(200).json({ cards });
      } catch (e) {
        return res.status(500).json({ error: 'Flashcards format error.' });
      }
    }

    if (b.mode === 'quiz') {
      const n = Math.min(30, Math.max(5, parseInt(b.count) || 10));
      const level = b.level || 'Medium';
      const prompt = `Is chapter ke PDF se ${n} MCQ sawal banao. Bhasha: ${LANG}. Difficulty: ${level}.
Sirf JSON array do: [{"q":"sawal","o":["opt1","opt2","opt3","opt4"],"a":0,"why":"explanation"}]`;

      const out = await gemini([{ text: prompt }, pdfPart], true);
      if (!out.text) return res.status(500).json(out);

      try {
        const quiz = parseJSON(out.text).filter(q => q && q.q && Array.isArray(q.o) && q.o.length === 4);
        return res.status(200).json({ quiz });
      } catch (e) {
        return res.status(500).json({ error: 'Quiz format error.' });
      }
    }

    if (b.mode === 'summary') {
      const style = b.smode === 'short' ? 'Short summary' : '5-minute revision notes with headings and bullet points.';
      const prompt = `Is chapter ke PDF ko padho. ${style} Bhasha: ${LANG}. Markdown tables mat use karo.`;

      const out = await gemini([{ text: prompt }, pdfPart], false);
      return out.text ? res.status(200).json(out) : res.status(500).json(out);
    }
  }

  /* ---------- DOUBT SOLVER ---------- */
  if (b.mode === 'doubt') {
    const images = Array.isArray(b.images) ? b.images.slice(0, 3) : [];
    const text = String(b.text || '').slice(0, 1500);
    if (!images.length && !text.trim()) return bad('Photo ya question daalo');

    const prompt = `Tum ek teacher ho. Question solve karo. ${text ? 'Text: ' + text : ''}
Format: ## Question, ## Steps, ## Final Answer, ## Trick. Bhasha: ${LANG}.`;

    const parts = [{ text: prompt }, ...images.map(d => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))];
    const out = await gemini(parts, false);
    return out.text ? res.status(200).json(out) : res.status(500).json(out);
  }

  return bad('Galat request');
                                            }
                             
