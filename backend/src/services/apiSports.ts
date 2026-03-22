/**
 * API-Sports NBA Service
 *
 * Actual working endpoints (verified against v1.basketball.api-sports.io):
 *   GET /games?date=...&league=12&season=...        → schedule
 *   GET /games?team=...&season=...&league=12        → team season schedule
 *   GET /games/statistics/players?ids=<gameId>     → box score for one game
 *   GET /players?search=<name>                     → player search (no league/season filter)
 *
 * NOTE: /players/statistics does NOT exist on this API. All player stat history
 * must be assembled from individual game box scores.
 */

import axios, { AxiosError } from 'axios';
import { getOrFetch, TTL } from '../cache/gameCache';

const client = axios.create({
  baseURL: 'https://v1.basketball.api-sports.io',
  headers: { 'x-apisports-key': process.env.API_SPORTS_KEY ?? '' },
  timeout: 15000,
});

client.interceptors.response.use((res) => {
  const remaining = res.headers['x-ratelimit-requests-remaining'];
  if (remaining && Number(remaining) < 50) {
    console.warn(`[API-Sports] Rate limit low — ${remaining} requests remaining today`);
  }
  return res;
});

// Retry once on transient failures (network errors, 5xx, timeout)
client.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config;
  if (!config || (config as any).__retried) return Promise.reject(error);
  const status = error.response?.status;
  const isRetryable = !status || status >= 500 || error.code === 'ECONNABORTED';
  if (!isRetryable) return Promise.reject(error);
  (config as any).__retried = true;
  await new Promise((r) => setTimeout(r, 1000));
  return client.request(config);
});

// ── Type definitions ──────────────────────────────────────────────────────────

export interface ApiSportsGame {
  id: number;
  date: string;
  time: string;
  timestamp: number;
  status: { clock: string | null; halftime: boolean; short: number; long: string };
  league: { id: number; name: string; type: string; season: string; logo: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  scores: {
    home: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; over_time: number | null; total: number | null };
    away: { quarter_1: number | null; quarter_2: number | null; quarter_3: number | null; quarter_4: number | null; over_time: number | null; total: number | null };
  };
}

/**
 * Actual box score entry from /games/statistics/players.
 * Names are in "Lastname Firstname" or abbreviated format (e.g. "Davis Anthony", "C. Flagg").
 */
export interface ApiSportsBoxScore {
  game: { id: number };
  team: { id: number };
  player: { id: number; name: string };
  type: string; // 'starters' | 'bench'
  minutes: string; // "35:36"
  points: number | null;
  rebounds: { total: number | null };
  assists: number | null;
  steals: number | null;
  turnovers: number | null;
  blocks: number | null;
  threepoint_goals: { total: number | null };
  field_goals: { total: number | null; attempts: number | null };
  freethrows_goals: { total: number | null; attempts: number | null };
}

/**
 * Normalised player stat for the projection model.
 * Shaped to match what buildEnhancedProjection / extractStatValue expect.
 */
export interface ApiSportsPlayerStats {
  player: { id: number; name: string };
  team: { id: number; name: string };
  game: { id: number };
  points: number | null;
  min: string | null;       // whole-minute string e.g. "35"
  totReb: number | null;
  assists: number | null;
  tpm: number | null;       // three-pointers made
  // Kept for interface compatibility — all null in box-score mode
  pos: null; fgm: null; fga: null; fgp: null;
  ftm: null; fta: null; ftp: null;
  tpa: null; tpp: null;
  offReb: null; defReb: null;
  pFouls: null; steals: number | null; turnovers: number | null; blocks: number | null;
  plusMinus: null; comment: null;
}

