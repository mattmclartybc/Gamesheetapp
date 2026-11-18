// Downloads finished PCAHA A and PCEHL games from Spordle (the data the game
// sheet PDFs are printed from) and saves scores, starting goalies, goals,
// penalties and lineups to stats/data.json, plus player and goalie stats for
// the web app to stats/stats.json. Besides the leagues' own schedules it picks
// up every other game the league's teams play (tournaments, exhibitions hosted
// by associations, other leagues), found by team. Run hourly by .github/workflows/stats.yml; the Google Sheet
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
const DATA_VERSION = 3; // bump when the saved fields change, to re-download everything once

// Penalty minutes charged to the player, matching Spordle's own PIM totals.
const PENALTY_MINUTES = { 'Minor': 2, 'Double Minor': 4, 'Major': 5, 'Misconduct': 10, 'Game Misconduct': 10,
  'Gross Misconduct': 10, 'Match': 5, 'Penalty Shot': 0 };

// Row layouts (the Google Sheet uses the same columns):
// game: [Game ID, Date, Division, Schedule, Stage, Home Team, Home Score, Home Starting Goalie,
//        Away Team, Away Score, Away Starting Goalie, Notes]
// goal: [Game ID, Date, Division, Schedule, Stage, Team, Goal Scorer, Primary Assist,
//        Secondary Assist, Period, Time, Type]
// penalty: [Game ID, Date, Division, Schedule, Stage, Team, Player, Infraction, Penalty, Minutes]
// lineups: { "<Game ID>": [[Team, Player, Position], ...] } – everyone who dressed
// teams: names of the league's own teams (stats are only kept for these)
//
// Stage, used to filter stats: Regular season, Placement, Exhibition, Playoffs,
// Tournament (league or outside tournaments), Other (any other outside game).
function stageOf(schedule, outside) {
  const type = (schedule && schedule.type) || '';
  if (type === 'Tournament' || (outside && /tournament|classic|cup|showdown|jamboree/i.test(schedule && schedule.name || ''))) return 'Tournament';
  if (outside) return 'Other';
  if (type === 'League') return 'Regular season';
  if (/playoff/i.test(type)) return 'Playoffs';
  return type || 'Other';
}
// Lineups also list team staff (Head Coach, Assistant Coach, Manager, Safety Person...);
// only these positions are players.
const PLAYER_POSITIONS = ['F', 'D', 'G', 'C', 'LW', 'RW', 'W'];
const isPlayer = pos => String(pos || '').split('/').some(x => PLAYER_POSITIONS.includes(x.trim()));
const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s\-'&(])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  .replace(/\b(Mha|Aa|Viaha|Omaha|U\d+)\b/gi, m => m.toUpperCase());

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
  if (!name || /^\s*unknown\s*$/i.test(name)) return ''; // out-of-district teams sometimes list players as "Unknown"
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

  const penaltyRows = (box.penalties || []).slice().sort((a, b) => elapsed(a.gameTime) - elapsed(b.gameTime)).map(x => {
    const kind = (x.duration && x.duration.name) || '';
    let minutes = x.isBenchPenalty ? 0 : PENALTY_MINUTES[kind];
    if (minutes === undefined) { minutes = 0; notes.push(`Unknown penalty type "${kind}" counted as 0 minutes`); }
    return [g.id, g.date, g._division, g._schedule, g._stage, teamName(x.teamId),
      person(x.participant && x.participant.fullName), x.infraction || '',
      kind + (x.isBenchPenalty ? ' (bench, served)' : ''), minutes];
  });

  const lineupRows = [];
  for (const teamId of [g.homeTeamId, g.awayTeamId]) {
    for (const p of lineups[teamId] || []) {
      if (p.isReleased || p.suspension) continue; // not playing this game
      if (!isPlayer((p.positions || []).join('/'))) continue; // team staff
      const name = person(p.participant && p.participant.fullName);
      if (name) lineupRows.push([teamName(teamId), name, (p.positions || []).join('/')]);
    }
  }

  return {
    gameRow: [g.id, g.date, g._division, g._schedule, g._stage, teamLabel(g.homeTeam), homeScore, homeGoalie,
      teamLabel(g.awayTeam), awayScore, awayGoalie, notes.join('; ')],
    goalRows,
    penaltyRows,
    lineupRows,
  };
}

