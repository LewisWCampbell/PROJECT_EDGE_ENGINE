/**
 * VisBets App Constants
 */

/**
 * API Configuration
 * All NBA data now routes through the backend server — never call third-party APIs directly from the app.
 */
export const API_CONFIG = {
  BACKEND_BASE_URL: (() => {
    const url = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (url) return url;
    if (__DEV__) return 'http://localhost:3001';
    console.error('[Config] EXPO_PUBLIC_API_BASE_URL is not set in production!');
    return 'https://visbets-production.up.railway.app';
  })(),
  TIMEOUT: 30000, // 30 seconds
} as const;

/**
 * React Query Configuration
 */
export const QUERY_CONFIG = {
  STALE_TIME: {
    PLAYER_PROPS: 5 * 60 * 1000,          // 5 minutes
    PLAYER_STATS: 60 * 60 * 1000,         // 1 hour
    SEASON_AVERAGES: 24 * 60 * 60 * 1000, // 24 hours
    PLAYER_INFO: 24 * 60 * 60 * 1000,     // 24 hours
    GAMES: 10 * 60 * 1000,                // 10 minutes
    ODDS: 5 * 60 * 1000,                  // 5 minutes
    INJURIES: 30 * 60 * 1000,             // 30 minutes
  },
  CACHE_TIME: 60 * 60 * 1000, // 1 hour
  RETRY_COUNT: 2,
} as const;

/**
 * Stat Types
 */
export const STAT_TYPES = {
  POINTS: 'PTS',
  REBOUNDS: 'REB',
  ASSISTS: 'AST',
  THREES: '3PM',
  STEALS: 'STL',
  BLOCKS: 'BLK',
  TURNOVERS: 'TO',
} as const;

export type StatType = typeof STAT_TYPES[keyof typeof STAT_TYPES];

/**
 * Minutes Risk Thresholds
 */
export const MINUTES_RISK_THRESHOLDS = {
  HIGH: 8,
  MEDIUM: 4,
} as const;

/**
 * Confidence Score Thresholds
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 75,
  MEDIUM: 50,
  LOW: 0,
} as const;

/**
 * Default Values
 */
export const DEFAULTS = {
  GAMES_TO_FETCH: 20,
  RECENT_GAMES_DISPLAY: 10,
  TREND_GAMES: {
    SHORT: 5,
    MEDIUM: 10,
    LONG: 20,
  },
  PARLAY_CONFIDENCE_MIN: 70,
  EDGE_THRESHOLD_MIN: 2,
} as const;

/**
 * Date & Time Formats
 */
export const DATE_FORMATS = {
  DISPLAY: 'MMM DD',
  FULL: 'MMM DD, YYYY',
  TIME: 'h:mm A',
  API: 'YYYY-MM-DD',
} as const;

/**
 * Error Messages
 */
export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Network error. Please check your connection.',
  API_ERROR: 'Failed to fetch data. Please try again.',
  NO_DATA: 'No data available.',
  RATE_LIMIT: 'Too many requests. Please wait a moment.',
} as const;

/**
 * Sportsbooks List
 */
export const SPORTSBOOKS = [
  { id: 'prizepicks',  name: 'PrizePicks',  shortLabel: 'PP',   logo: null },
  { id: 'underdog',    name: 'Underdog',    shortLabel: 'UD',   logo: null },
  { id: 'fanduel',     name: 'FanDuel',     shortLabel: 'FD',   logo: null },
  { id: 'draftkings',  name: 'DraftKings',  shortLabel: 'DK',   logo: null },
  { id: 'betmgm',      name: 'BetMGM',      shortLabel: 'MGM',  logo: null },
  { id: 'caesars',      name: 'Caesars',     shortLabel: 'CZR',  logo: null },
  { id: 'espnbet',     name: 'ESPN BET',    shortLabel: 'ESPN', logo: null },
] as const;

export type SportsbookId = typeof SPORTSBOOKS[number]['id'];

/**
 * Sports List
 */
export const SPORTS = [
  { id: 'nba', name: 'NBA', icon: 'basketball' },
  { id: 'nfl', name: 'NFL', icon: 'american-football' },
  { id: 'mlb', name: 'MLB', icon: 'baseball' },
  { id: 'nhl', name: 'NHL', icon: 'hockey-puck' },
  { id: 'soccer', name: 'Soccer', icon: 'football' },
  { id: 'mma', name: 'MMA/UFC', icon: 'fitness' },
  { id: 'golf', name: 'Golf', icon: 'golf' },
  { id: 'tennis', name: 'Tennis', icon: 'tennisball' },
  { id: 'ncaab', name: 'College Basketball', icon: 'school' },
  { id: 'ncaaf', name: 'College Football', icon: 'school' },
] as const;

export type SportId = typeof SPORTS[number]['id'];

/**
 * Display Name Validation Rules
 * This is a display name (not a unique handle), so spaces are allowed.
 */
export const USERNAME_RULES = {
  MIN_LENGTH: 2,
  MAX_LENGTH: 30,
  PATTERN: /^[a-zA-Z0-9_ ]+$/,
} as const;

/**
 * Bug Report Email
 */
export const BUG_REPORT_EMAIL = 'bugs@visbets.com';
export const HELP_EMAIL = 'support@visbets.com';
export const FEEDBACK_EMAIL = 'feedback@visbets.com';