/** Convert a raw box-score entry into the normalised stat shape. */
export function boxScoreToPlayerStats(bs: ApiSportsBoxScore): ApiSportsPlayerStats {
  const minParts = bs.minutes?.split(':').map(Number) ?? [0, 0];
  const minWhole = String(minParts[0] ?? 0);
  return {
    player: { id: bs.player.id, name: bs.player.name },
    team: { id: bs.team.id, name: '' },
    game: { id: bs.game.id },
    points: bs.points ?? null,
    min: minWhole,
    totReb: bs.rebounds?.total ?? null,
    assists: bs.assists ?? null,
    tpm: bs.threepoint_goals?.total ?? null,
    pos: null, fgm: null, fga: null, fgp: null,
    ftm: null, fta: null, ftp: null,
    tpa: null, tpp: null,
    offReb: null, defReb: null,
    pFouls: null,
    steals: bs.steals ?? null,
    turnovers: bs.turnovers ?? null,
    blocks: bs.blocks ?? null,
    plusMinus: null, comment: null,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TODAY = () => new Date().toISOString().split('T')[0];
const NBA_LEAGUE_ID = 12;

/**
 * Compute the current NBA season string dynamically.
 * The NBA season spans October through June. If the current month is
 * October or later, the season is "YYYY-(YYYY+1)". If January–September,
 * the season started the previous calendar year: "(YYYY-1)-YYYY".
 */
function getCurrentSeason(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed: 0=Jan, 9=Oct
  if (month >= 9) {
    // October–December: season starts this year
    return `${year}-${year + 1}`;
  }
  // January–September: season started last year
  return `${year - 1}-${year}`;
}

const CURRENT_SEASON = getCurrentSeason();

// ── Game schedule ─────────────────────────────────────────────────────────────

export async function getTodaysGames(): Promise<ApiSportsGame[]> {
  return getGamesForDate(TODAY());
}

export async function getGamesForDate(date: string): Promise<ApiSportsGame[]> {
  return getOrFetch(`api-sports:games:${date}`, TTL.SCHEDULE, async () => {
    const res = await client.get('/games', {
      params: { league: NBA_LEAGUE_ID, season: CURRENT_SEASON, date },
    });
    return (res.data.response ?? []) as ApiSportsGame[];
  });
}

/** Next scheduled games within `days` days (stops at first day with upcoming games). */
export async function getUpcomingGamesNextDays(days: number = 3): Promise<ApiSportsGame[]> {
  const today = new Date();
  for (let i = 0; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const games = await getGamesForDate(dateStr);
    const upcoming = games.filter((g) => g.status.long === 'Not Started' || g.status.long === 'TBD');
    if (upcoming.length > 0) return upcoming;
  }
  return [];
}

/** All season games for a team, sorted newest-first by game ID. Cached 6h. */
export async function getTeamSeasonGames(teamId: number): Promise<ApiSportsGame[]> {
  return getOrFetch(`api-sports:team-season-games:${teamId}`, 6 * 60 * 60, async () => {
    const res = await client.get('/games', {
      params: { league: NBA_LEAGUE_ID, season: CURRENT_SEASON, team: teamId },
    });
    const games = (res.data.response ?? []) as ApiSportsGame[];
    return games.sort((a, b) => b.id - a.id);
  });
}

/** IDs of the last `n` completed games for a team. */
export async function getTeamRecentCompletedGameIds(teamId: number, n = 15): Promise<number[]> {
  const all = await getTeamSeasonGames(teamId);
  return all
    .filter((g) => g.status.long === 'Game Finished')
    .slice(0, n)
    .map((g) => g.id);
}

// Legacy shim — kept so fallback pipeline still compiles
export async function getTeamRecentGames(teamId: number, _last = 3): Promise<ApiSportsGame[]> {
  const all = await getTeamSeasonGames(teamId);
  return all.filter((g) => g.status.long === 'Game Finished').slice(0, _last);
}

// ── Box scores ────────────────────────────────────────────────────────────────

/**
 * Fetch the box score for a single completed game.
 * Raw entries; use boxScoreToPlayerStats() to normalise.
 */
export async function getGameBoxScoreRaw(gameId: number): Promise<ApiSportsBoxScore[]> {
  return getOrFetch(`api-sports:boxscore:${gameId}`, TTL.PLAYER_STATS, async () => {
    const res = await client.get('/games/statistics/players', { params: { ids: gameId } });
    return (res.data.response ?? []) as ApiSportsBoxScore[];
  });
}

/** @deprecated use getGameBoxScoreRaw */
export async function getGameBoxScore(gameId: number): Promise<ApiSportsPlayerStats[]> {
  const raw = await getGameBoxScoreRaw(gameId);
  return raw.map(boxScoreToPlayerStats);
}

// ── Player game-log assembly ──────────────────────────────────────────────────

/**
 * Normalise a player name for fuzzy matching.
 * Handles both "Firstname Lastname" (TheOddsAPI) and "Lastname Firstname" (API-Sports).
 * Strategy: sort words alphabetically so order doesn't matter.
 */
export function normalizePlayerName(name: string): string {
  return name
    .normalize('NFD')                    // Decompose "ö" into "o" + combining umlaut
    .replace(/[\u0300-\u036f]/g, '')     // Strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')           // strip punctuation (dots, apostrophes, hyphens)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Build a game-log history for a player by scanning box scores for the given team(s).
 * Returns normalised ApiSportsPlayerStats entries, newest-first.
 *
 * @param playerName  Name as it appears in TheOddsAPI (e.g. "Anthony Davis")
 * @param teamGameIds Game IDs to search through (team's recent completed games)
 */
/**
 * Match a box score entry's player name against the target odds player name.
 * Two passes:
 *   1. Sorted-word exact match handles "Davis Anthony" ↔ "Anthony Davis"
 *   2. Last-name + first-initial match handles "J. Wells" ↔ "Jaylen Wells"
 */
export function playerNameMatches(apiName: string, oddsName: string): boolean {
  // Pass 1: sorted-word match (handles reversed name format)
  if (normalizePlayerName(apiName) === normalizePlayerName(oddsName)) return true;

  // Pass 2: abbreviated first name ("J. Wells" ↔ "Jaylen Wells")
  const oddsParts = oddsName.trim().split(/\s+/);
  const oddsFirst = oddsParts[0].toLowerCase().replace(/[^a-z]/g, '');
  const oddsLast  = oddsParts[oddsParts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  if (oddsLast.length < 3) return false; // too short to match safely

  const apiParts = apiName.trim().toLowerCase().replace(/[^a-z.\s]/g, '').split(/\s+/);
  // Find the word in the API name that matches the odds last name
  const lastIdx = apiParts.findIndex(w => w.replace(/\./g, '') === oddsLast);
  if (lastIdx === -1) return false;

  // Check that the remaining word starts with the odds first initial
  const otherParts = apiParts.filter((_, i) => i !== lastIdx);
  return otherParts.some(w => {
    const clean = w.replace(/\./g, '');
    return clean === oddsFirst || (clean.length === 1 && clean === oddsFirst[0]);
  });
}

export async function getPlayerGameLogsFromBoxScores(
  playerName: string,
  teamGameIds: number[]
): Promise<ApiSportsPlayerStats[]> {
  const logs: ApiSportsPlayerStats[] = [];

  // Fetch box scores in parallel (all are cached individually)
  const boxScores = await Promise.allSettled(teamGameIds.map((id) => getGameBoxScoreRaw(id)));

  for (let i = 0; i < boxScores.length; i++) {
    const result = boxScores[i];
    if (result.status !== 'fulfilled') continue;

    for (const entry of result.value) {
      if (playerNameMatches(entry.player.name, playerName)) {
        logs.push(boxScoreToPlayerStats(entry));
        break; // found this player for this game
      }
    }
  }

  return logs; // already newest-first because teamGameIds is sorted newest-first
}

// ── Legacy shim — delegates to enriched logs ─────────────────────────────────

export async function getRecentGameLogs(
  playerId: number,
  last = 5
): Promise<ApiSportsPlayerStats[]> {
  const enriched = await getEnrichedGameLogs(playerId, last);
  return enriched;
}

// ── Enriched types ────────────────────────────────────────────────────────────

export interface EnrichedGameLog extends ApiSportsPlayerStats {
  opponent_name: string;
  opponent_id: number;
  was_home_game: boolean;
  game_result: 'W' | 'L' | null;
  game_date: string;
}

// ── Player-team and player-info discovery caches (in-memory) ─────────────────

const playerTeamMap = new Map<number, { teamId: number; teamName: string }>();
const playerNameMap = new Map<number, string>(); // playerId → "Lastname Firstname" raw name

/**
 * Discover which team a player belongs to by scanning recent box scores.
 * Caches all discovered player→team mappings AND player names to amortise cost.
 */
async function discoverPlayerTeam(
  playerId: number
): Promise<{ teamId: number; teamName: string } | null> {
  if (playerTeamMap.has(playerId)) return playerTeamMap.get(playerId)!;

  const today = new Date();
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];

    const games = await getGamesForDate(dateStr);
    const completed = games.filter((g) => g.status.long === 'Game Finished');

    for (const game of completed) {
      const boxScore = await getGameBoxScoreRaw(game.id);
      for (const entry of boxScore) {
        // Cache every player we see — cheap and prevents future scans
        if (!playerTeamMap.has(entry.player.id)) {
          const isHome = entry.team.id === game.teams.home.id;
          const team = isHome ? game.teams.home : game.teams.away;
          playerTeamMap.set(entry.player.id, {
            teamId: entry.team.id,
            teamName: team.name,
          });
        }
        // Cache player name for getPlayerInfo
        if (!playerNameMap.has(entry.player.id)) {
          playerNameMap.set(entry.player.id, entry.player.name);
        }
      }
      if (playerTeamMap.has(playerId)) {
        return playerTeamMap.get(playerId)!;
      }
    }
  }
  console.warn(`[API-Sports] Player ${playerId} not found in box scores from last 7 days`);
  return null;
}

/**
 * Ensure the box-score player cache is populated.
 * Scans 5 days of completed games if the cache is empty.
 */
async function ensurePlayerCachePopulated(): Promise<void> {
  if (playerNameMap.size > 0) return; // already populated

  const today = new Date();
  for (let daysBack = 0; daysBack <= 5; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];

    const games = await getGamesForDate(dateStr);
    const completed = games.filter((g) => g.status.long === 'Game Finished');

    for (const game of completed) {
      const boxScore = await getGameBoxScoreRaw(game.id);
      for (const entry of boxScore) {
        if (!playerTeamMap.has(entry.player.id)) {
          const isHome = entry.team.id === game.teams.home.id;
          const team = isHome ? game.teams.home : game.teams.away;
          playerTeamMap.set(entry.player.id, { teamId: entry.team.id, teamName: team.name });
        }
        if (!playerNameMap.has(entry.player.id)) {
          playerNameMap.set(entry.player.id, entry.player.name);
        }
      }
    }
  }
}

/**
 * Search the playerNameMap for matches against queryName.
 * Supports partial/fuzzy matching — query can appear anywhere in the name.
 */
function searchCachedPlayers(
  queryName: string
): Array<{ id: number; firstname: string; lastname: string; team?: string; score: number }> {
  const normalizedQuery = normalizePlayerName(queryName);
  const queryWords = normalizedQuery.split(' ').filter(w => w.length > 1);
  const results: Array<{ id: number; firstname: string; lastname: string; team?: string; score: number }> = [];

  for (const [playerId, rawName] of playerNameMap) {
    const normalized = normalizePlayerName(rawName);
    let score = 0;

    // Exact sorted-word match
    if (normalized === normalizedQuery) {
      score = 100;
    }
    // Full query appears as substring
    else if (normalized.includes(normalizedQuery)) {
      score = normalized.startsWith(normalizedQuery) ? 95 : 85;
    }
    // Any query word matches a word in the name
    else if (queryWords.some(word => normalized.includes(word))) {
      score = 60;
    }
    // Also check the reverse match pattern
    else if (playerNameMatches(rawName, queryName)) {
      score = 70;
    }

    if (score > 0) {
      const parsed = parseBoxScoreName(rawName);
      const teamInfo = playerTeamMap.get(playerId);
      results.push({
        id: playerId,
        firstname: parsed.firstname,
        lastname: parsed.lastname,
        team: teamInfo?.teamName,
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 15);
}

/**
 * Search for a player by name using the box-score cache.
 * Scans up to 7 days of games if needed to find the player.
 */
export async function searchPlayerByName(
  queryName: string
): Promise<Array<{ id: number; firstname: string; lastname: string; team?: string; score: number }>> {
  await ensurePlayerCachePopulated();

  let results = searchCachedPlayers(queryName);
  if (results.length > 0) return results;

  // Player not found in initial scan — extend scan to more days
  const today = new Date();
  for (let daysBack = 6; daysBack <= 7; daysBack++) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];

    const games = await getGamesForDate(dateStr);
    const completed = games.filter((g) => g.status.long === 'Game Finished');

    for (const game of completed) {
      const boxScore = await getGameBoxScoreRaw(game.id);
      for (const entry of boxScore) {
        if (!playerTeamMap.has(entry.player.id)) {
          const isHome = entry.team.id === game.teams.home.id;
          const team = isHome ? game.teams.home : game.teams.away;
          playerTeamMap.set(entry.player.id, { teamId: entry.team.id, teamName: team.name });
        }
        if (!playerNameMap.has(entry.player.id)) {
          playerNameMap.set(entry.player.id, entry.player.name);
        }
      }
    }

    results = searchCachedPlayers(queryName);
    if (results.length > 0) return results;
  }

  return [];
}

// ── Player info ───────────────────────────────────────────────────────────────

/**
 * Convert API-Sports box-score name to first/last parts.
 * Full names are "Lastname Firstname" → swap: "Davis Anthony" → Anthony Davis
 * Abbreviated names are already standard → keep: "J. Wells" → J. Wells
 */
function parseBoxScoreName(raw: string): { firstname: string; lastname: string } {
  const parts = raw.trim().split(/\s+/);
  if (parts.length <= 1) return { firstname: '', lastname: parts[0] || '' };

  // If first word is an initial (single char or ends with period), it's already
  // in "Firstname Lastname" order — don't swap
  const firstWord = parts[0];
  const isInitial = firstWord.endsWith('.') || firstWord.replace(/\./g, '').length <= 1;
  if (isInitial) {
    return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
  }

  // Full name in "Lastname Firstname" format — swap
  return { firstname: parts.slice(1).join(' '), lastname: parts[0] };
}

/**
 * Get player info by deriving from box score data.
 * The `/players?id=X` endpoint doesn't reliably return results,
 * so we extract name from cached box score scans instead.
 */
export async function getPlayerInfo(
  playerId: number
): Promise<{ id: number; firstname: string; lastname: string } | null> {
  return getOrFetch(`api-sports:player-info:${playerId}`, TTL.PLAYER_INFO, async () => {
    // If we already have cached name from box score scanning, use it
    if (playerNameMap.has(playerId)) {
      const { firstname, lastname } = parseBoxScoreName(playerNameMap.get(playerId)!);
      return { id: playerId, firstname, lastname };
    }

    // Trigger a box score scan to populate the cache
    await discoverPlayerTeam(playerId);

    if (playerNameMap.has(playerId)) {
      const { firstname, lastname } = parseBoxScoreName(playerNameMap.get(playerId)!);
      return { id: playerId, firstname, lastname };
    }

    // Fallback: hit the /players API directly
    try {
      const { data } = await client.get('/players', { params: { id: playerId } });
      const p = data?.response?.[0];
      if (p) {
        const { firstname, lastname } = parseBoxScoreName(p.name ?? '');
        console.log(`[API-Sports] Player ${playerId} resolved via /players API: ${firstname} ${lastname}`);
        playerNameMap.set(playerId, p.name ?? `${firstname} ${lastname}`);
        return { id: playerId, firstname, lastname };
      }
    } catch (err: any) {
      console.warn(`[API-Sports] /players fallback failed for ${playerId}:`, err.message);
    }

    return null;
  });
}

// ── Team info ─────────────────────────────────────────────────────────────────

export async function getTeamInfo(
  teamId: number
): Promise<{ id: number; name: string } | null> {
  // Derive from cached team season games (avoids extra API call)
  const games = await getTeamSeasonGames(teamId);
  if (games.length === 0) return null;
  const game = games[0];
  if (game.teams.home.id === teamId) return { id: teamId, name: game.teams.home.name };
  if (game.teams.away.id === teamId) return { id: teamId, name: game.teams.away.name };
  return { id: teamId, name: 'Unknown' };
}

// ── Enriched game logs ────────────────────────────────────────────────────────

export async function getEnrichedGameLogs(
  playerId: number,
  last = 20
): Promise<EnrichedGameLog[]> {
  return getOrFetch(`enriched-logs:${playerId}:${last}`, TTL.PLAYER_STATS, async () => {
    // Step 1: Discover the player's team
    const teamInfo = await discoverPlayerTeam(playerId);
    if (!teamInfo) {
      console.warn(`[API-Sports] Could not discover team for player ${playerId}`);
      return [];
    }

    // Step 2: Get the team's recent completed game IDs (newest-first)
    const gameIds = await getTeamRecentCompletedGameIds(teamInfo.teamId, last + 5);

    // Step 3: Get full game objects for context (cached via getTeamSeasonGames)
    const allTeamGames = await getTeamSeasonGames(teamInfo.teamId);
    const gameMap = new Map(allTeamGames.map((g) => [g.id, g]));

    // Step 4: Fetch box scores in parallel
    const boxScoreResults = await Promise.allSettled(
      gameIds.map((id) => getGameBoxScoreRaw(id))
    );

    // Step 5: Extract player entries and enrich with game context
    const enrichedLogs: EnrichedGameLog[] = [];

    for (let i = 0; i < gameIds.length; i++) {
      const result = boxScoreResults[i];
      if (result.status !== 'fulfilled') continue;

      const gameId = gameIds[i];
      const game = gameMap.get(gameId);
      if (!game) continue;

      // Find player in this box score by ID
      const playerEntry = result.value.find((e) => e.player.id === playerId);
      if (!playerEntry) continue;

      const stats = boxScoreToPlayerStats(playerEntry);

      // Determine opponent and home/away
      const isHome = game.teams.home.id === teamInfo.teamId;
      const opponent = isHome ? game.teams.away : game.teams.home;

      // Determine game result
      let gameResult: 'W' | 'L' | null = null;
      if (game.scores.home.total !== null && game.scores.away.total !== null) {
        const playerTeamScore = isHome ? game.scores.home.total : game.scores.away.total;
        const opponentScore = isHome ? game.scores.away.total : game.scores.home.total;
        gameResult = playerTeamScore > opponentScore ? 'W' : 'L';
      }

      enrichedLogs.push({
        ...stats,
        team: { id: teamInfo.teamId, name: teamInfo.teamName },
        opponent_name: opponent.name,
        opponent_id: opponent.id,
        was_home_game: isHome,
        game_result: gameResult,
        game_date: game.date,
      });

      if (enrichedLogs.length >= last) break;
    }

    return enrichedLogs; // newest-first (gameIds are sorted newest-first)
  });
}

// ── Player season stats (built from enriched logs) ────────────────────────────

export async function getPlayerStats(
  playerId: number,
  _season?: string
): Promise<ApiSportsPlayerStats[]> {
  // Build season stats by fetching enriched game logs for the full season
  const logs = await getEnrichedGameLogs(playerId, 82);
  return logs;
}

// ── DB-first game logs (Supabase → live API fallback) ────────────────────────

import { supabaseAdmin } from '../lib/supabaseAdmin';

/**
 * Fetch game logs preferring the Supabase game_logs table (populated by
 * nightly ingest + backfill), falling back to live API-Sports only when
 * the DB has no data for the player.
 *
 * This should be used by playerDetail and playerAnalysis instead of
 * getEnrichedGameLogs() directly, since the DB can have 60+ games while
 * the live API path is limited to ~15 by rate limits.
 */
export async function getPlayerGameLogs(
  playerId: number,
  limit: number = 50
): Promise<EnrichedGameLog[]> {
  // Layer 1: Supabase game_logs (fast, has backfilled history)
  const { data: dbLogs } = await supabaseAdmin
    .from('game_logs')
    .select('*')
    .eq('player_id', playerId)
    .order('game_date', { ascending: false })
    .limit(limit);

  if (dbLogs && dbLogs.length >= 3) {
    return dbLogs.map((r: any) => ({
      player: { id: playerId, name: r.player_name ?? '' },
      team: { id: 0, name: r.team_name ?? '' },
      game: { id: r.game_id ?? 0 },
      points: r.pts ?? 0,
      min: r.minutes != null ? String(Math.round(r.minutes)) : '0',
      totReb: r.reb ?? 0,
      assists: r.ast ?? 0,
      tpm: r.tpm ?? 0,
      steals: r.stl ?? 0,
      blocks: r.blk ?? 0,
      turnovers: r.turnovers ?? 0,
      pos: null, fgm: null, fga: null, fgp: null,
      ftm: null, fta: null, ftp: null,
      tpa: null, tpp: null,
      offReb: null, defReb: null,
      pFouls: null, plusMinus: null, comment: null,
      // Enriched fields
      opponent_name: r.opponent_name ?? '',
      opponent_id: r.opponent_id ?? 0,
      was_home_game: r.is_home ?? false,
      game_result: r.game_result ?? null,
      game_date: r.game_date,
    }));
  }

  // Layer 2: Live API-Sports (fallback when DB not yet populated)
  return getEnrichedGameLogs(playerId, limit);
}

// ── Standings stub ────────────────────────────────────────────────────────────

export async function getStandings(_season?: string) { return []; }