async function updateLeague(lg, prev) {
  const seasons = await api(`/seasons?officeId=${lg.officeId}`);
  const season = (seasons.find(s => s.isCurrent) || seasons[0]).seasonId;
  if (!prev || prev.season !== season || prev.version !== DATA_VERSION)
    prev = { games: [], goals: [], penalties: [], lineups: {} }; // new season or new fields: start fresh

  const divisions = {};
  (await api(`/categories?officeId=${lg.officeId}&seasonId=${season}`)).forEach(c => divisions[c.id] = c.name);
  const schedules = await api(`/schedules?officeId=${lg.officeId}&seasonId=${season}`);
  let games = [];
  for (const s of schedules) {
    const list = await api('/games', { where: { scheduleId: { inq: [s.id] } }, include: ['homeTeam', 'awayTeam'], order: ['startTime ASC'] });
    list.forEach(g => { g._schedule = s.name; g._stage = stageOf(s, false); g._type = s.type; g._division = divisions[g.categoryId] || g.division || ''; });
    games = games.concat(list);
  }

  // The league's own teams: everyone in its League/Placement schedules (its tournament
  // schedules include visiting teams). Early in the season, fall back to non-tournament schedules.
  const memberIds = new Map();
  const collect = list => list.forEach(g => [g.homeTeam, g.awayTeam].forEach(t => {
    if (t && t.id && !/^tba$|non-district/i.test(t.name || '')) memberIds.set(t.id, t);
  }));
  collect(games.filter(g => g._type === 'League' || g._type === 'Placement'));
  if (!memberIds.size) collect(games.filter(g => g._type !== 'Tournament'));

  // Every other game those teams play this season, wherever it was scheduled.
  const leagueSchedules = new Set(schedules.map(s => s.id));
  const ids = [...memberIds.keys()];
  const outside = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const list = await api('/games', { where: { and: [{ seasonId: season }, { or: [{ homeTeamId: { inq: part } }, { awayTeamId: { inq: part } }] }] }, include: ['homeTeam', 'awayTeam'] });
    list.forEach(g => { if (!leagueSchedules.has(g.scheduleId)) outside.set(g.id, g); });
  }
  if (outside.size) {
    const hostIds = [...new Set([...outside.values()].map(g => g.officeId))];
    const hosts = {};
    (await api('/offices', { where: { id: { inq: hostIds } } })).forEach(o => hosts[o.id] = o);
    const hostSchedules = {};
    await inPool(hostIds, PARALLEL, async id => {
      try { (await api(`/schedules?officeId=${id}&seasonId=${season}`)).forEach(s => hostSchedules[s.id] = s); } catch (e) { /* name unknown */ }
    });
    for (const g of outside.values()) {
      const s = hostSchedules[g.scheduleId];
      const host = hosts[g.officeId] ? titleCase(hosts[g.officeId].name) : 'Other';
      const ours = memberIds.has(g.homeTeamId) ? g.homeTeam : g.awayTeam; // the division is our team's
      g._schedule = s ? `${s.name.trim()} (${host})` : host;
      g._stage = stageOf(s || { name: host, type: hosts[g.officeId] && hosts[g.officeId].type }, true);
      g._division = divisions[ours && ours.categoryId] || divisions[g.categoryId] || (ours && ours.division) || g.division || '';
      games.push(g);
    }
  }

  const now = Date.now();
  const hasScore = g => g.score && Object.keys(g.score).length === 2;
  const played = games.filter(g => g.status === 'Active' && new Date(g.startTime).getTime() < now && hasScore(g));
  const pending = games // league games only; outside hosts don't always enter scores
    .filter(g => g._type && g.status === 'Active' && !hasScore(g) && new Date(g.startTime).getTime() < now - 2 * 864e5)
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
  const lineups = {};
  for (const id in prev.lineups) lineups[id] = prev.lineups[id].filter(r => isPlayer(r[2])); // drops staff saved by older versions
  added.forEach(x => { lineups[x.gameRow[0]] = x.lineupRows; });
  const out = {
    version: DATA_VERSION,
    season,
    games: prev.games.concat(added.map(x => x.gameRow)).sort(order),
    goals: prev.goals.concat(added.flatMap(x => x.goalRows)).sort(order), // stable sort keeps goals in game order
    penalties: prev.penalties.concat(added.flatMap(x => x.penaltyRows)).sort(order),
    lineups,
    pending,
    teams: [...memberIds.values()].map(teamLabel).sort(),
  };
  console.log(`${lg.name} ${season}: ${memberIds.size} teams, ${outside.size} games outside the league's schedules, ` +
    `${played.length} played games, ${added.length} new, ${out.games.length} saved, ${pending.length} waiting for a score`);
  return out;
}

// ---------- stats for the web app (same rules as the Google Sheet) ----------
// Rows are per stage so the app can filter by stage and add them up:
//   players: [Player, Team, Division, Stage, GP, G, A, PTS, PIM]
//   goalies: [Goalie, Team, Division, Stage, GP, W, L, T, GA, SO]   (GAA = GA / GP, worked out in the app)
const STATS_VERSION = 2;
const key = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Empty-net goals scored against each team, by game: "<game>|<scoring team>" -> count.
function emptyNetGoals(goals) {
  const en = {};
  for (const r of goals) if (/\bEN\b/.test(String(r[11]))) { const k = r[0] + '|' + r[5]; en[k] = (en[k] || 0) + 1; }
  return en;
}

