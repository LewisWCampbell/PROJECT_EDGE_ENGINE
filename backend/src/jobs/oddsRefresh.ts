/**
 * Odds Refresh Job — runs every 30 minutes during game hours (11 AM – 11 PM ET)
 *
 * 1. Fetch TheOddsAPI player props → store all events + props in Redis
 * 2. Fetch PrizePicks lines → store in Redis
 * 3. Fetch Underdog lines → store in Redis
 * 4. Pre-compute projections using DB game_logs + fresh odds → write to Supabase
 *
 * After this job runs, all user-facing routes read exclusively from Redis/Supabase.
 * Zero on-demand API-Sports or TheOddsAPI calls from user requests.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin';
import { redisSetJSON, redisGetJSON } from '../lib/redis';
import logger from '../lib/logger';
import { isLow as isQuotaLow } from '../cache/oddsQuota';
import { getNBAOdds, getNBAPlayerProps, NBAOddsEvent, PlayerPropsEvent } from '../services/oddsApi';
import { getPrizePicksProjections } from '../services/prizePicks';
import { getUnderdogLines } from '../services/underdogFantasy';
import { getOpponentDefFactor } from '../services/teamDefense';
import { resolveNBAPersonId, headshotUrl } from '../services/nbaPlayers';
import {
  buildEnhancedProjection,
  ODDS_API_MARKET_MAP,
  type StatKey,
} from '../services/projections';
import type { ApiSportsPlayerStats } from '../services/apiSports';
import { playerNameMatches, normalizePlayerName } from '../services/apiSports';

// ── Redis key constants ────────────────────────────────────────────────────────
export const REDIS_KEYS = {
  ODDS_EVENTS:   'odds:events:today',
  ODDS_PROPS:    'odds:props:today',     // { "PlayerName:stat": { line, overOdds, underOdds, bookmaker } }
  PRIZEPICKS:    'prizepicks:today',
  UNDERDOG:      'underdog:today',
  PROJECTIONS:   'projections:today',
  COMPUTED_AT:   'projections:computed_at',
};

const REDIS_TTL_ODDS = 35 * 60;          // 35 minutes — longer than refresh interval
const REDIS_TTL_PROJECTIONS = 60 * 60;  // 1 hour — fresh after each odds cycle

// ── Bookmaker priority for best-line selection ────────────────────────────────
const BOOK_PRIORITY = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'espnbet'];

interface BestLine {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  bookmaker: string;
}

// ── Convert Supabase game_log row → ApiSportsPlayerStats (model input shape) ──
function gameLogToStats(row: Record<string, any>): ApiSportsPlayerStats {
  return {
    player:     { id: row.player_id ?? 0, name: row.player_name ?? '' },
    team:       { id: row.team_id ?? 0, name: row.team_name ?? '' },
    game:       { id: row.game_id ?? 0 },
    points:     row.pts ?? null,
    min:        row.minutes != null ? String(Math.round(row.minutes)) : null,
    totReb:     row.reb ?? null,
    assists:    row.ast ?? null,
    tpm:        row.tpm ?? null,
    steals:     row.stl ?? null,
    turnovers:  row.turnovers ?? null,
    blocks:     row.blk ?? null,
    pos: null, fgm: null, fga: null, fgp: null,
    ftm: null, fta: null, ftp: null,
    tpa: null, tpp: null,
    offReb: null, defReb: null,
    pFouls: null, plusMinus: null, comment: null,
  };
}

// ── Step 1: Fetch + cache TheOddsAPI props ────────────────────────────────────

async function fetchAndCacheOdds(): Promise<{
  events: NBAOddsEvent[];
  propsByPlayerStat: Map<string, BestLine>;
  eventProps: Map<string, PlayerPropsEvent>;
  allBookLines: Map<string, Record<string, number | null>>;
}> {
  const events = await getNBAOdds();
  const propsByPlayerStat = new Map<string, BestLine>();
  const eventProps = new Map<string, PlayerPropsEvent>();

  if (events.length === 0) {
    logger.info('[OddsRefresh] No NBA events from TheOddsAPI');
    await redisSetJSON(REDIS_KEYS.ODDS_EVENTS, [], REDIS_TTL_ODDS);
    await redisSetJSON(REDIS_KEYS.ODDS_PROPS, {}, REDIS_TTL_ODDS);
    return { events: [], propsByPlayerStat, eventProps, allBookLines: new Map() };
  }

  // Fetch all event props in parallel (respects existing node-cache layer)
  const propResults = await Promise.allSettled(
    events.map(async (evt) => {
      const props = await getNBAPlayerProps(evt.id);
      if (props) eventProps.set(evt.id, props);
      return props;
    })
  );

  // Build the flat playerName:stat → BestLine map
  // Also build per-book lines map for the board's left/right columns
  const allBookLines = new Map<string, Record<string, number | null>>(); // mapKey → { fanduel: 24.5, draftkings: 25.0, ... }

  for (let i = 0; i < events.length; i++) {
    const result = propResults[i];
    if (result.status !== 'fulfilled' || !result.value) continue;
    const propsEvent = result.value;

    for (const book of propsEvent.bookmakers) {
      for (const market of book.markets) {
        const statKey = ODDS_API_MARKET_MAP[market.key];
        if (!statKey) continue;

        const seenPlayers = new Set<string>();
        for (const outcome of market.outcomes) {
          if (!outcome.description || outcome.name !== 'Over') continue;
          if (seenPlayers.has(outcome.description)) continue;
          seenPlayers.add(outcome.description);

          const mapKey = `${outcome.description.toLowerCase()}:${statKey}`;

          // Collect per-book lines
          if (outcome.point && outcome.point > 0) {
            if (!allBookLines.has(mapKey)) allBookLines.set(mapKey, {});
            allBookLines.get(mapKey)![book.key] = outcome.point;
          }

          const existing = propsByPlayerStat.get(mapKey);

          // Accept this book if it has higher priority or no existing entry
          const existingPriority = existing
            ? BOOK_PRIORITY.indexOf(existing.bookmaker)
            : 999;
          const thisPriority = BOOK_PRIORITY.indexOf(book.key);
          if (existing && thisPriority >= existingPriority) continue;
          if (!outcome.point || outcome.point <= 0) continue;

          const under = market.outcomes.find(
            (o) => o.name === 'Under' && o.description === outcome.description
          );

          propsByPlayerStat.set(mapKey, {
            line:      outcome.point,
            overOdds:  outcome.price ?? null,
            underOdds: under?.price ?? null,
            bookmaker: book.key,
          });
        }
      }
    }
  }

  // Serialize to Redis — Map → plain object for JSON
  const propsObj: Record<string, BestLine> = {};
  for (const [k, v] of propsByPlayerStat.entries()) propsObj[k] = v;

  await redisSetJSON(REDIS_KEYS.ODDS_EVENTS, events, REDIS_TTL_ODDS);
  await redisSetJSON(REDIS_KEYS.ODDS_PROPS, propsObj, REDIS_TTL_ODDS);

  logger.info(
    { events: events.length, props: propsByPlayerStat.size },
    '[OddsRefresh] Odds cached to Redis'
  );
  return { events, propsByPlayerStat, eventProps, allBookLines };
}

// ── Step 2: Fetch + cache DFS lines (PrizePicks + Underdog) ──────────────────

/** Fetch PrizePicks + Underdog lines. Returns maps keyed by "name:stat" → line number. */
async function fetchAndCacheDFSLines(): Promise<{
  ppLines: Map<string, number>;
  udLines: Map<string, number>;
}> {
  const [ppMap, udMap] = await Promise.allSettled([
    getPrizePicksProjections(),
    getUnderdogLines(),
  ]);

  // Serialize Map → array of entries for JSON
  const ppEntries = ppMap.status === 'fulfilled'
    ? [...ppMap.value.entries()]
    : [];
  const udEntries = udMap.status === 'fulfilled'
    ? [...udMap.value.entries()]
    : [];

  await Promise.all([
    redisSetJSON(REDIS_KEYS.PRIZEPICKS, ppEntries, REDIS_TTL_ODDS),
    redisSetJSON(REDIS_KEYS.UNDERDOG,   udEntries, REDIS_TTL_ODDS),
  ]);

  // Build simple name:stat → line maps for merging into bookLines
  const ppLines = new Map<string, number>();
  for (const [key, val] of ppEntries) ppLines.set(key, (val as any).line ?? (val as any));
  const udLines = new Map<string, number>();
  for (const [key, val] of udEntries) udLines.set(key, (val as any).line ?? (val as any));

  logger.info(
    { prizepicks: ppEntries.length, underdog: udEntries.length },
    '[OddsRefresh] DFS lines cached to Redis'
  );

  return { ppLines, udLines };
}

