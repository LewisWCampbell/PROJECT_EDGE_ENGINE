/**
 * Player Detail Service — Unified Orchestrator
 *
 * Composes playerAnalysis, projections, oddsApi, apiSports, nbaPlayers,
 * and teamAbbreviations into a single response for the player detail page.
 *
 * One endpoint. One response. Zero client-side analytics computation.
 */

import {
  getPlayerInfo,
  getPlayerGameLogs,
  getTodaysGames,
  getUpcomingGamesNextDays,
  EnrichedGameLog,
} from './apiSports';
import {
  computePlayerAnalysis,
  getStatValue,
  parseMinutes,
  PlayerAnalysis,
  StatKey,
} from './playerAnalysis';
import {
  buildEnhancedProjection,
  ProjectionInputV2,
  StatKey as ProjectionStatKey,
} from './projections';
import { getNBAOdds, getNBAPlayerProps } from './oddsApi';
import { getOpponentDefFactor } from './teamDefense';
import { resolveNBAPersonId, headshotUrl } from './nbaPlayers';
import { getTeamAbbreviation } from './teamAbbreviations';

// ── Stat key mapping: analysis keys → projection keys ───────────────────────

const ANALYSIS_TO_PROJECTION: Partial<Record<StatKey, ProjectionStatKey>> = {
  points: 'points',
  rebounds: 'totReb',
  assists: 'assists',
  threes: 'tpm',
};

// ── Response type ───────────────────────────────────────────────────────────

export interface PlayerDetailResponse {
  player: {
    id: number;
    firstName: string;
    lastName: string;
    fullName: string;
    position: string;
    imageUrl: string | null;
    teamName: string;
    teamAbbreviation: string;
  };

  nextGame: {
    opponentName: string;
    opponentAbbreviation: string;
    isHome: boolean;
    gameDate: string;
    gameTime: string;
  } | null;

  projection: {
    value: number;
    line: number;
    edge: number;
    pOver: number;
    impliedPOver: number;
    direction: 'over' | 'under';
    visbetsScore: number;
    confidence: 'low' | 'medium' | 'high';
    confidenceScore: number;
    recommendation: 'OVER' | 'UNDER' | 'AVOID';
    stdDev: number;
    sampleSize: number;
    overOdds: number | null;
    underOdds: number | null;
    bookmaker: string | null;
  };

  hitRates: {
    last5: { hits: number; total: number; rate: number };
    last10: { hits: number; total: number; rate: number };
    last20: { hits: number; total: number; rate: number };
    season: { hits: number; total: number; rate: number };
    trend: 'up' | 'down' | 'flat';
  };

  currentStreak: { type: 'hit' | 'miss'; count: number };

  averages: {
    season: number;
    last5: number;
    last10: number;
  };

  momentum: {
    multiplier: number;
    trend: 'up' | 'down' | 'flat';
    recentVsAverage: number;
    consecutiveGames: number;
    description: string;
  };

  trajectory: {
    trendDirection: 'up' | 'down' | 'flat';
    trendDelta: number;
  };

  volatility: {
    standardDeviation: number;
    coefficientOfVariation: number;
    rating: 'low' | 'medium' | 'high';
    score: number;
  };

  consistency: {
    rating: 'High' | 'Medium' | 'Low';
    standardDeviation: number;
    coefficientOfVariation: number;
    floorValue: number;
    ceilingValue: number;
    rangeDescription: string;
  };

  distribution: {
    buckets: Array<{
      label: string;
      count: number;
      percentage: number;
      range: { min: number; max: number };
    }>;
    median: number;
    mode: number;
  };

  minutes: {
    avg5: number;
    avg10: number;
    trend: number[];
    flag: boolean;
    risk: 'Low' | 'Medium' | 'High';
    stdDev: number;
  };

  edge: {
    value: number;
    direction: 'over' | 'under';
  };

  last20Games: Array<{
    game_date: string;
    opponent_name: string;
    opponent_abbreviation: string;
    was_home_game: boolean;
    game_result: 'W' | 'L' | null;
    stat_value: number;
    hit: boolean;
    minutes_played: number;
  }>;

  chartData: Array<{
    x: number;
    y: number;
    game_date: string;
    opponent: string;
    isHome: boolean;
    minutes: number;
    isOver: boolean;
  }>;

  splits: {
    home: { games: number; avg: number; hitRate: number };
    away: { games: number; avg: number; hitRate: number };
    b2b: { games: number; avg: number; hitRate: number };
    rested: { games: number; avg: number; hitRate: number };
  };