// W/L/T come from the final score. Goals against (and so GAA and shutouts) leave out
// empty-net goals, since the goalie wasn't in net for them.
function goalieStats(lg, members) {
  const en = emptyNetGoals(lg.goals);
  const by = {};
  const add = (id, name, team, div, stage, gf, ga, opponent) => {
    if (!name || !members.has(team)) return;
    const k = key(name) + '|' + team + '|' + stage;
    const s = by[k] || (by[k] = [name, team, div, stage, 0, 0, 0, 0, 0, 0]);
    const charged = Math.max(0, ga - (en[id + '|' + opponent] || 0));
    s[4]++; s[8] += charged;
    if (gf > ga) s[5]++; else if (gf < ga) s[6]++; else s[7]++;
    if (charged === 0) s[9]++;
  };
  for (const r of lg.games) {
    add(r[0], r[7], r[5], r[2], r[4], r[6], r[9], r[8]);
    add(r[0], r[10], r[8], r[2], r[4], r[9], r[6], r[5]);
  }
  return Object.values(by);
}

function playerStats(lg, members) {
  const info = {};
  lg.games.forEach(r => info[r[0]] = r);
  const isGoalie = pos => String(pos || '').split('/').some(x => x.trim() === 'G');
  const by = {};
  const get = (name, team, div, stage) => {
    const k = key(name) + '|' + team + '|' + stage;
    return by[k] || (by[k] = { row: [name, team, div, stage, 0, 0, 0, 0, 0], skated: false });
  };
  // A game where someone is listed as a goalie (starter or backup) is a goalie game:
  // it doesn't count toward their player stats. Goalie stats come from starts only.
  const inNet = new Set();   // "<game>|<name>|<team>"
  const dressed = new Set(); // "<name>|<team>": dressed as a skater at least once
  for (const id in lg.lineups) {
    const g = info[id];
    if (!g) continue;
    for (const [team, name, pos] of lg.lineups[id]) {
      if (!isPlayer(pos)) continue; // team staff
      if (isGoalie(pos)) { inNet.add(id + '|' + key(name) + '|' + team); continue; }
      const s = get(name, team, g[2], g[4]);
      s.row[4]++;
      s.skated = true;
      dressed.add(key(name) + '|' + team);
    }
  }
  const credit = (r, name) => name && !inNet.has(r[0] + '|' + key(name) + '|' + r[5]);
  for (const r of lg.goals) {
    if (String(r[11]).includes('Own goal')) continue;
    if (credit(r, r[6])) get(r[6], r[5], r[2], r[4]).row[5]++;
    if (credit(r, r[7])) get(r[7], r[5], r[2], r[4]).row[6]++;
    if (credit(r, r[8])) get(r[8], r[5], r[2], r[4]).row[6]++;
  }
  for (const r of lg.penalties) if (credit(r, r[6])) get(r[6], r[5], r[2], r[4]).row[8] += Number(r[9]) || 0;
  // A penalty alone only counts for someone who dressed as a skater (not a coach's bench penalty).
  return Object.values(by)
    .filter(s => members.has(s.row[1]) && (s.skated || s.row[5] || s.row[6] || (s.row[8] && dressed.has(key(s.row[0]) + '|' + s.row[1]))))
    .map(s => { s.row[7] = s.row[5] + s.row[6]; return s.row; });
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { leagues: {} };
const data = { updated: new Date().toISOString(), leagues: {} };
for (const lg of LEAGUES) data.leagues[lg.name] = await updateLeague(lg, prev.leagues && prev.leagues[lg.name]);
// Only rewrite the files when something changed, so the workflow doesn't commit every hour.
const STATS_OUT = OUT.replace(/data\.json$/, 'stats.json');
const changed = JSON.stringify(data.leagues) !== JSON.stringify(prev.leagues);
if (changed) {
  fs.writeFileSync(OUT, JSON.stringify(data));
  console.log('Saved ' + OUT);
} else {
  console.log('No changes');
}
let oldStats = null;
try { oldStats = JSON.parse(fs.readFileSync(STATS_OUT, 'utf8')); } catch (e) { /* none yet */ }
if (changed || !oldStats || oldStats.version !== STATS_VERSION) {
  const stats = { version: STATS_VERSION, updated: data.updated, leagues: {} };
  for (const name in data.leagues) {
    const lg = data.leagues[name];
    const members = new Set(lg.teams || []);
    stats.leagues[name] = { players: playerStats(lg, members), goalies: goalieStats(lg, members) };
  }
  fs.writeFileSync(STATS_OUT, JSON.stringify(stats));
  console.log('Saved ' + STATS_OUT);
}
