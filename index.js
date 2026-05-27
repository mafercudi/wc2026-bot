require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SHEET_URL = process.env.SHEET_URL;
const GS_KEY = process.env.GUPSHUP_APIKEY;
const GS_NUM = process.env.GUPSHUP_NUMBER;

// ─── HELPER: parsear hora local del partido ───────────────────────────────
function parseMatchTime(match) {
  // La fecha viene como "2026-06-11T06:00:00.000Z" → solo tomamos la fecha
  const dateStr = match["Fecha"].split("T")[0]; // "2026-06-11"
  // La hora viene corrupta tipo "1899-12-30T19:36:36.000Z" → extraemos HH:MM UTC
  const timeStr = match["Hora local"];
  const d = new Date(timeStr);
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  // Combinamos como UTC (la hora del sheet ya está en UTC+0 por el bug)
  return new Date(`${dateStr}T${hh}:${mm}:00.000Z`);
}

// ─── HELPER: enviar WhatsApp via Gupshup ──────────────────────────────────
async function sendWA(to, message) {
  try {
    await axios.post('https://api.gupshup.io/sm/api/v1/msg', null, {
      params: {
        channel: 'whatsapp',
        source: GS_NUM,
        destination: to,
        message: JSON.stringify({ type: 'text', text: message }),
        'src.name': 'WC2026Bot'
      },
      headers: { apikey: GS_KEY }
    });
  } catch (e) {
    console.error('WA error:', e.response?.data || e.message);
  }
}

// ─── WEBHOOK: recibe mensajes de WhatsApp ─────────────────────────────────
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  const payload = req.body;
  const phone = payload?.payload?.sender?.phone;
  const text = payload?.payload?.payload?.text?.trim().toUpperCase();
  if (!phone || !text) return;

  // Registrar usuario si es nuevo
  if (!db.users[phone]) {
    db.users[phone] = { phone, points: 0, predictions: {}, triviaAnswers: {} };
    sendWA(phone, `⚽ ¡Bienvenido al WC2026 Predictor!\n\nVas a recibir predicciones y trivia de cada partido.\n\nEscribe RANKING para ver el top 10 en cualquier momento.`);
    return;
  }

  const user = db.users[phone];

  // RANKING
  if (text === 'RANKING') {
    const sorted = Object.values(db.users)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    const list = sorted.map((u, i) => `${i + 1}. ${u.phone.slice(-4)} — ${u.points} pts`).join('\n');
    sendWA(phone, `🏆 TOP 10\n\n${list}\n\nTu posición: ${sorted.findIndex(u => u.phone === phone) + 1}`);
    return;
  }

  // Respuesta a predicción pendiente
  if (user.pendingPrediction && ['1', 'X', '2'].includes(text)) {
    const matchId = user.pendingPrediction;
    user.predictions[matchId] = text;
    delete user.pendingPrediction;
    const labels = { '1': 'el primer equipo', 'X': 'empate', '2': 'el segundo equipo' };
    sendWA(phone, `✅ Predicción guardada: ${labels[text]}\n\nTe avisaré cuando termine el partido. ¡Suerte! 🤞`);
    return;
  }

  // Respuesta a trivia pendiente
  if (user.pendingTrivia && ['A', 'B', 'C'].includes(text)) {
    const { matchId, correct } = user.pendingTrivia;
    delete user.pendingTrivia;
    if (text === correct) {
      user.points += 20;
      sendWA(phone, `✅ ¡Correcto! +20 puntos\nTu total: ${user.points} pts 🔥`);
    } else {
      sendWA(phone, `❌ Era la opción ${correct}. ¡Sigue intentando!\nTu total: ${user.points} pts`);
    }
    return;
  }

  sendWA(phone, `⚽ Escribe RANKING para ver el top 10.\nEspera el próximo partido para participar.`);
});

// ─── ADMIN: enviar predicción manualmente ────────────────────────────────
app.post('/admin/send-prediction/:matchId', async (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const matches = await axios.get(SHEET_URL).then(r => r.data);
  const match = matches.find(m => m['#'] === matchId);
  if (!match) return res.status(404).json({ error: 'Partido no encontrado' });

  const [home, away] = match.Partido.split(' vs ');
  const msg = `🏆 Próximo partido:\n*${match.Partido}*\n📍 ${match.Ciudad}\n\n¿Quién gana?\n1️⃣ ${home}\n✌️ Empate\n2️⃣ ${away}\n\nResponde: 1, X o 2`;

  let sent = 0;
  for (const phone of Object.keys(db.users)) {
    db.users[phone].pendingPrediction = matchId;
    await sendWA(phone, msg);
    sent++;
  }
  res.json({ ok: true, sent, match: match.Partido });
});

// ─── ADMIN: enviar trivia manualmente ────────────────────────────────────
app.post('/admin/send-trivia/:matchId', async (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const { question, a, b, c, correct } = req.body; // correct = "A"|"B"|"C"

  const msg = `⚽ TRIVIA:\n\n${question}\n\nA) ${a}\nB) ${b}\nC) ${c}\n\nResponde: A, B o C`;

  let sent = 0;
  for (const phone of Object.keys(db.users)) {
    db.users[phone].pendingTrivia = { matchId, correct };
    await sendWA(phone, msg);
    sent++;
  }
  res.json({ ok: true, sent });
});

// ─── ADMIN: ingresar resultado y resolver predicciones ───────────────────
app.post('/admin/result/:matchId', async (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const { winner } = req.body; // "1", "X" o "2"
  db.results[matchId] = winner;

  const matches = await axios.get(SHEET_URL).then(r => r.data);
  const match = matches.find(m => m['#'] === matchId);
  const [home, away] = match.Partido.split(' vs ');
  const labels = { '1': home, 'X': 'Empate', '2': away };

  let correct = 0, wrong = 0;
  for (const user of Object.values(db.users)) {
    const pred = user.predictions[matchId];
    if (!pred) continue;
    if (pred === winner) {
      user.points += 50;
      correct++;
      sendWA(user.phone, `🎉 ¡Acertaste! Resultado: ${labels[winner]}\n+50 puntos. Tu total: ${user.points} pts 🏅\n\nEscribe RANKING para ver tu posición.`);
    } else {
      wrong++;
      sendWA(user.phone, `😔 Resultado: ${labels[winner]}. Esta vez no fue.\nTu total: ${user.points} pts\n\nEscribe RANKING para ver tu posición.`);
    }
  }
  res.json({ ok: true, correct, wrong, winner: labels[winner] });
});

// ─── ADMIN: ver estado ────────────────────────────────────────────────────
app.get('/admin/status', (req, res) => {
  const users = Object.values(db.users).map(u => ({
    phone: u.phone,
    points: u.points,
    predictions: Object.keys(u.predictions).length
  })).sort((a, b) => b.points - a.points);
  res.json({ totalUsers: users.length, users });
});

app.get('/', (req, res) => res.json({ status: 'WC2026 Bot running ✅' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
