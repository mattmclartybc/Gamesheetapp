// Downloads finished PCAHA A and PCEHL games from Spordle (the data the game
// sheet PDFs are printed from) and saves scores, starting goalies and goals to
// stats/data.json. Run hourly by .github/workflows/stats.yml; the Google Sheet
// reads the file from GitHub.
import fs from 'node:fs';

const API = 'https://pub-api.play.spordle.com/api/sp';
const API_KEY = 'f08ed9064e3cdc382e6abb305ff543d0150fb52f'; // public, read-only key published by page.spordle.com
const LEAGUES = [
  { name: 'PCAHA A', officeId: 786 },
  { name: 'PCEHL', officeId: 8585 },
];
const OUT = process.env.STATS_OUT || 'stats/data.json';
const PARALLEL = 6;

// Row layouts (the Google Sheet uses the same columns):
// game: [Game ID, Date, Division, Schedule, Stage, Home Team, Home Score, Home Starting Goalie,
//        Away Team, Away Score, Away Starting Goalie, Notes]
// goal: [Game ID, Date, Division, Schedule, Stage, Team, Goal Scorer, Primary Assist,
//        Secondary Assist, Period, Time, Type]

async function api(path, filter) {
  let url = API + path;
  if (filter) url += (path.includes('?') ? '&' : '?') + 'filter=' + encodeURIComponent(JSON.stringify(filter));
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: 'API-Key ' + API_KEY, Accept: 'application/json' } });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) { last = String(e); }
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`Spordle request failed: ${path} (${last})`);
}

async function inPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const teamLabel = t => t ? (t.shortName || t.name) : 'TBA';
const elapsed = t => t ? (parseInt(t.period, 10) || 9) * 10000 + (t.elapsedMinutes || 0) * 60 + (t.elapsedSeconds || 0) : 0;
const clock = t => `${t.minutes}:${String(t.seconds || 0).padStart(2, '0')}`;
function person(name) {
  if (!name) return '';
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase()
    .replace(/(^|[\s\-'’])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\bMc([a-z])/g, (m, c) => 'Mc' + c.toUpperCase());
}

function buildGame(g, box, lineups) {
  const teamName = id => id === g.homeTeamId ? teamLabel(g.homeTeam) : id === g.awayTeamId ? teamLabel(g.awayTeam) : String(id);
  const notes = [];
  // Starting goalie: the one marked "S"; if none is marked and only one goalie dressed, assume it's that one.
  const starter = teamId => {
    const goalies = (lineups[teamId] || []).filter(p => (p.positions || []).includes('G'));
    const s = goalies.find(p => p.isStarter) || (goalies.length === 1 ? goalies[0] : null);
    if (!s) notes.push(goalies.length ? `${teamName(teamId)}: ${goalies.length} goalies, none marked as starter`
      : `${teamName(teamId)}: no goalie listed`);
    return s ? person(s.participant && s.participant.fullName) : '';
  };
  const homeGoalie = starter(g.homeTeamId);
  const awayGoalie = starter(g.awayTeamId);
  const homeScore = g.score[g.homeTeamId], awayScore = g.score[g.awayTeamId];

  const counted = {};
  const goalRows = (box.goals || []).slice().sort((a, b) => elapsed(a.gameTime) - elapsed(b.gameTime)).map(x => {
    counted[x.teamId] = (counted[x.teamId] || 0) + 1;
    const a = x.assists || [];
    const type = [x.isPowerplay && 'PP', x.isShorthanded && 'SH', x.isEmptyNet && 'EN', x.isPenaltyShot && 'PS', x.isOwnGoal && 'Own goal']
      .filter(Boolean).join(' ');
    return [g.id, g.date, g._division, g._schedule, g._stage, teamName(x.teamId),
      person(x.participant && x.participant.fullName), person(a[0] && a[0].fullName), person(a[1] && a[1].fullName),
      x.gameTime ? String(x.gameTime.period) : '', x.gameTime ? clock(x.gameTime) : '', type];
  });
  if ((counted[g.homeTeamId] || 0) !== homeScore || (counted[g.awayTeamId] || 0) !== awayScore)
    notes.push(`Goal list (${counted[g.awayTeamId] || 0}-${counted[g.homeTeamId] || 0}) doesn't match final score (${awayScore}-${homeScore})`);
  if ((box.shootout || []).length) notes.push('Decided by shootout');

  return {
    gameRow: [g.id, g.date, g._division, g._schedule, g._stage, teamLabel(g.homeTeam), homeScore, homeGoalie,
      teamLabel(g.awayTeam), awayScore, awayGoalie, notes.join('; ')],
    goalRows,
  };
}

async function updateLeague(lg, prev) {
  const seasons = await api(`/seasons?officeId=${lg.officeId}`);
  const season = (seasons.find(s => s.isCurrent) || seasons[0]).seasonId;
  if (!prev || prev.season !== season) prev = { games: [], goals: [] }; // new season: start fresh

  const divisions = {};
  (await api(`/categories?officeId=${lg.officeId}&seasonId=${season}`)).forEach(c => divisions[c.id] = c.name);
  const schedules = await api(`/schedules?officeId=${lg.officeId}&seasonId=${season}`);
  let games = [];
  for (const s of schedules) {
    const list = await api('/games', { where: { scheduleId: { inq: [s.id] } }, include: ['homeTeam', 'awayTeam'], order: ['startTime ASC'] });
    list.forEach(g => { g._schedule = s.name; g._stage = s.type || ''; g._division = divisions[g.categoryId] || g.division || ''; });
    games = games.concat(list);
  }

  const now = Date.now();
  const hasScore = g => g.score && Object.keys(g.score).length === 2;
  const played = games.filter(g => g.status === 'Active' && new Date(g.startTime).getTime() < now && hasScore(g));
  const pending = games
    .filter(g => g.status === 'Active' && !hasScore(g) && new Date(g.startTime).getTime() < now - 2 * 864e5)
    .map(g => [g.id, g.date, g._division, `${teamLabel(g.awayTeam)} @ ${teamLabel(g.homeTeam)}`]);

  const have = new Set(prev.games.map(r => r[0]));
  const todo = played.filter(g => !have.has(g.id));
  const built = await inPool(todo, PARALLEL, async g => {
    try {
      const [box, lineups] = await Promise.all([api(`/games/${g.id}/boxScore`), api(`/games/${g.id}/lineups`)]);
      return buildGame(g, box, lineups);
    } catch (e) { console.warn(`  skipped game ${g.id}: ${e.message}`); return null; } // retried next run
  });

  const order = (a, b) => String(a[1]).localeCompare(String(b[1])) || a[0] - b[0];
  const added = built.filter(Boolean);
  const out = {
    season,
    games: prev.games.concat(added.map(x => x.gameRow)).sort(order),
    goals: prev.goals.concat(added.flatMap(x => x.goalRows)).sort(order), // stable sort keeps goals in game order
    pending,
  };
  console.log(`${lg.name} ${season}: ${played.length} played games, ${added.length} new, ${out.games.length} saved, ${pending.length} waiting for a score`);
  return out;
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { leagues: {} };
const data = { updated: new Date().toISOString(), leagues: {} };
for (const lg of LEAGUES) data.leagues[lg.name] = await updateLeague(lg, prev.leagues && prev.leagues[lg.name]);
// Only rewrite the file when something changed, so the workflow doesn't commit every hour.
if (JSON.stringify(data.leagues) !== JSON.stringify(prev.leagues)) {
  fs.writeFileSync(OUT, JSON.stringify(data));
  console.log('Saved ' + OUT);
} else {
  console.log('No changes');
}