  opponent: { name: string; id: number } | null;

  vsOpponent: {
    average: number;
    gamesPlayed: number;
    hitRate: number;
    lastGame: { value: number; isOver: boolean } | null;
  } | null;

  lineShopping: {
    allBooks: PlayerAnalysis['allBooks'];
    bestOverBook: PlayerAnalysis['bestOverBook'];
    bestUnderBook: PlayerAnalysis['bestUnderBook'];
    lineSpread: number;
  };

  radarMetrics: Array<{
    label: string;
    shortLabel: string;
    value: number;
    rawValue: string;
  }>;

  oddsQuota: { remaining: number; used: number; isLow: boolean };

  stat: string;
  line: number;
  bookmaker: string;
  generatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function computeHitRate(
  games: PlayerAnalysis['last20Games'],
  count: number
): { hits: number; total: number; rate: number } {
  // games is chronological (oldest first) — take the most recent `count` from the end
  const slice = games.slice(-count);
  const total = slice.length;
  if (total === 0) return { hits: 0, total: 0, rate: 0 };
  const hits = slice.filter((g) => g.hit).length;
  return { hits, total, rate: Math.round((hits / total) * 1000) / 1000 };
}

function computeDistribution(
  values: number[],
  line: number
): PlayerDetailResponse['distribution'] {
  if (values.length === 0 || line <= 0) {
    return {
      buckets: [
        { label: 'Way Under', count: 0, percentage: 0, range: { min: 0, max: 0 } },
        { label: 'Under', count: 0, percentage: 0, range: { min: 0, max: 0 } },
        { label: 'Near Line', count: 0, percentage: 0, range: { min: 0, max: 0 } },
        { label: 'Over', count: 0, percentage: 0, range: { min: 0, max: 0 } },
        { label: 'Way Over', count: 0, percentage: 0, range: { min: 0, max: 0 } },
      ],
      median: 0,
      mode: 0,
    };
  }

  const thresholds = [0.8 * line, 0.95 * line, 1.05 * line, 1.2 * line];
  const bucketDefs = [
    { label: 'Way Under', min: 0, max: thresholds[0] },
    { label: 'Under', min: thresholds[0], max: thresholds[1] },
    { label: 'Near Line', min: thresholds[1], max: thresholds[2] },
    { label: 'Over', min: thresholds[2], max: thresholds[3] },
    { label: 'Way Over', min: thresholds[3], max: Infinity },
  ];

  const counts = [0, 0, 0, 0, 0];
  for (const v of values) {
    if (v < thresholds[0]) counts[0]++;
    else if (v < thresholds[1]) counts[1]++;
    else if (v < thresholds[2]) counts[2]++;
    else if (v < thresholds[3]) counts[3]++;
    else counts[4]++;
  }

  const r1 = (n: number) => Math.round(n * 10) / 10; // round to tenth

  const total = values.length;
  const buckets = bucketDefs.map((def, i) => ({
    label: def.label,
    count: counts[i],
    percentage: r1((counts[i] / total) * 100),
    range: {
      min: r1(def.min),
      max: def.max === Infinity ? 999 : r1(def.max),
    },
  }));

  // Median
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? r1((sorted[mid - 1] + sorted[mid]) / 2)
    : r1(sorted[mid]);

  // Mode (rounded to nearest tenth)
  const freq: Record<number, number> = {};
  for (const v of values) {
    const rounded = r1(v);
    freq[rounded] = (freq[rounded] || 0) + 1;
  }
  const mode = Number(
    Object.entries(freq).reduce((best, [val, count]) =>
      count > (freq[Number(best)] || 0) ? val : best, '0')
  );

  return { buckets, median, mode };
}

function getMomentumDescription(multiplier: number): string {
  if (multiplier >= 1.15) return 'HOT STREAK';
  if (multiplier >= 1.05) return 'WARMING UP';
  if (multiplier <= 0.85) return 'ICE COLD';
  if (multiplier <= 0.95) return 'COOLING DOWN';
  return 'STEADY';
}

function getMinutesRisk(flag: boolean, minutesStdDev: number): 'Low' | 'Medium' | 'High' {
  if (flag && minutesStdDev > 4) return 'High';
  if (flag) return 'Medium';
  return 'Low';
}

// ── Line resolution (when line=0) ───────────────────────────────────────────

async function resolveLineFromOdds(
  playerName: string,
  teamName: string,
  stat: StatKey,
  seasonAvg: number
): Promise<{ line: number; overOdds: number | null; underOdds: number | null; bookmaker: string }> {
  const ODDS_MARKET_MAP: Record<StatKey, string> = {
    points: 'player_points',
    rebounds: 'player_rebounds',
    assists: 'player_assists',
    threes: 'player_threes',
    pra: 'player_points_rebounds_assists',
    steals: 'player_steals',
    blocks: 'player_blocks',
  };

  try {
    const events = await getNBAOdds();
    const teamLower = teamName.toLowerCase();
    const event = events.find(
      (e) =>
        e.home_team.toLowerCase().includes(teamLower) ||
        e.away_team.toLowerCase().includes(teamLower)
    );

    if (event) {
      const propsEvent = await getNBAPlayerProps(event.id);
      if (propsEvent) {
        const market = ODDS_MARKET_MAP[stat];
        // Try FanDuel first, then any book
        const bookOrder = ['fanduel', 'draftkings', 'betmgm', 'caesars', 'espnbet'];
        for (const bookKey of bookOrder) {
          const book = propsEvent.bookmakers.find((b) => b.key === bookKey);
          if (!book) continue;
          const mkt = book.markets.find((m) => m.key === market);
          if (!mkt) continue;

          const over = mkt.outcomes.find(
            (o) => o.name.toLowerCase() === 'over' &&
              o.description?.toLowerCase().includes(playerName.split(' ').pop()?.toLowerCase() ?? '')
          );
          const under = mkt.outcomes.find(
            (o) => o.name.toLowerCase() === 'under' &&
              o.description?.toLowerCase().includes(playerName.split(' ').pop()?.toLowerCase() ?? '')
          );

          if (over?.point) {
            return {
              line: over.point,
              overOdds: over.price,
              underOdds: under?.price ?? null,
              bookmaker: bookKey,
            };
          }
        }
      }
    }
  } catch (err: any) {
    console.warn('[PlayerDetail] Line resolution from odds failed:', err.message);
  }

  // Fallback: use season average as synthetic line
  return {
    line: Math.round(seasonAvg * 10) / 10,
    overOdds: null,
    underOdds: null,
    bookmaker: 'season_avg',
  };
}

// ── Main orchestrator ───────────────────────────────────────────────────────

export async function computePlayerDetail(
  playerId: number,
  stat: StatKey,
  requestedLine: number,
  bookmaker: string = 'fanduel'
): Promise<PlayerDetailResponse> {
  console.log(`[PlayerDetail] Computing detail for player ${playerId}, stat=${stat}, line=${requestedLine}`);

  // ── 1. Parallel fetch: player info + game logs ────────────────────────────
  const [playerInfo, enrichedLogs] = await Promise.all([
    getPlayerInfo(playerId),
    getPlayerGameLogs(playerId, 50),
  ]);

  if (!playerInfo) {
    throw new Error(`Player ${playerId} not found`);
  }

  const fullName = `${playerInfo.firstname} ${playerInfo.lastname}`;
  const teamName = enrichedLogs[0]?.team?.name ?? '';
  const teamAbbrev = getTeamAbbreviation(teamName);

  if (enrichedLogs.length === 0) {
    console.warn(`[PlayerDetail] No game logs found for player ${playerId} (${fullName})`);
  }

  // ── 2. Compute quick season average for line fallback ─────────────────────
  // Filter by minutes played (not minutes value) — a player with 0 points but 20 min is valid
  const playedLogs = enrichedLogs.filter((g) => {
    const mins = parseMinutes(g.min);
    return mins > 0;
  });
  const statValues = playedLogs.map((g) => getStatValue(g, stat));
  const seasonAvg = statValues.length > 0
    ? statValues.reduce((s, v) => s + v, 0) / statValues.length
    : 0;

  // ── 3. Resolve line if line=0 ─────────────────────────────────────────────
  let resolvedLine = requestedLine;
  let resolvedOverOdds: number | null = null;
  let resolvedUnderOdds: number | null = null;
  let resolvedBookmaker = bookmaker;

  if (requestedLine <= 0) {
    const resolved = await resolveLineFromOdds(fullName, teamName, stat, seasonAvg);
    resolvedLine = resolved.line;
    resolvedOverOdds = resolved.overOdds;
    resolvedUnderOdds = resolved.underOdds;
    resolvedBookmaker = resolved.bookmaker;
  }

  // Guard against zero line — prevents NaN in projections
  if (resolvedLine <= 0) {
    resolvedLine = 1; // Minimal fallback to prevent division-by-zero
    console.warn(`[PlayerDetail] Line resolved to 0 for player ${playerId}, using fallback=1`);
  }

  // ── 4. Compute analysis (existing service) ────────────────────────────────
  const analysis = await computePlayerAnalysis(playerId, stat, resolvedLine, resolvedBookmaker);

  // ── 5. Compute projection (if stat maps to projection engine) ─────────────
  const projStatKey = ANALYSIS_TO_PROJECTION[stat];
  let projectionResult: {
    value: number;
    stdDev: number;
    pOver: number;
    impliedPOver: number;
    edge: number;
    direction: 'over' | 'under';
    visbetsScore: number;
    confidence: 'low' | 'medium' | 'high';
    sampleSize: number;
    overOdds: number | null;
    underOdds: number | null;
    bookmaker: string | null;
  } | null = null;

  // ── 5a. Find next game early (needed for projection) ────────────────────
  let nextGame: PlayerDetailResponse['nextGame'] = null;
  try {
    const upcoming = await getUpcomingGamesNextDays(3);
    const teamLower = teamName.toLowerCase();
    if (teamLower) {
      const teamGame = upcoming.find(
        (g) =>
          g.teams.home.name.toLowerCase().includes(teamLower) ||
          g.teams.away.name.toLowerCase().includes(teamLower)
      );
      if (teamGame) {
        const isHomeTeam = teamGame.teams.home.name.toLowerCase().includes(teamLower);
        const opp = isHomeTeam ? teamGame.teams.away : teamGame.teams.home;
        nextGame = {
          opponentName: opp.name,
          opponentAbbreviation: getTeamAbbreviation(opp.name),
          isHome: isHomeTeam,
          gameDate: teamGame.date,
          gameTime: teamGame.time || teamGame.date,
        };
      }
    }
  } catch (err: any) {
    console.warn('[PlayerDetail] Next game lookup failed:', err.message);
  }

  // ── 5b. Compute daysRest from most recent game ────────────────────────────
  let daysRest: number | undefined;
  if (playedLogs.length > 0 && playedLogs[0].game_date) {
    try {
      const lastGameDate = new Date(playedLogs[0].game_date);
      const today = new Date();
      const diffMs = today.getTime() - lastGameDate.getTime();
      daysRest = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    } catch {
      // Non-fatal
    }
  }

  if (projStatKey && playedLogs.length > 0) {
    // Determine opponent defense factor from next game opponent
    const opponentName = analysis.opponent?.name ?? '';
    const defFactor = opponentName ? getOpponentDefFactor(opponentName, projStatKey) : 1.0;

    // Use next game's home/away status (not most recent game)
    const isHome = nextGame?.isHome ?? undefined;

    // Use best available odds
    const overOdds = resolvedOverOdds !== null ? resolvedOverOdds : (analysis.allBooks[0]?.over_price ?? null);
    const underOdds = resolvedUnderOdds !== null ? resolvedUnderOdds : (analysis.allBooks[0]?.under_price ?? null);

    const input: ProjectionInputV2 = {
      gameLogs: playedLogs,
      line: resolvedLine,
      stat: projStatKey,
      overOdds,
      underOdds,
      bookmaker: resolvedBookmaker,
      opponentDefFactor: defFactor,
      isHomeGame: isHome,
      daysRest,
    };

    const enhanced = buildEnhancedProjection(input);
    if (enhanced) {
      projectionResult = {
        value: enhanced.projection,
        stdDev: enhanced.stdDev,
        pOver: enhanced.pOver,
        impliedPOver: enhanced.impliedPOver,
        edge: enhanced.edge,
        direction: enhanced.direction,
        visbetsScore: enhanced.visbetsScore,
        confidence: enhanced.confidence,
        sampleSize: enhanced.sampleSize,
        overOdds: enhanced.overOdds,
        underOdds: enhanced.underOdds,
        bookmaker: enhanced.bookmaker,
      };
    }
  }

  // Fallback projection from analysis averages
  const projValue = projectionResult?.value ?? analysis.last5Average;
  const projEdge = projectionResult?.edge ?? 0;
  const projVisbetsScore = projectionResult?.visbetsScore ?? 50;
  const projConfidence = projectionResult?.confidence ?? 'low';

  // ── 6. Resolve headshot ───────────────────────────────────────────────────
  let imageUrl: string | null = null;
  try {
    const personId = await resolveNBAPersonId(fullName);
    if (personId) imageUrl = headshotUrl(personId);
  } catch {
    // Non-fatal
  }

  // ── 7. (next game already resolved above for projection) ─────────────────

  // ── 8. Compute derived fields ─────────────────────────────────────────────

  // Hit rates — note: "season" is based on the same 20-game window (we only fetch 20 logs)
  const hitRates: PlayerDetailResponse['hitRates'] = {
    last5: computeHitRate(analysis.last20Games, 5),
    last10: computeHitRate(analysis.last20Games, 10),
    last20: computeHitRate(analysis.last20Games, analysis.last20Games.length),
    season: computeHitRate(analysis.last20Games, analysis.last20Games.length),
    trend: analysis.hitRate5 > analysis.hitRate10 + 0.10
      ? 'up'
      : analysis.hitRate5 < analysis.hitRate10 - 0.10
        ? 'down'
        : 'flat',
  };

  // Momentum
  const multiplier = seasonAvg > 0
    ? clamp(Math.round((analysis.last5Average / seasonAvg) * 100) / 100, 0.5, 2.0)
    : 1.0;
  const recentVsAvg = seasonAvg > 0
    ? Math.round(((analysis.last5Average - seasonAvg) / seasonAvg) * 1000) / 10
    : 0;

  const momentum: PlayerDetailResponse['momentum'] = {
    multiplier,
    trend: analysis.trendDirection,
    recentVsAverage: recentVsAvg,
    consecutiveGames: analysis.currentStreak.count,
    description: getMomentumDescription(multiplier),
  };

  // Consistency
  const values = analysis.last20Values.map((v) => v.value);
  const floor = values.length > 0 ? Math.min(...values) : 0;
  const ceiling = values.length > 0 ? Math.max(...values) : 0;
  const cvVal = analysis.coefficientOfVariation;

  const r1 = (n: number) => Math.round(n * 10) / 10;

  const consistency: PlayerDetailResponse['consistency'] = {
    rating: cvVal < 0.25 ? 'High' : cvVal <= 0.45 ? 'Medium' : 'Low',
    standardDeviation: r1(analysis.standardDeviation),
    coefficientOfVariation: r1(cvVal * 100) / 100, // keep as decimal but round to 2 places
    floorValue: r1(floor),
    ceilingValue: r1(ceiling),
    rangeDescription: `${r1(floor)} - ${r1(ceiling)}`,
  };

  // Distribution
  const distribution = computeDistribution(values, resolvedLine);

  // Volatility
  const minutesValues = analysis.minutesTrend;
  const minutesMean = minutesValues.length > 0
    ? minutesValues.reduce((s, v) => s + v, 0) / minutesValues.length
    : 0;
  const minutesVariance = minutesValues.length > 1
    ? minutesValues.reduce((s, v) => s + Math.pow(v - minutesMean, 2), 0) / minutesValues.length
    : 0;
  const minutesStdDev = Math.sqrt(minutesVariance);

  const volatilityScore = Math.min(100, Math.round(cvVal * 200));
  const minutesRisk = getMinutesRisk(analysis.minutesFlag, minutesStdDev);

  // Chart data (chronological — oldest first, x=1)
  const chronologicalGames = [...analysis.last20Games].reverse();
  const chartData: PlayerDetailResponse['chartData'] = chronologicalGames.map((g, i) => ({
    x: i + 1,
    y: g.stat_value,
    game_date: g.game_date,
    opponent: getTeamAbbreviation(g.opponent_name),
    isHome: g.was_home_game,
    minutes: g.minutes_played,
    isOver: g.hit,
  }));

  // Enriched last20Games with abbreviations
  const last20GamesEnriched = analysis.last20Games.map((g) => ({
    ...g,
    opponent_abbreviation: getTeamAbbreviation(g.opponent_name),
  }));

  // Vs opponent (filter last20 by next game opponent)
  let vsOpponent: PlayerDetailResponse['vsOpponent'] = null;
  if (nextGame) {
    const oppLower = nextGame.opponentName.toLowerCase();
    const vsGames = analysis.last20Games.filter(
      (g) => g.opponent_name.toLowerCase().includes(oppLower) ||
        oppLower.includes(g.opponent_name.toLowerCase())
    );
    if (vsGames.length > 0) {
      const vsAvg = vsGames.reduce((s, g) => s + g.stat_value, 0) / vsGames.length;
      const vsHits = vsGames.filter((g) => g.hit).length;
      const lastVsGame = vsGames[0]; // most recent
      vsOpponent = {
        average: Math.round(vsAvg * 10) / 10,
        gamesPlayed: vsGames.length,
        hitRate: Math.round((vsHits / vsGames.length) * 1000) / 1000,
        lastGame: lastVsGame
          ? { value: lastVsGame.stat_value, isOver: lastVsGame.hit }
          : null,
      };
    }
  }

  // Radar metrics
  const formScore = seasonAvg > 0
    ? clamp(Math.round((analysis.last5Average / seasonAvg) * 50), 0, 100)
    : 50;
  const consistencyScore = 100 - volatilityScore;
  const minutesStabilityScore = minutesRisk === 'Low' ? 80 : minutesRisk === 'Medium' ? 50 : 20;

  const radarMetrics: PlayerDetailResponse['radarMetrics'] = [
    { label: 'Recent Form', shortLabel: 'FORM', value: formScore, rawValue: `${analysis.last5Average.toFixed(1)} avg` },
    { label: 'Consistency', shortLabel: 'CONS', value: consistencyScore, rawValue: `${analysis.standardDeviation.toFixed(1)} σ` },
    { label: 'Confidence', shortLabel: 'CONF', value: projVisbetsScore, rawValue: `${projVisbetsScore}/100` },
    { label: 'Minutes Stability', shortLabel: 'MINS', value: minutesStabilityScore, rawValue: `${analysis.minutesAvg5.toFixed(0)} mpg` },
  ];

  // Projection recommendation
  const recommendation: 'OVER' | 'UNDER' | 'AVOID' =
    projEdge > 0.04 && projConfidence !== 'low'
      ? 'OVER'
      : projEdge < -0.04 && projConfidence !== 'low'
        ? 'UNDER'
        : 'AVOID';

  // ── 9. Assemble response ──────────────────────────────────────────────────

  return {
    player: {
      id: playerId,
      firstName: playerInfo.firstname,
      lastName: playerInfo.lastname,
      fullName,
      position: '', // Not available from API-Sports box scores
      imageUrl,
      teamName,
      teamAbbreviation: teamAbbrev,
    },

    nextGame,

    projection: {
      value: projValue,
      line: resolvedLine,
      edge: projEdge,
      pOver: projectionResult?.pOver ?? 0.5,
      impliedPOver: projectionResult?.impliedPOver ?? 0.5,
      direction: projectionResult?.direction ?? (analysis.edgeDirection as 'over' | 'under'),
      visbetsScore: projVisbetsScore,
      confidence: projConfidence,
      confidenceScore: projVisbetsScore,
      recommendation,
      stdDev: projectionResult?.stdDev ?? analysis.standardDeviation,
      sampleSize: projectionResult?.sampleSize ?? playedLogs.length,
      overOdds: projectionResult?.overOdds ?? null,
      underOdds: projectionResult?.underOdds ?? null,
      bookmaker: projectionResult?.bookmaker ?? resolvedBookmaker,
    },

    hitRates,
    currentStreak: analysis.currentStreak,

    averages: {
      season: analysis.seasonAverage,
      last5: analysis.last5Average,
      last10: analysis.last10Average,
    },

    momentum,
    trajectory: {
      trendDirection: analysis.trendDirection,
      trendDelta: analysis.trendDelta,
    },

    volatility: {
      standardDeviation: analysis.standardDeviation,
      coefficientOfVariation: cvVal,
      rating: analysis.volatilityRating,
      score: volatilityScore,
    },

    consistency,
    distribution,

    minutes: {
      avg5: analysis.minutesAvg5,
      avg10: analysis.minutesAvg10,
      trend: analysis.minutesTrend,
      flag: analysis.minutesFlag,
      risk: minutesRisk,
      stdDev: Math.round(minutesStdDev * 100) / 100,
    },

    edge: {
      value: analysis.edge,
      direction: analysis.edgeDirection,
    },

    last20Games: last20GamesEnriched,
    chartData,

    splits: {
      home: analysis.homeSplits,
      away: analysis.awaySplits,
      b2b: analysis.b2bSplits,
      rested: analysis.restedSplits,
    },

    opponent: analysis.opponent,
    vsOpponent,

    lineShopping: {
      allBooks: analysis.allBooks,
      bestOverBook: analysis.bestOverBook,
      bestUnderBook: analysis.bestUnderBook,
      lineSpread: analysis.lineSpread,
    },

    radarMetrics,
    oddsQuota: analysis.oddsQuota,

    stat,
    line: resolvedLine,
    bookmaker: resolvedBookmaker,
    generatedAt: new Date().toISOString(),
  };
}
