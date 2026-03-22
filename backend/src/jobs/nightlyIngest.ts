/**
 * Nightly Ingestion Job — runs at 6:00 AM ET daily
 *
 * 1. Fetch yesterday's completed NBA box scores from API-Sports
 * 2. Upsert player game logs → Supabase `game_logs`
 * 3. Fill actual_value + hit on yesterday's `projection_logs`
 * 4. Store today's schedule → Supabase `daily_schedule`
 * 5. Prune game_logs older than 60 days (keeps Supabase healthy while retaining enough history)
 */

import { supabaseAdmin } from '../lib/supabaseAdmin';
import logger from '../lib/logger';
import {
  getGamesForDate,
  getGameBoxScoreRaw,
  normalizePlayerName,
  ApiSportsGame,
  ApiSportsBoxScore,
} from '../services/apiSports';

// ── Date helpers ──────────────────────────────────────────────────────────────

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function parseMinutes(minStr: string | null | undefined): number | null {
  if (!minStr) return null;
  const parts = minStr.split(':').map(Number);
  if (parts.length === 2) return (parts[0] ?? 0) + (parts[1] ?? 0) / 60;
  return parseFloat(minStr) || null;
}

function gameResult(game: ApiSportsGame, teamId: number): string | null {
  const homeScore = game.scores?.home?.total;
  const awayScore = game.scores?.away?.total;
  if (homeScore == null || awayScore == null) return null;
  const isHome = game.teams.home.id === teamId;
  const teamScore = isHome ? homeScore : awayScore;
  const oppScore  = isHome ? awayScore : homeScore;
  return teamScore > oppScore ? 'W' : 'L';
}

// ── Step 1 & 2: Ingest box scores → game_logs ─────────────────────────────────

