/**
 * Players Routes
 * GET /api/players/:playerId
 * GET /api/players/:playerId/logs
 * GET /api/players/:playerId/props
 * GET /api/players/:playerId/analysis
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireStarter, getUserTier } from '../middleware/subscriptionGate';
import type { AuthenticatedRequest } from '../middleware/auth';
import logger from '../lib/logger';
import {
  getPlayerInfo,
  getPlayerStats,
  getRecentGameLogs,
  getEnrichedGameLogs,
  playerNameMatches,
  searchPlayerByName,
} from '../services/apiSports';
import { getNBAOdds, getNBAPlayerProps } from '../services/oddsApi';
import { redisGetJSON } from '../lib/redis';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { REDIS_KEYS } from '../jobs/oddsRefresh';
import { computePlayerAnalysis } from '../services/playerAnalysis';
import { computePlayerDetail } from '../services/playerDetail';
import { resolveNBAPersonId, headshotUrl } from '../services/nbaPlayers';
import cache, { getOrFetch, isGameHours } from '../cache/gameCache';

const router = Router();

// Analysis endpoint TTLs (seconds)
const ANALYSIS_TTL_GAME_HOURS = 8 * 60;  // 8 minutes
const ANALYSIS_TTL_OFF_HOURS  = 2 * 60 * 60; // 2 hours

// ── GET /api/players/search/lab?name= ─────────────────────────────────────────
router.get('/search/lab', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = (req.query.name as string)?.trim();
    if (!name || name.length < 2) { res.status(400).json({ error: 'name required' }); return; }
    const results = await searchPlayerByName(name);
    res.json({ query: name, results });
  } catch (err: any) {
    logger.error('[Players] search/lab error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/players/search?name= ─────────────────────────────────────────────
// Defined BEFORE /:playerId so Express doesn't swallow it as a param route.
// Uses box-score-derived player cache (not the unreliable /players API endpoint).
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = (req.query.name as string)?.trim();
    if (!name || name.length < 2) {
      res.status(400).json({ error: 'name query param required (min 2 chars)' });
      return;
    }

    const results = await searchPlayerByName(name);

    // Enrich results with headshot URLs and team info
    const enriched = await Promise.all(
      results.slice(0, 15).map(async (player) => {
        const fullName = `${player.firstname} ${player.lastname}`.trim();
        const nbaId = await resolveNBAPersonId(fullName);
        // Normalize team — could be an object { id, name, logo } or a string
        const teamName = typeof player.team === 'object' && player.team !== null
          ? (player.team as any).name ?? ''
          : String(player.team ?? '');
        return {
          ...player,
          name: fullName,
          team: teamName,
          headshotUrl: nbaId ? headshotUrl(nbaId) : null,
        };
      })
    );

    res.json({ query: name, results: enriched });
  } catch (err: any) {
    logger.error('[Players] search error:', err.message);
    res.status(500).json({ error: 'Failed to search player' });
  }
});

// ── GET /api/players/by-name/logs?name= ───────────────────────────────────────
// Returns box-score logs pre-warmed by the projections pipeline.
// Defined BEFORE /:playerId so Express doesn't consume it as a param route.
router.get('/by-name/logs', requireAuth, async (req: Request, res: Response) => {
  const name = (req.query.name as string)?.trim()?.toLowerCase();
  if (!name || name.length < 2) {
    res.status(400).json({ error: 'name query param required (min 2 chars)' });
    return;
  }

  const logs: any[] | undefined = cache.get(`player-logs-by-name:${name}`);
  if (!logs || logs.length === 0) {
    res.json({ name, logs: [], count: 0, message: 'No cached logs for this player yet' });
    return;
  }

  // Transform ApiSportsPlayerStats → same shape the frontend /logs endpoint returns
  const formatted = logs.map((g: any) => ({
    game: { id: g.game?.id ?? 0 },
    game_date: g.game_date ?? g.game?.date ?? '',
    opponent_name: g.opponent_name ?? g.opponent ?? '',
    was_home_game: g.was_home_game ?? g.isHome ?? false,
    game_result: g.game_result ?? null,
    points: g.points ?? 0,
    totReb: g.totReb ?? 0,
    assists: g.assists ?? 0,
    tpm: g.tpm ?? 0,
    steals: g.steals ?? 0,
    blocks: g.blocks ?? 0,
    turnovers: g.turnovers ?? 0,
    min: typeof g.min === 'string' ? g.min : String(Math.round(g.min ?? 0)),
    plusMinus: g.plusMinus ?? '0',
  }));

  res.json({ name, logs: formatted, count: formatted.length });
});

// ── GET /api/players/:playerId ────────────────────────────────────────────────
router.get('/:playerId', requireAuth, async (req: Request, res: Response) => {
  try {
    const playerId = Number(req.params.playerId);
    if (isNaN(playerId)) {
      res.status(400).json({ error: 'Invalid playerId' });
      return;
    }

    const [playerInfo, seasonStats] = await Promise.all([
      getPlayerInfo(playerId),
      getPlayerStats(playerId),
    ]);

    if (!playerInfo) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    // Compute season averages from game logs
    const played = seasonStats.filter((g) => g.min && g.min !== '0');
    const avg = (key: keyof typeof played[0]) =>
      played.length
        ? Math.round((played.reduce((s, g) => s + (Number(g[key]) || 0), 0) / played.length) * 10) / 10
        : 0;

    const seasonAverages = {
      gamesPlayed: played.length,
      points: avg('points'),
      rebounds: avg('totReb'),
      assists: avg('assists'),
      threes: avg('tpm'),
      steals: avg('steals'),
      blocks: avg('blocks'),
      turnovers: avg('turnovers'),
    };

    res.json({ player: playerInfo, seasonAverages, gamesPlayed: played.length });
  } catch (err: any) {
    logger.error('[Players] player error:', err.message);
    res.status(500).json({ error: 'Failed to fetch player data' });
  }
});

// ── GET /api/players/:playerId/logs ───────────────────────────────────────────
// Priority: Supabase game_logs → live API-Sports
router.get('/:playerId/logs', requireAuth, requireStarter, async (req: Request, res: Response) => {
  try {
    const playerId = Number(req.params.playerId);
    if (isNaN(playerId)) {
      res.status(400).json({ error: 'Invalid playerId' });
      return;
    }

    const limit = Math.min(Number(req.query.limit ?? 20), 50);

    // ── Layer 1: Supabase game_logs (populated by nightly ingest) ────────────
    const { data: dbLogs } = await supabaseAdmin
      .from('game_logs')
      .select('*')
      .eq('player_id', playerId)
      .order('game_date', { ascending: false })
      .limit(limit);

    if (dbLogs && dbLogs.length > 0) {
      const logs = dbLogs.map((r) => ({
        game: { id: r.game_id ?? 0 },
        game_date: r.game_date,
        opponent_name: r.opponent_name ?? '',
        was_home_game: r.is_home ?? false,
        game_result: r.game_result ?? null,
        points: r.pts ?? 0,
        totReb: r.reb ?? 0,
        assists: r.ast ?? 0,
        tpm: r.tpm ?? 0,
        steals: r.stl ?? 0,
        blocks: r.blk ?? 0,
        turnovers: r.turnovers ?? 0,
        min: r.minutes != null ? String(Math.round(r.minutes)) : '0',
        plusMinus: r.plus_minus ?? '0',
      }));
      return res.json({ playerId, logs, count: logs.length, source: 'db' });
    }

    // ── Layer 2: Live API-Sports (fallback when DB not yet populated) ─────────
    const logs = await getEnrichedGameLogs(playerId, limit);
    res.json({ playerId, logs, count: logs.length, source: 'live' });
  } catch (err: any) {
    logger.error('[Players] logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch game logs' });
  }
});

// ── GET /api/players/:playerId/props ──────────────────────────────────────────
// Priority: Redis odds cache (set by oddsRefresh) → live TheOddsAPI
router.get('/:playerId/props', requireAuth, requireStarter, async (req: Request, res: Response) => {
  try {
    const playerId = Number(req.params.playerId);
    if (isNaN(playerId)) {
      res.status(400).json({ error: 'Invalid playerId' });
      return;
    }

    // Resolve player name (from DB first, then live)
    let playerName = '';
    let teamName = '';

    const { data: metaRow } = await supabaseAdmin
      .from('player_metadata')
      .select('full_name, team_name')
      .eq('player_id', playerId)
      .maybeSingle();

    if (metaRow) {
      playerName = metaRow.full_name;
      teamName   = metaRow.team_name ?? '';
    } else {
      const [playerInfo, recentLogs] = await Promise.all([
        getPlayerInfo(playerId),
        getRecentGameLogs(playerId, 1),
      ]);
      if (!playerInfo) { res.status(404).json({ error: 'Player not found' }); return; }
      playerName = `${playerInfo.firstname} ${playerInfo.lastname}`;
      teamName   = recentLogs[0]?.team?.name ?? '';
    }

    // ── Layer 1: Read props from Redis odds cache ─────────────────────────────
    const cachedPropsObj = await redisGetJSON<Record<string, {
      line: number; overOdds: number | null; underOdds: number | null; bookmaker: string;
    }>>(REDIS_KEYS.ODDS_PROPS);

    if (cachedPropsObj) {
      const playerNameLower = playerName.toLowerCase();
      const MARKET_DISPLAY: Record<string, string> = {
        points: 'PTS', totReb: 'REB', assists: 'AST', tpm: '3PM',
      };
      const BOOK_TITLES: Record<string, string> = {
        fanduel: 'FanDuel', draftkings: 'DraftKings',
        betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN BET',
      };
      const props: any[] = [];
      for (const [key, val] of Object.entries(cachedPropsObj)) {
        const colonIdx = key.lastIndexOf(':');
        const kName = key.substring(0, colonIdx);
        const kStat = key.substring(colonIdx + 1);
        if (kName !== playerNameLower) continue;
        const statDisplay = MARKET_DISPLAY[kStat];
        if (!statDisplay) continue;
        props.push({
          statDisplay,
          bookmaker: val.bookmaker,
          bookmakerTitle: BOOK_TITLES[val.bookmaker] ?? val.bookmaker,
          line: val.line,
          overOdds: val.overOdds,
          underOdds: val.underOdds,
          isBestOver: true,
          isBestUnder: true,
        });
      }
      if (props.length > 0) {
        return res.json({ playerId, playerName, teamName, props, count: props.length, source: 'redis' });
      }
    }

    // ── Layer 2: Live TheOddsAPI (fallback) ───────────────────────────────────
    if (!teamName) {
      res.json({ playerId, playerName, props: [], message: 'No recent games found for team lookup' });
      return;
    }

    // Find today's OddsAPI event for this player's team
    const events = await getNBAOdds();
    const normTeam = teamName.toLowerCase();
    const teamWords = normTeam.split(' ').filter((w) => w.length > 3);

    const playerEvent = events.find((e) => {
      const home = e.home_team.toLowerCase();
      const away = e.away_team.toLowerCase();
      return teamWords.some((w) => home.includes(w) || away.includes(w));
    });

    if (!playerEvent) {
      res.json({ playerId, playerName, teamName, props: [], message: 'No game today for this player' });
      return;
    }

    const propsEvent = await getNBAPlayerProps(playerEvent.id);
    if (!propsEvent) {
      res.json({ playerId, playerName, teamName, props: [], message: 'No props posted for today\'s game yet' });
      return;
    }

    const MARKET_DISPLAY: Record<string, string> = {
      player_points: 'PTS',
      player_rebounds: 'REB',
      player_assists: 'AST',
      player_threes: '3PM',
      player_points_rebounds_assists: 'PRA',
      player_steals: 'STL',
      player_blocks: 'BLK',
    };
    const BOOK_TITLES: Record<string, string> = {
      fanduel: 'FanDuel', draftkings: 'DraftKings',
      betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN BET',
    };

    // Collect all { statDisplay → { bookKey → { line, overOdds, underOdds } } }
    const byStatByBook: Record<string, Record<string, { line: number; overOdds: number | null; underOdds: number | null }>> = {};

    for (const book of propsEvent.bookmakers) {
      for (const market of book.markets) {
        const statDisplay = MARKET_DISPLAY[market.key];
        if (!statDisplay) continue;

        const over = market.outcomes.find(
          (o) => o.name === 'Over' && playerNameMatches(playerName, o.description ?? '')
        );
        const under = market.outcomes.find(
          (o) => o.name === 'Under' && playerNameMatches(playerName, o.description ?? '')
        );

        if (!over || over.point == null) continue;

        if (!byStatByBook[statDisplay]) byStatByBook[statDisplay] = {};
        byStatByBook[statDisplay][book.key] = {
          line: over.point,
          overOdds: over.price ?? null,
          underOdds: under?.price ?? null,
        };
      }
    }

    // Flatten to array with best-over / best-under flags per stat
    const props: Array<{
      statDisplay: string;
      bookmaker: string;
      bookmakerTitle: string;
      line: number;
      overOdds: number | null;
      underOdds: number | null;
      isBestOver: boolean;
      isBestUnder: boolean;
    }> = [];

    for (const [statDisplay, books] of Object.entries(byStatByBook)) {
      const keys = Object.keys(books);
      if (keys.length === 0) continue;
      const bestOverKey = keys.reduce((best, k) =>
        (books[k].overOdds ?? -9999) > (books[best]?.overOdds ?? -9999) ? k : best
      );
      const bestUnderKey = keys.reduce((best, k) =>
        (books[k].underOdds ?? -9999) > (books[best]?.underOdds ?? -9999) ? k : best
      );
      for (const k of keys) {
        props.push({
          statDisplay,
          bookmaker: k,
          bookmakerTitle: BOOK_TITLES[k] ?? k,
          line: books[k].line,
          overOdds: books[k].overOdds,
          underOdds: books[k].underOdds,
          isBestOver: k === bestOverKey,
          isBestUnder: k === bestUnderKey,
        });
      }
    }

    const isHome = playerEvent.home_team.toLowerCase().includes(teamWords[teamWords.length - 1] ?? '');
    const opponent = isHome ? playerEvent.away_team : playerEvent.home_team;

    res.json({
      playerId,
      playerName,
      teamName,
      opponent,
      gameTime: playerEvent.commence_time,
      props,
      count: props.length,
    });
  } catch (err: any) {
    logger.error('[Players] props error:', err.message);
    res.status(500).json({ error: 'Failed to fetch player props' });
  }
});

// ── GET /api/players/:playerId/analysis ───────────────────────────────────────
// Query params: ?stat=points&line=24.5&bookmaker=fanduel
router.get('/:playerId/analysis', requireAuth, requireStarter, async (req: Request, res: Response) => {
  const playerId = Number(req.params.playerId);
  const stat = (req.query.stat as string) || 'points';
  const line = parseFloat((req.query.line as string) || '0');
  const bookmaker = (req.query.bookmaker as string) || 'fanduel';

  if (isNaN(playerId)) {
    res.status(400).json({ error: 'Invalid playerId' });
    return;
  }

  const VALID_STATS = ['points', 'rebounds', 'assists', 'threes', 'pra', 'steals', 'blocks'];
  if (!VALID_STATS.includes(stat)) {
    res.status(400).json({ error: `Invalid stat. Must be one of: ${VALID_STATS.join(', ')}` });
    return;
  }

  if (isNaN(line)) {
    res.status(400).json({ error: 'Invalid line — must be a number' });
    return;
  }

  const VALID_BOOKMAKERS = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'espnbet'];
  const safeBookmaker = VALID_BOOKMAKERS.includes(bookmaker) ? bookmaker : 'fanduel';

  try {
    const cacheKey = `player-analysis:${playerId}:${stat}:${line}`;
    const ttl = isGameHours() ? ANALYSIS_TTL_GAME_HOURS : ANALYSIS_TTL_OFF_HOURS;

    const analysis = await getOrFetch(cacheKey, ttl, () =>
      computePlayerAnalysis(playerId, stat as any, line, safeBookmaker)
    );

    res.json({ playerId, stat, line, bookmaker: safeBookmaker, analysis });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, '[Players] analysis error');
    // Return partial analysis with safe defaults rather than 500
    res.json({
      playerId, stat, line, bookmaker,
      analysis: {
        last20Games: [], hitRate10: 0, hitRate5: 0,
        currentStreak: { type: 'miss' as const, count: 0 },
        last20Values: [], trendDirection: 'flat' as const, trendDelta: 0,
        seasonAverage: 0, last5Average: 0, last10Average: 0,
        edge: 0, edgeDirection: 'over' as const,
        standardDeviation: 0, coefficientOfVariation: 0,
        volatilityRating: 'medium' as const,
        minutesTrend: [], minutesAvg5: 0, minutesAvg10: 0, minutesFlag: false,
        homeSplits: { games: 0, avg: 0, hitRate: 0 },
        awaySplits: { games: 0, avg: 0, hitRate: 0 },
        b2bSplits: { games: 0, avg: 0, hitRate: 0 },
        restedSplits: { games: 0, avg: 0, hitRate: 0 },
        opponent: null, opponentPaceRank: null, opponentDefRating: null,
        allBooks: [], bestOverBook: null, bestUnderBook: null, lineSpread: 0,
        oddsQuota: { remaining: -1, used: -1, isLow: false },
      },
      _error: msg,
    });
  }
});

// ── GET /api/players/:playerId/detail/lab ────────────────────────────────────
router.get('/:playerId/detail/lab', requireAuth, requireStarter, async (req: Request, res: Response) => {
  const playerId = Number(req.params.playerId);
  const stat = (req.query.stat as string) || 'points';
  const line = parseFloat((req.query.line as string) || '0');
  const bookmaker = (req.query.bookmaker as string) || 'fanduel';
  if (isNaN(playerId) || playerId <= 0) { res.status(400).json({ error: 'Invalid playerId' }); return; }
  try {
    const cacheKey = `player-detail:${playerId}:${stat}:${line}`;
    const ttl = isGameHours() ? ANALYSIS_TTL_GAME_HOURS : ANALYSIS_TTL_OFF_HOURS;
    const detail = await getOrFetch(cacheKey, ttl, () => computePlayerDetail(playerId, stat as any, line, bookmaker));
    res.json(detail);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, stack: err instanceof Error ? err.stack : undefined }, '[Players] detail/lab error');
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/players/:playerId/detail ────────────────────────────────────────
// Unified endpoint: returns ALL data the player detail page needs in one response.
// Query params: ?stat=points&line=0&bookmaker=fanduel
// When line=0, the endpoint resolves the line from TheOddsAPI or falls back to season avg.
router.get('/:playerId/detail', requireAuth, async (req: Request, res: Response) => {
  const playerId = Number(req.params.playerId);
  const stat = (req.query.stat as string) || 'points';
  const line = parseFloat((req.query.line as string) || '0');
  const bookmaker = (req.query.bookmaker as string) || 'fanduel';

  if (isNaN(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'Invalid playerId — must be a positive integer' });
    return;
  }

  const VALID_STATS = ['points', 'rebounds', 'assists', 'threes', 'pra', 'steals', 'blocks'];
  if (!VALID_STATS.includes(stat)) {
    res.status(400).json({ error: `Invalid stat. Must be one of: ${VALID_STATS.join(', ')}` });
    return;
  }

  try {
    const cacheKey = `player-detail:${playerId}:${stat}:${line}`;
    const ttl = isGameHours() ? ANALYSIS_TTL_GAME_HOURS : ANALYSIS_TTL_OFF_HOURS;

    const detail = await getOrFetch(cacheKey, ttl, () =>
      computePlayerDetail(playerId, stat as any, line, bookmaker)
    );

    // Strip analytics fields for free-tier users
    const authReq = req as AuthenticatedRequest;
    const tier = authReq.userId ? await getUserTier(authReq.userId) : 'free';
    if (tier === 'free' && detail) {
      const d = detail as any;
      d.projection = null;
      d.edge = null;
      d.hitRates = null;
      d.momentum = null;
      d.trajectory = null;
      d.recommendation = null;
      d.consistency = null;
      d.distribution = null;
      d.splits = null;
      d.vsOpponent = null;
      d.lineShopping = null;
      d.radarMetrics = null;
    }

    res.json(detail);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ err: msg, stack }, '[Players] detail error');
    res.status(500).json({ error: 'Failed to load player detail' });
  }
});

export default router;
