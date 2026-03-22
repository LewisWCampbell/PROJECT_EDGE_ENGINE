/**
 * Player Analysis Service
 * Computes streak, trajectory, volatility, splits, and line-shopping data
 * from enriched game logs + TheOddsAPI for the /analysis endpoint.
 */

import { getPlayerGameLogs, getPlayerInfo, playerNameMatches, EnrichedGameLog } from './apiSports';
import { getNBAOdds, getNBAPlayerProps, isQuotaLow, getQuotaStatus } from './oddsApi';
import { getPrizePicksLine } from './prizePicks';
import { getUnderdogLine } from './underdogFantasy';

// ── Stat key helpers ──────────────────────────────────────────────────────────

export type StatKey = 'points' | 'rebounds' | 'assists' | 'threes' | 'pra' | 'steals' | 'blocks';

const ODDS_MARKET_MAP: Record<StatKey, string> = {
  points: 'player_points',
  rebounds: 'player_rebounds',
  assists: 'player_assists',
  threes: 'player_threes',
  pra: 'player_points_rebounds_assists',
  steals: 'player_steals',
  blocks: 'player_blocks',
};

export function getStatValue(log: EnrichedGameLog, stat: StatKey): number {
  switch (stat) {
    case 'points':   return Number(log.points)    || 0;
    case 'rebounds': return Number(log.totReb)    || 0;
    case 'assists':  return Number(log.assists)   || 0;
    case 'threes':   return Number(log.tpm)       || 0;
    case 'steals':   return Number(log.steals)    || 0;
    case 'blocks':   return Number(log.blocks)    || 0;
    case 'pra':
      return (Number(log.points) || 0) +
             (Number(log.totReb) || 0) +
             (Number(log.assists) || 0);
  }
}