export async function ingestBoxScores(dateStr: string): Promise<number> {
  const games = await getGamesForDate(dateStr);
  const finished = games.filter((g) => g.status.long === 'Game Finished');

  if (finished.length === 0) {
    logger.info({ date: dateStr }, '[Ingest] No finished games to ingest');
    return 0;
  }

  let totalRows = 0;

  for (const game of finished) {
    let boxScore: ApiSportsBoxScore[];
    try {
      boxScore = await getGameBoxScoreRaw(game.id);
    } catch (err: any) {
      logger.warn({ gameId: game.id, err: err.message }, '[Ingest] Box score fetch failed — skipping');
      continue;
    }

    const rows = boxScore.map((bs) => {
      const minNum = parseMinutes(bs.minutes);
      const isHome = bs.team.id === game.teams.home.id;
      const opponentId   = isHome ? game.teams.away.id   : game.teams.home.id;
      const opponentName = isHome ? game.teams.away.name : game.teams.home.name;
      const teamName     = isHome ? game.teams.home.name : game.teams.away.name;

      return {
        player_id:     bs.player.id,
        player_name:   bs.player.name,
        game_date:     dateStr,
        game_id:       game.id,
        team_id:       bs.team.id,
        team_name:     teamName,
        opponent_name: opponentName,
        is_home:       isHome,
        game_result:   gameResult(game, bs.team.id),
        minutes:       minNum,
        pts:           bs.points ?? null,
        reb:           bs.rebounds?.total ?? null,
        ast:           bs.assists ?? null,
        tpm:           bs.threepoint_goals?.total ?? null,
        stl:           bs.steals ?? null,
        blk:           bs.blocks ?? null,
        turnovers:     bs.turnovers ?? null,
        plus_minus:    null,
        fetched_at:    new Date().toISOString(),
      };
    });

    // Filter out invalid player IDs and deduplicate by (player_id, game_date)
    // API-Sports can return multiple stat lines per player; keep first (most complete)
    const seen = new Set<string>();
    const validRows = rows.filter((r) => {
      if (!r.player_id || r.player_id <= 0) return false;
      const key = `${r.player_id}:${r.game_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (validRows.length === 0) continue;

    const { error } = await supabaseAdmin
      .from('game_logs')
      .upsert(validRows, { onConflict: 'player_id,game_date' });

    if (error) {
      logger.warn(`[Ingest] game_logs upsert failed — ${error.message} | code=${error.code} | details=${error.details} | hint=${error.hint}`);
    } else {
      totalRows += rows.length;
    }
  }

  logger.info({ date: dateStr, games: finished.length, rows: totalRows }, '[Ingest] Box scores ingested');
  return totalRows;
}

// ── Step 3: Fill projection actuals ──────────────────────────────────────────

async function fillProjectionActuals(dateStr: string): Promise<void> {
  // Fetch all projection_logs for yesterday that don't yet have actuals
  const { data: pendingLogs, error: fetchError } = await supabaseAdmin
    .from('projection_logs')
    .select('player_name, stat, line, game_date')
    .eq('game_date', dateStr)
    .is('actual_value', null);

  if (fetchError) {
    logger.warn({ err: fetchError.message }, '[Ingest] Failed to fetch pending projection_logs');
    return;
  }

  if (!pendingLogs || pendingLogs.length === 0) {
    logger.info({ date: dateStr }, '[Ingest] No pending projection actuals to fill');
    return;
  }

  // Map stat key from projection_logs format → game_logs column
  const statToColumn: Record<string, string> = {
    points: 'pts',
    totReb: 'reb',
    assists: 'ast',
    tpm:    'tpm',
    steals: 'stl',
    blocks: 'blk',
  };

  let filled = 0;

  for (const log of pendingLogs) {
    const col = statToColumn[log.stat];
    if (!col) continue;

    // Find a matching game_log row for this player on this date
    const lastName = log.player_name.split(' ').slice(-1)[0];
    const { data: glRows } = await supabaseAdmin
      .from('game_logs')
      .select('*' as any)
      .eq('game_date', dateStr)
      .ilike('player_name', `%${lastName}%`)
      .limit(10) as any;  // Increase limit to find among multiple matches

    if (!glRows || glRows.length === 0) continue;

    // Prefer exact full-name match, fall back to first result
    const normalizeForMatch = normalizePlayerName;

    const match = glRows.find(
      (r: any) => normalizeForMatch(r.player_name) === normalizeForMatch(log.player_name)
    ) ?? glRows.find(
      // Secondary: first name initial match (e.g. "J. Williams" vs "Jaylen Williams")
      (r: any) => {
        const logFirst = log.player_name[0]?.toLowerCase();
        return r.player_name.toLowerCase().startsWith(logFirst ?? '');
      }
    ) ?? glRows[0];

    const actualValue = (match as any)[col] as number | null;
    if (actualValue == null) continue;

    const hit = log.line != null ? actualValue >= log.line : null;

    const { error: updateError } = await supabaseAdmin
      .from('projection_logs')
      .update({ actual_value: actualValue, hit })
      .eq('player_name', log.player_name)
      .eq('stat', log.stat)
      .eq('game_date', dateStr);

    if (!updateError) filled++;
  }

  logger.info({ date: dateStr, filled, total: pendingLogs.length }, '[Ingest] Projection actuals filled');
}

// ── Step 3b: Fill saved pick actuals ────────────────────────────────────────

async function fillSavedPickActuals(dateStr: string): Promise<void> {
  const { data: pending } = await supabaseAdmin
    .from('saved_picks')
    .select('id, player_name, stat_type, line, direction')
    .eq('game_date', dateStr)
    .is('actual_value', null);

  if (!pending?.length) return;

  const statMap: Record<string, string> = {
    PTS: 'pts', REB: 'reb', AST: 'ast', '3PM': 'tpm',
    STL: 'stl', BLK: 'blk',
  };

  let filled = 0;

  for (const pick of pending) {
    const col = statMap[pick.stat_type];
    if (!col) continue;

    const lastName = pick.player_name.split(' ').slice(-1)[0];

    const { data: glRows } = await supabaseAdmin
      .from('game_logs')
      .select(`player_name, pts, reb, ast, tpm, stl, blk`)
      .eq('game_date', dateStr)
      .ilike('player_name', `%${lastName}%`)
      .limit(10);

    if (!glRows?.length) continue;

    const normalizeForMatch = normalizePlayerName;

    const match = glRows.find(
      (r) => normalizeForMatch(r.player_name) === normalizeForMatch(pick.player_name)
    ) ?? glRows[0];

    let actualValue: number | null = null;
    if (pick.stat_type === 'PRA') {
      actualValue = ((match as any).pts ?? 0) + ((match as any).reb ?? 0) + ((match as any).ast ?? 0);
    } else {
      actualValue = (match as any)[col] as number | null;
    }

    if (actualValue == null) continue;

    const hit = pick.direction === 'over' ? actualValue > pick.line : actualValue < pick.line;

    const { error } = await supabaseAdmin
      .from('saved_picks')
      .update({ actual_value: actualValue, hit })
      .eq('id', pick.id);

    if (!error) filled++;
  }

  logger.info({ date: dateStr, filled, total: pending.length }, '[Ingest] Saved pick actuals filled');
}

// ── Step 4: Store today's schedule ───────────────────────────────────────────

async function storeSchedule(dateStr: string): Promise<void> {
  const games = await getGamesForDate(dateStr);
  if (games.length === 0) return;

  const rows = games.map((g) => ({
    game_id:      g.id,
    game_date:    dateStr,
    home_team_id: g.teams.home.id,
    home_team:    g.teams.home.name,
    away_team_id: g.teams.away.id,
    away_team:    g.teams.away.name,
    game_time:    g.date && g.time ? `${g.date}T${g.time}:00Z` : null,
    status:       g.status.long,
  }));

  const { error } = await supabaseAdmin
    .from('daily_schedule')
    .upsert(rows, { onConflict: 'game_id' });

  if (error) {
    logger.warn({ err: error.message }, '[Ingest] Schedule upsert failed');
  } else {
    logger.info({ date: dateStr, count: rows.length }, '[Ingest] Schedule stored');
  }
}

// ── Step 5: Prune old game logs (60-day rolling window) ──────────────────────

async function pruneOldLogs(): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { error } = await supabaseAdmin
    .from('game_logs')
    .delete()
    .lt('game_date', cutoffStr);

  if (error) {
    logger.warn({ err: error.message }, '[Ingest] Prune failed');
  } else {
    logger.info({ cutoff: cutoffStr }, '[Ingest] Old game logs pruned');
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runNightlyIngest(): Promise<void> {
  const startTime = Date.now();
  logger.info('[Ingest] Nightly ingest started');

  try {
    const yd = yesterday();
    const td = today();

    // Run sequentially to keep API quota under control
    const rowsIngested = await ingestBoxScores(yd);
    await fillProjectionActuals(yd);
    await fillSavedPickActuals(yd);
    await storeSchedule(td);

    // Only prune old logs if today's ingest actually added data.
    // If the ingest returned 0 rows (API down, key expired, no games),
    // skipping the prune prevents the table from slowly draining empty.
    if (rowsIngested > 0) {
      await pruneOldLogs();
    } else {
      logger.warn('[Ingest] Skipping prune — no rows ingested today (API may be down)');
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    logger.info({ elapsed }, '[Ingest] Nightly ingest complete');
  } catch (err: any) {
    logger.error({ err: err.message }, '[Ingest] Nightly ingest failed');
    throw err;
  }
}