// ── Step 3: Pre-compute projections from DB game_logs ────────────────────────

async function preComputeProjections(
  propsByPlayerStat: Map<string, BestLine>,
  oddsEvents: NBAOddsEvent[],
  eventProps: Map<string, PlayerPropsEvent>,
  allBookLines: Map<string, Record<string, number | null>>
): Promise<void> {
  if (propsByPlayerStat.size === 0) {
    logger.info('[OddsRefresh] No props to project');
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  // Get unique player names from the props map
  const uniquePlayers = [...new Set(
    [...propsByPlayerStat.keys()].map((k) => {
      const parts = k.split(':');
      parts.pop(); // remove stat key
      return parts.join(':'); // reconstruct player name (handles colons in names)
    })
  )];

  // Batch-fetch game logs for all players from Supabase
  // We query by lowercase player name similarity — Supabase doesn't have fuzzy,
  // so we fetch all recent logs and match in-process.
  const { data: allRecentLogs, error: logsError } = await supabaseAdmin
    .from('game_logs')
    .select('*')
    .gte('game_date', (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0]; })())
    .order('game_date', { ascending: false });

  if (logsError) {
    logger.warn({ err: logsError.message }, '[OddsRefresh] Failed to fetch game_logs from DB');
    return;
  }

  if (!allRecentLogs || allRecentLogs.length === 0) {
    logger.info('[OddsRefresh] No game_logs in DB yet — skipping projection pre-computation');
    return;
  }

  // Group game_logs by player_id (numeric, stable across name format changes).
  // API-Sports returns names inconsistently ("James LeBron" vs "L. James"),
  // so name-based grouping fragments a player's logs across multiple keys.
  // player_id is the same regardless of name format.
  const logsByPlayerId = new Map<number, typeof allRecentLogs>();
  // Map every normalized name variant → player_id so we can bridge from
  // TheOddsAPI names (which are always "Firstname Lastname") to the numeric ID.
  const playerIdByNormName = new Map<string, number>();
  const originalNameByNorm = new Map<string, string>();
  const dbPlayerNames = new Map<number, string>(); // player_id → most recent raw name
  for (const row of allRecentLogs) {
    const playerId = row.player_id as number;
    const rawName = row.player_name as string;
    if (!playerId || playerId <= 0) continue;

    if (!logsByPlayerId.has(playerId)) logsByPlayerId.set(playerId, []);
    logsByPlayerId.get(playerId)!.push(row);

    // Register every name variant for this player_id
    const normName = normalizePlayerName(rawName);
    playerIdByNormName.set(normName, playerId);
    if (!originalNameByNorm.has(normName)) originalNameByNorm.set(normName, rawName);
    if (!dbPlayerNames.has(playerId)) dbPlayerNames.set(playerId, rawName);
  }

  // Legacy alias — some downstream code references logsByPlayer for context lookups
  const logsByPlayer = new Map<string, typeof allRecentLogs>();
  for (const [normName, pid] of playerIdByNormName.entries()) {
    logsByPlayer.set(normName, logsByPlayerId.get(pid) ?? []);
  }

  // Build event context: playerName → { homeTeam, awayTeam, isHome, gameTime, opponent }
  const playerContext = new Map<string, {
    homeTeam: string; awayTeam: string; isHome: boolean;
    gameTime: string; opponent: string; teamName: string;
  }>();

  for (const [evtId, propsEvent] of eventProps.entries()) {
    const players = new Set<string>();
    for (const book of propsEvent.bookmakers) {
      for (const mkt of book.markets) {
        for (const o of mkt.outcomes) {
          if (o.description) players.add(o.description);
        }
      }
    }
    for (const playerName of players) {
      // Determine home/away from game_logs
      const normName = normalizePlayerName(playerName);
      let playerLogs = logsByPlayer.get(normName);
      // Fallback: try playerNameMatches with original names
      if (!playerLogs) {
        for (const [key, logs] of logsByPlayer.entries()) {
          const originalDbName = originalNameByNorm.get(key) ?? key;
          if (playerNameMatches(originalDbName, playerName) || playerNameMatches(playerName, originalDbName)) {
            playerLogs = logs;
            break;
          }
        }
      }
      let isHome = false;
      let teamName = '';
      if (playerLogs && playerLogs.length > 0) {
        const recentLog = playerLogs[0];
        // Determine if player is on home or away team by comparing team_name with event teams
        const homeLower = propsEvent.home_team.toLowerCase();
        const teamLower = (recentLog.team_name as string).toLowerCase();
        const homeWords = homeLower.split(/\s+/).filter((w: string) => w.length > 3);
        isHome = homeWords.some((w: string) => teamLower.includes(w));
        teamName = recentLog.team_name as string;
      }
      playerContext.set(playerName, {
        homeTeam:  propsEvent.home_team,
        awayTeam:  propsEvent.away_team,
        isHome,
        gameTime:  propsEvent.commence_time,
        opponent:  isHome ? propsEvent.away_team : propsEvent.home_team,
        teamName,
      });
    }
  }

  // Build pre_computed_props rows
  const rows: Record<string, any>[] = [];
  const unmatchedPlayers = new Set<string>();
  const insufficientDataPlayers = new Map<string, number>(); // name → log count

  for (const [mapKey, bestLine] of propsByPlayerStat.entries()) {
    const colonIdx = mapKey.lastIndexOf(':');
    const playerNameLower = mapKey.substring(0, colonIdx);
    const statKey = mapKey.substring(colonIdx + 1) as StatKey;

    // Find the canonical player name (from TheOddsAPI description)
    let canonicalName: string | null = null;
    for (const [evtId, propsEvent] of eventProps.entries()) {
      for (const book of propsEvent.bookmakers) {
        for (const mkt of book.markets) {
          const outcome = mkt.outcomes.find(
            (o) => o.description && o.description.toLowerCase() === playerNameLower
          );
          if (outcome?.description) { canonicalName = outcome.description; break; }
        }
        if (canonicalName) break;
      }
      if (canonicalName) break;
    }
    if (!canonicalName) continue;

    // Look up game logs by player_id (via normalized name → player_id → logs).
    // This ensures ALL of a player's games are returned even if API-Sports
    // used different name formats across games.
    const normName = normalizePlayerName(canonicalName);
    let matchedPlayerId = playerIdByNormName.get(normName);

    // Fallback: fuzzy match against all known DB name variants
    if (!matchedPlayerId) {
      for (const [dbNorm, pid] of playerIdByNormName.entries()) {
        const originalDbName = originalNameByNorm.get(dbNorm) ?? dbNorm;
        if (playerNameMatches(originalDbName, canonicalName) || playerNameMatches(canonicalName, originalDbName)) {
          matchedPlayerId = pid;
          break;
        }
      }
    }

    const matchedLogs = matchedPlayerId ? (logsByPlayerId.get(matchedPlayerId) ?? []) : [];

    if (matchedLogs.length === 0) {
      unmatchedPlayers.add(canonicalName);
      continue;
    }

    const gameLogs = matchedLogs.slice(0, 15).map(gameLogToStats);
    const ctx = playerContext.get(canonicalName);
    const opponentDefFactor = ctx
      ? getOpponentDefFactor(ctx.opponent, statKey)
      : 1.0;

    const projection = buildEnhancedProjection({
      gameLogs,
      line:            bestLine.line,
      stat:            statKey,
      overOdds:        bestLine.overOdds,
      underOdds:       bestLine.underOdds,
      bookmaker:       bestLine.bookmaker,
      opponentDefFactor,
      isHomeGame:      ctx?.isHome,
    });

    if (!projection) {
      insufficientDataPlayers.set(canonicalName, matchedLogs.length);
      continue;
    }

    const firstLog = matchedLogs[0];
    const nbaPersonId = await resolveNBAPersonId(canonicalName).catch(() => null);

    rows.push({
      game_date:      today,
      player_id:      firstLog?.player_id ?? null,
      player_name:    canonicalName,
      team_name:      ctx?.teamName ?? firstLog?.team_name ?? null,
      opponent:       ctx?.opponent ?? null,
      is_home:        ctx?.isHome ?? null,
      game_time:      ctx?.gameTime ?? null,
      stat:           statKey,
      stat_display:   projection.statDisplay,
      line:           projection.line,
      projection:     projection.projection,
      std_dev:        projection.stdDev,
      p_over:         projection.pOver,
      implied_p_over: projection.impliedPOver,
      edge:           projection.edge,
      direction:      projection.direction,
      visbets_score:  projection.visbetsScore,
      confidence:     projection.confidence,
      sample_size:    projection.sampleSize,
      over_odds:      projection.overOdds,
      under_odds:     projection.underOdds,
      bookmaker:      projection.bookmaker,
      model_version:  '2.0.0-ewma',
      headshot_url:   nbaPersonId ? headshotUrl(nbaPersonId) : null,
      computed_at:    new Date().toISOString(),
    });
  }

  logger.info(`[OddsRefresh] Projection matching: ${propsByPlayerStat.size} odds props, ${logsByPlayerId.size} DB players (${playerIdByNormName.size} name variants), ${rows.length} projections computed`);

  if (unmatchedPlayers.size > 0) {
    logger.info({
      count: unmatchedPlayers.size,
      players: [...unmatchedPlayers].sort(),
    }, '[OddsRefresh] Players with odds but NO game_logs in DB (name mismatch or missing data)');
  }
  if (insufficientDataPlayers.size > 0) {
    logger.info({
      count: insufficientDataPlayers.size,
      players: [...insufficientDataPlayers.entries()].map(([name, logs]) => `${name} (${logs} logs)`).sort(),
    }, '[OddsRefresh] Players with game_logs but too few for projection (<3)');
  }

  if (rows.length === 0) {
    logger.info('[OddsRefresh] No projections computed (likely no game_logs in DB yet)');
    return;
  }

  // Attach bookLines to each row for both Redis and DB persistence.
  // This ensures per-book lines survive Redis TTL expiry (Supabase fallback).
  const rowsWithBookLines = rows.map((r: Record<string, any>) => ({
    ...r,
    book_lines: allBookLines.get(`${r.player_name.toLowerCase()}:${r.stat}`) ?? {},
  }));

  // Redis rows use camelCase bookLines for frontend compatibility
  const redisRows = rowsWithBookLines.map((r: Record<string, any>) => ({
    ...r,
    bookLines: r.book_lines,
  }));

  // Upsert to pre_computed_props (book_lines JSONB column)
  const { error: upsertError } = await supabaseAdmin
    .from('pre_computed_props')
    .upsert(rowsWithBookLines, { onConflict: 'game_date,player_name,stat' });

  if (upsertError) {
    logger.warn({ err: upsertError.message }, '[OddsRefresh] pre_computed_props upsert failed');
  }

  // Always cache to Redis (even if DB upsert failed) — Redis is the primary read path
  const sorted = redisRows.sort((a: any, b: any) => Math.abs(b.edge) - Math.abs(a.edge));
  await redisSetJSON(REDIS_KEYS.PROJECTIONS, sorted, REDIS_TTL_PROJECTIONS);
  await redisSetJSON(REDIS_KEYS.COMPUTED_AT, new Date().toISOString(), REDIS_TTL_PROJECTIONS);
  logger.info({ count: rows.length }, '[OddsRefresh] Projections pre-computed and stored');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runOddsRefresh(): Promise<void> {
  // Circuit breaker: skip if quota critically low
  if (isQuotaLow()) {
    logger.warn('[OddsRefresh] Skipping — TheOddsAPI quota is low');
    return;
  }

  const startTime = Date.now();
  logger.info('[OddsRefresh] Started');

  try {
    const { events, propsByPlayerStat, eventProps, allBookLines } = await fetchAndCacheOdds();
    const { ppLines, udLines } = await fetchAndCacheDFSLines();

    // Merge PrizePicks + Underdog lines into allBookLines so they appear
    // in the board's left/right sportsbook columns alongside TheOddsAPI books.
    // PP/UD use different stat keys (rebounds/threes) vs our StatKey (totReb/tpm).
    const dfsStatMap: Record<string, string> = {
      rebounds: 'totReb', threes: 'tpm', blocks: 'blocks', steals: 'steals',
      points: 'points', assists: 'assists',
    };
    const remapDfsKey = (key: string): string => {
      const colonIdx = key.lastIndexOf(':');
      const name = key.substring(0, colonIdx);
      const stat = key.substring(colonIdx + 1);
      return `${name}:${dfsStatMap[stat] ?? stat}`;
    };
    for (const [key, line] of ppLines) {
      const mapped = remapDfsKey(key);
      if (!allBookLines.has(mapped)) allBookLines.set(mapped, {});
      allBookLines.get(mapped)!['prizepicks'] = line;
    }
    for (const [key, line] of udLines) {
      const mapped = remapDfsKey(key);
      if (!allBookLines.has(mapped)) allBookLines.set(mapped, {});
      allBookLines.get(mapped)!['underdog'] = line;
    }

    await preComputeProjections(propsByPlayerStat, events, eventProps, allBookLines);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info({ elapsed }, '[OddsRefresh] Complete');
  } catch (err: any) {
    logger.error({ err: err.message }, '[OddsRefresh] Failed');
    // Don't rethrow — scheduler continues regardless
  }
}
