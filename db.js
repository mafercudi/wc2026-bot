const db = {
  users: {},        // { "521234567890": { name, points, predictions } }
  results: {},      // { matchId: { winner: "1"|"X"|"2", scoreHome, scoreAway } }
  trivia: {}        // { matchId: { question, options, correct } }
};
module.exports = db;