export function parseMinutes(min: string | null): number {
  if (!min || min === '0') return 0;
  const parts = min.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
  }
  return parseFloat(min) || 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + Math.pow(v - m, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// ── Return type ───────────────────────────────────────────────────────────────

export interface BookLine {
  bookmaker_key: string;
  bookmaker_title: string;
  over_price: number;
  under_price: number;
  line: number;
  is_best_over: boolean;
  is_best_under: boolean;
}

export interface PlayerAnalysis {
  // Streak
  last20Games: Array<{
    game_date: string;
    opponent_name: string;
    was_home_game: boolean;
    game_result: 'W' | 'L' | null;
    stat_value: number;
    hit: boolean;
    minutes_played: number;
  }>;
  hitRate10: number;
  hitRate5: number;
  currentStreak: { type: 'hit' | 'miss'; count: number };

  // Trajectory
  last20Values: Array<{ game_date: string; value: number; minutes: number }>;
  trendDirection: 'up' | 'down' | 'flat';
  trendDelta: number;
  seasonAverage: number;
  last5Average: number;
  last10Average: number;

  // Edge
  edge: number;
  edgeDirection: 'over' | 'under';

  // Volatility
  standardDeviation: number;
  coefficientOfVariation: number;
  volatilityRating: 'low' | 'medium' | 'high';
  minutesTrend: number[];
  minutesAvg5: number;
  minutesAvg10: number;
  minutesFlag: boolean;

  // Splits
  homeSplits: { games: number; avg: number; hitRate: number };
  awaySplits: { games: number; avg: number; hitRate: number };
  b2bSplits: { games: number; avg: number; hitRate: number };
  restedSplits: { games: number; avg: number; hitRate: number };

  // Opponent context
  opponent: { name: string; id: number } | null;
  opponentPaceRank: null;
  opponentDefRating: null;

  // Line shopping (null if quota low or unavailable)
  allBooks: BookLine[];
  bestOverBook: { bookmaker_title: string; line: number; price: number } | null;
  bestUnderBook: { bookmaker_title: string; line: number; price: number } | null;
  lineSpread: number;

  // Quota status
  oddsQuota: { remaining: number; used: number; isLow: boolean };
}

// ── BOOK_ORDER for displaying in preferred order ──────────────────────────────
const BOOK_ORDER = ['fanduel', 'draftkings', 'prizepicks', 'underdog', 'betmgm', 'caesars', 'espnbet'];

// ── Main computation ──────────────────────────────────────────────────────────

export async function computePlayerAnalysis(
  playerId: number,
  stat: StatKey,
  line: number,
  bookmaker: string = 'fanduel'
): Promise<PlayerAnalysis> {
  // Fetch up to 50 game logs (DB first, live API fallback) + player info
  console.log(`[PlayerAnalysis] Computing analysis for player ${playerId}, stat=${stat}, line=${line}`);
  const [logs, playerInfo] = await Promise.all([
    getPlayerGameLogs(playerId, 50),
    getPlayerInfo(playerId),
  ]);
  console.log(`[PlayerAnalysis] Got ${logs.length} game logs, playerInfo: ${playerInfo ? `${playerInfo.firstname} ${playerInfo.lastname}` : 'null'}`);

  // Filter to played games only (have minutes > 0)
  const played = logs.filter((g) => parseMinutes(g.min) > 0);

  // ── last20Games ──────────────────────────────────────────────────────────
  // Sort oldest → newest for display
  const chronological = [...played].sort(
    (a, b) => new Date(a.game_date).getTime() - new Date(b.game_date).getTime()
  );

  const last20Games = chronological.map((g) => ({
    game_date: g.game_date,
    opponent_name: g.opponent_name,
    was_home_game: g.was_home_game,
    game_result: g.game_result,
    stat_value: getStatValue(g, stat),
    hit: getStatValue(g, stat) > line,
    minutes_played: parseMinutes(g.min),
  }));

  // ── Hit rates (most-recent first order for L5/L10) ───────────────────────
  const recentFirst = [...played]; // already sorted newest-first from getEnrichedGameLogs

  const last5 = recentFirst.slice(0, 5);
  const last10 = recentFirst.slice(0, 10);

  const hitRate5 = last5.length
    ? last5.filter((g) => getStatValue(g, stat) > line).length / last5.length
    : 0;
  const hitRate10 = last10.length
    ? last10.filter((g) => getStatValue(g, stat) > line).length / last10.length
    : 0;

  // ── Current streak ───────────────────────────────────────────────────────
  let streakType: 'hit' | 'miss' = recentFirst[0] && getStatValue(recentFirst[0], stat) > line ? 'hit' : 'miss';
  let streakCount = 0;
  for (const g of recentFirst) {
    const hit = getStatValue(g, stat) > line;
    if ((hit && streakType === 'hit') || (!hit && streakType === 'miss')) {
      streakCount++;
    } else {
      break;
    }
  }

  // ── Trajectory (oldest → newest) ─────────────────────────────────────────
  const last20Values = chronological.map((g) => ({
    game_date: g.game_date,
    value: getStatValue(g, stat),
    minutes: parseMinutes(g.min),
  }));

  const seasonAverage = played.length
    ? Math.round(mean(played.map((g) => getStatValue(g, stat))) * 10) / 10
    : 0;
  const last5Values = last5.map((g) => getStatValue(g, stat));
  const last5Average = Math.round(mean(last5Values) * 10) / 10;
  const last10Values = last10.map((g) => getStatValue(g, stat));
  const last10Average = Math.round(mean(last10Values) * 10) / 10;

  // Trend: compare avg of last 5 vs games 6–10
  const games610 = recentFirst.slice(5, 10);
  const avg610 = mean(games610.map((g) => getStatValue(g, stat)));
  const trendDelta = games610.length >= 2 ? Math.round((last5Average - avg610) * 10) / 10 : 0;
  let trendDirection: 'up' | 'down' | 'flat' = 'flat';
  if (games610.length >= 2) {
    if (trendDelta > 0.5) trendDirection = 'up';
    else if (trendDelta < -0.5) trendDirection = 'down';
  }

  // Edge: how far L5 avg is from the line, as a percentage
  const edge = line > 0 ? Math.round(((last5Average - line) / line) * 1000) / 10 : 0;
  const edgeDirection: 'over' | 'under' = last5Average >= line ? 'over' : 'under';

  // ── Volatility ───────────────────────────────────────────────────────────
  const allValues = played.map((g) => getStatValue(g, stat));
  const sd = Math.round(stdDev(allValues) * 100) / 100;
  const m = mean(allValues);
  const cv = m > 0 ? Math.round((sd / m) * 100) / 100 : 0;
  const volatilityRating: 'low' | 'medium' | 'high' =
    cv < 0.25 ? 'low' : cv <= 0.45 ? 'medium' : 'high';

  const minutesLast10 = last10.map((g) => parseMinutes(g.min));
  const minutesLast5 = last5.map((g) => parseMinutes(g.min));
  const minutesAvg5 = Math.round(mean(minutesLast5) * 10) / 10;
  const minutesAvg10 = Math.round(mean(minutesLast10) * 10) / 10;
  const minutesAllSeason = played.map((g) => parseMinutes(g.min));
  const minutesSeasonAvg = mean(minutesAllSeason);
  const lastGameMinutes = recentFirst[0] ? parseMinutes(recentFirst[0].min) : minutesSeasonAvg;
  const minutesFlag = lastGameMinutes < minutesSeasonAvg - 4;

  // Oldest→newest for last 5
  const minutesTrend = [...minutesLast5].reverse();

  // ── Splits ────────────────────────────────────────────────────────────────
  const homeGames = played.filter((g) => g.was_home_game);
  const awayGames = played.filter((g) => !g.was_home_game);

  function splitStats(games: EnrichedGameLog[]) {
    if (games.length === 0) return { games: 0, avg: 0, hitRate: 0 };
    const vals = games.map((g) => getStatValue(g, stat));
    const hits = vals.filter((v) => v > line).length;
    return {
      games: games.length,
      avg: Math.round(mean(vals) * 10) / 10,
      hitRate: Math.round((hits / games.length) * 100) / 100,
    };
  }

  // Compute rest days: sort chronologically and compute gap
  function calcRestDays(logs: EnrichedGameLog[]): (EnrichedGameLog & { restDays: number })[] {
    const sorted = [...logs]
      .filter((g) => g.game_date)
      .sort((a, b) => new Date(a.game_date).getTime() - new Date(b.game_date).getTime());

    return sorted.map((g, i) => {
      if (i === 0) return { ...g, restDays: 99 }; // assume rested for first game
      const curr = new Date(g.game_date).getTime();
      const prev = new Date(sorted[i - 1].game_date).getTime();
      const days = Math.floor((curr - prev) / (1000 * 60 * 60 * 24));
      return { ...g, restDays: days };
    });
  }

  const withRest = calcRestDays(played);
  const b2bGames = withRest.filter((g) => g.restDays <= 1);
  const restedGames = withRest.filter((g) => g.restDays >= 2);

  const homeSplits = splitStats(homeGames);
  const awaySplits = splitStats(awayGames);
  const b2bSplits = splitStats(b2bGames);
  const restedSplits = splitStats(restedGames);

  // ── Opponent context ──────────────────────────────────────────────────────
  const mostRecent = recentFirst[0];
  const opponent = mostRecent
    ? { name: mostRecent.opponent_name, id: mostRecent.opponent_id }
    : null;

  // ── Line shopping ─────────────────────────────────────────────────────────
  let allBooks: BookLine[] = [];
  let bestOverBook: PlayerAnalysis['bestOverBook'] = null;
  let bestUnderBook: PlayerAnalysis['bestUnderBook'] = null;
  let lineSpread = 0;

  // Skip odds call entirely if quota is low
  if (isQuotaLow()) {
    console.warn(`⚠️ Odds API quota low — skipping line shopping for player ${playerId}`);
  }

  try {
    const playerName = playerInfo
      ? `${playerInfo.firstname} ${playerInfo.lastname}`
      : '';
    const playerTeamName = mostRecent?.team?.name ?? '';
    const oddsMarket = ODDS_MARKET_MAP[stat];

    if (playerName && playerTeamName && oddsMarket && !isQuotaLow()) {
      // Find the event for the player's team
      const events = await getNBAOdds();
      const teamNameLower = playerTeamName.toLowerCase();

      const playerEvent = events.find(
        (e) =>
          e.home_team.toLowerCase().includes(teamNameLower) ||
          e.away_team.toLowerCase().includes(teamNameLower)
      );

      if (playerEvent) {
        const propsEvent = await getNBAPlayerProps(playerEvent.id);
        if (propsEvent) {
          // Collect per-book line data for this player + stat
          const bookData: Record<string, { over: number; under: number; line: number }> = {};

          for (const book of propsEvent.bookmakers) {
            const market = book.markets.find((m) => m.key === oddsMarket);
            if (!market) continue;

            const overOutcome = market.outcomes.find(
              (o) =>
                o.name.toLowerCase() === 'over' &&
                playerNameMatches(playerName, o.description ?? '')
            );
            const underOutcome = market.outcomes.find(
              (o) =>
                o.name.toLowerCase() === 'under' &&
                playerNameMatches(playerName, o.description ?? '')
            );

            if (overOutcome && underOutcome) {
              bookData[book.key] = {
                over: overOutcome.price,
                under: underOutcome.price,
                line: overOutcome.point ?? line,
              };
            }
          }

          // Find best over (highest price) and best under (highest price)
          const keys = BOOK_ORDER.filter((k) => bookData[k]);
          const otherKeys = Object.keys(bookData).filter((k) => !BOOK_ORDER.includes(k));
          const orderedKeys = [...keys, ...otherKeys];

          if (orderedKeys.length > 0) {
            const lines = orderedKeys.map((k) => bookData[k].line);
            const maxLine = Math.max(...lines);
            const minLine = Math.min(...lines);
            lineSpread = Math.round((maxLine - minLine) * 10) / 10;

            const bestOverKey = orderedKeys.reduce((best, k) =>
              bookData[k].over > bookData[best].over ? k : best
            );
            const bestUnderKey = orderedKeys.reduce((best, k) =>
              bookData[k].under > bookData[best].under ? k : best
            );

            const bookTitles: Record<string, string> = {
              fanduel: 'FanDuel',
              draftkings: 'DraftKings',
              prizepicks: 'PrizePicks',
              underdog: 'Underdog',
              betmgm: 'BetMGM',
              caesars: 'Caesars',
              espnbet: 'ESPN BET',
            };

            allBooks = orderedKeys.map((k) => ({
              bookmaker_key: k,
              bookmaker_title: bookTitles[k] ?? k,
              over_price: bookData[k].over,
              under_price: bookData[k].under,
              line: bookData[k].line,
              is_best_over: k === bestOverKey,
              is_best_under: k === bestUnderKey,
            }));

            bestOverBook = {
              bookmaker_title: bookTitles[bestOverKey] ?? bestOverKey,
              line: bookData[bestOverKey].line,
              price: bookData[bestOverKey].over,
            };
            bestUnderBook = {
              bookmaker_title: bookTitles[bestUnderKey] ?? bestUnderKey,
              line: bookData[bestUnderKey].line,
              price: bookData[bestUnderKey].under,
            };
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('[PlayerAnalysis] Line shopping failed:', err.message);
    // Non-fatal — continue without odds
  }

  // ── DFS platform lines (PrizePicks + Underdog) ───────────────────────────
  // These are line-only (no over/under odds), so over_price and under_price are 0.
  try {
    const playerName = playerInfo
      ? `${playerInfo.firstname} ${playerInfo.lastname}`
      : '';

    if (playerName) {
      const [ppLine, udLine] = await Promise.all([
        getPrizePicksLine(playerName, stat),
        getUnderdogLine(playerName, stat),
      ]);

      const dfsBooks: BookLine[] = [];

      if (ppLine !== null) {
        dfsBooks.push({
          bookmaker_key: 'prizepicks',
          bookmaker_title: 'PrizePicks',
          over_price: 0,
          under_price: 0,
          line: ppLine,
          is_best_over: false,
          is_best_under: false,
        });
      }

      if (udLine !== null) {
        dfsBooks.push({
          bookmaker_key: 'underdog',
          bookmaker_title: 'Underdog',
          over_price: 0,
          under_price: 0,
          line: udLine,
          is_best_over: false,
          is_best_under: false,
        });
      }

      if (dfsBooks.length > 0) {
        // Merge DFS books into allBooks in BOOK_ORDER position
        const merged = [...allBooks, ...dfsBooks];
        allBooks = merged.sort((a, b) => {
          const ai = BOOK_ORDER.indexOf(a.bookmaker_key);
          const bi = BOOK_ORDER.indexOf(b.bookmaker_key);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

        // Recompute line spread across all books (including DFS)
        if (allBooks.length > 1) {
          const allLines = allBooks.map((b) => b.line);
          lineSpread = Math.round((Math.max(...allLines) - Math.min(...allLines)) * 10) / 10;
        }
      }
    }
  } catch (err: any) {
    console.warn('[PlayerAnalysis] DFS line fetch failed:', err.message);
    // Non-fatal — continue without DFS lines
  }

  return {
    last20Games,
    hitRate10,
    hitRate5,
    currentStreak: { type: streakType, count: streakCount },

    last20Values,
    trendDirection,
    trendDelta,
    seasonAverage,
    last5Average,
    last10Average,

    edge,
    edgeDirection,

    standardDeviation: sd,
    coefficientOfVariation: cv,
    volatilityRating,
    minutesTrend,
    minutesAvg5,
    minutesAvg10,
    minutesFlag,

    homeSplits,
    awaySplits,
    b2bSplits,
    restedSplits,

    opponent,
    opponentPaceRank: null,
    opponentDefRating: null,

    allBooks,
    bestOverBook,
    bestUnderBook,
    lineSpread,

    oddsQuota: getQuotaStatus(),
  };
}
