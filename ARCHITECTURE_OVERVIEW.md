# VisBets — Complete Architecture Overview

## What Is VisBets?

VisBets is an NBA sports betting analytics platform. It ingests real-time odds from multiple sportsbooks (FanDuel, DraftKings, BetMGM, Caesars, ESPN BET) and fantasy platforms (PrizePicks, Underdog Fantasy), runs a proprietary projection model against historical game logs, and surfaces "edges" — situations where the model's prediction diverges from the market line. Users can browse projected props, drill into player-level analytics, and build custom parlays with confidence scoring.

---

## High-Level ASCII Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL DATA SOURCES                            │
│                                                                            │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  │
│  │ TheOdds  │  │ API-Sports│  │ PrizePicks│  │ Underdog │  │  NBA CDN  │  │
│  │   API    │  │(basketball│  │  (public   │  │ Fantasy  │  │ (headshots│  │
│  │          │  │ stats/box │  │projections)│  │  (O/U    │  │  + player │  │
│  │ odds +   │  │ scores/   │  │           │  │  lines)  │  │  index)   │  │
│  │ props    │  │ schedule) │  │           │  │          │  │           │  │
│  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  └────┬─────┘  └─────┬─────┘  │
└───────┼──────────────┼──────────────┼──────────────┼──────────────┼────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND  (Node/Express on Railway)                  │
│                                                                            │
│  ┌───────────────────────── SCHEDULED JOBS ──────────────────────────────┐ │
│  │                                                                       │ │
│  │  nightlyIngest (6 AM ET daily)         oddsRefresh (every 30 min,    │ │
│  │  ├─ Fetch yesterday's box scores       11 AM–11 PM ET)               │ │
│  │  ├─ Upsert → game_logs table           ├─ Fetch odds + props         │ │
│  │  ├─ Fill projection_logs actuals        ├─ Fetch PrizePicks lines     │ │
│  │  └─ Prune logs > 60 days               ├─ Fetch Underdog lines       │ │
│  │                                         ├─ Run projection model       │ │
│  │  backfill (manual/admin)                ├─ Write → Redis cache        │ │
│  │  └─ Historical game_logs fill           └─ Write → pre_computed_props │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  ┌──────────────────── PROJECTION ENGINE (v2.0.0-ewma) ─────────────────┐ │
│  │                                                                       │ │
│  │  1. EWMA weighted avg (lambda=0.88, recent games weighted more)       │ │
│  │  2. Opponent defensive factor adjustment                              │ │
│  │  3. Road game penalty (-3%), B2B penalty (-4%)                        │ │
│  │  4. Standard deviation floor (15% of projection)                      │ │
│  │  5. P(over) via normal CDF vs. line                                   │ │
│  │  6. Devig market odds → implied P(over)                               │ │
│  │  7. Edge = model P(over) − market implied P(over)                     │ │
│  │  8. VisBets Score = 50 + (edge × confidence × 250), capped 0–100     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  ┌──── CACHING (3-layer priority) ────┐   ┌──── API ROUTES ─────────────┐ │
│  │                                     │   │                             │ │
│  │  L1: Redis (Upstash)               │   │  /api/projections/today     │ │
│  │      TTL 35–60 min                 │   │  /api/players/:id/detail    │ │
│  │      odds, props, projections      │   │  /api/players/:id/analysis  │ │
│  │                                     │   │  /api/players/:id/props     │ │
│  │  L2: Supabase (PostgreSQL)         │   │  /api/players/search        │ │
│  │      pre_computed_props table      │   │  /api/odds/nba              │ │
│  │      game_logs (60-day window)     │   │  /api/games/today           │ │
│  │                                     │   │  /api/subscriptions/sync    │ │
│  │  L3: Live compute (on-demand)      │   │  /api/promo/redeem          │ │
│  │      Full pipeline if cache miss   │   │  /api/admin/backfill        │ │
│  └─────────────────────────────────────┘   └─────────────────────────────┘ │
│                                                                            │
│  ┌──── MIDDLEWARE ────────────────────┐   ┌──── EXTERNAL SERVICES ──────┐ │
│  │  auth.ts  → Supabase JWT verify   │   │  Supabase (DB + Auth)       │ │
│  │  subscriptionGate.ts → tier check │   │  RevenueCat (subscriptions) │ │
│  │  rate limiter (100 req/min)       │   │  Sentry (error tracking)    │ │
│  └────────────────────────────────────┘   └─────────────────────────────┘ │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │
                                        │  HTTPS / JWT Auth
                                        │
┌───────────────────────────────────────┼─────────────────────────────────────┐
│                     FRONTEND  (Expo / React Native)                        │
│                                                                            │
│  ┌──── STATE MANAGEMENT (Zustand) ────────────────────────────────────┐    │
│  │  authStore          → user, session, JWT tokens                    │    │
│  │  subscriptionStore  → tier (free/starter/pro), RevenueCat pkgs    │    │
│  │  parlayBuilderStore → legs[], addLeg, removeLeg (max 10)          │    │
│  │  onboardingStore    → selected sportsbooks + sports               │    │
│  │  userStatsStore     → props viewed, picks saved (analytics)       │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  ┌──── DATA FETCHING (React Query + Axios) ───────────────────────────┐   │
│  │  useProjections()   → GET /api/projections/today (stale: 15 min)  │   │
│  │  usePlayerSearch()  → GET /api/players/search (debounce: 250ms)   │   │
│  │  Player detail      → GET /api/players/:id/detail                 │   │
│  │  Axios interceptor  → auto-attaches Supabase JWT, refreshes 401s  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  ┌──── NAVIGATION (Expo Router — file-based) ─────────────────────────┐   │
│  │                                                                     │   │
│  │  ┌─ (auth)/                    ┌─ (onboarding)/                    │   │
│  │  │   login.tsx                 │   welcome.tsx                     │   │
│  │  │   email-verify.tsx          │   username.tsx                    │   │
│  │  │   phone-verify.tsx          │   sportsbooks.tsx                 │   │
│  │  │                             │   sports.tsx                      │   │
│  │  │                             │                                   │   │
│  │  ├─ (tabs)/  ◄── MAIN APP ────┤                                   │   │
│  │  │   index.tsx     (Board)     │   Modals:                        │   │
│  │  │   parlays.tsx   (Parlays)   │     subscription.tsx              │   │
│  │  │   builder.tsx   (Builder)   │     parlay-analysis.tsx           │   │
│  │  │   profile.tsx   (Profile)   │     bug-report.tsx                │   │
│  │  │                             │     terms / privacy               │   │
│  │  ├─ player/[id].tsx            │                                   │   │
│  │  └────────────────────────────────────────────────────────────────-┘   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  ┌──── KEY SCREENS ───────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  BOARD (index.tsx)            PLAYER DETAIL ([id].tsx)             │   │
│  │  ┌──────────────────┐        ┌──────────────────────────┐         │   │
│  │  │ [Logo]  42 props │        │ ┌──────────────────────┐ │         │   │
│  │  │ PTS REB AST 3PM  │        │ │ Hero: Avatar + Name  │ │         │   │
│  │  │ Sort: Score ▼    │        │ │ Projection Row       │ │         │   │
│  │  │──────────────────│        │ │ Stat Pill Bar        │ │         │   │
│  │  │┌──────┐┌──────┐ │        │ └──────────────────────┘ │         │   │
│  │  ││Player││Player│ │        │ ┌──────────────────────┐ │         │   │
│  │  ││Card  ││Card  │ │        │ │ Performance Trends   │ │         │   │
│  │  ││      ││      │ │        │ │ (Interactive Chart)  │ │         │   │
│  │  │└──────┘└──────┘ │        │ └──────────────────────┘ │         │   │
│  │  │┌──────┐┌──────┐ │        │ ┌──────────────────────┐ │         │   │
│  │  ││Player││Player│ │        │ │ Analytics Dashboard  │ │         │   │
│  │  ││Card  ││Card  │ │        │ │ (HitRate/Dist/       │ │         │   │
│  │  ││      ││      │ │        │ │  Consistency/Momentum│ │         │   │
│  │  │└──────┘└──────┘ │        │ └──────────────────────┘ │         │   │
│  │  │    ...more...   │        │ ┌──────────────────────┐ │         │   │
│  │  └──────────────────┘        │ │ Splits & Matchups   │ │         │   │
│  │                              │ └──────────────────────┘ │         │   │
│  │  BUILDER (builder.tsx)       │ ┌──────────────────────┐ │         │   │
│  │  ┌──────────────────┐        │ │ Odds Comparison      │ │         │   │
│  │  │ Search players...│        │ └──────────────────────┘ │         │   │
│  │  │ [Preview Card]   │        └──────────────────────────┘         │   │
│  │  │ ── Your Parlay ──│                                             │   │
│  │  │ Leg 1: LBJ O24.5│                                             │   │
│  │  │ Leg 2: SC U28.5 │                                             │   │
│  │  │ [Analyze Parlay] │                                             │   │
│  │  └──────────────────┘                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  ┌──── AUTH & PAYMENTS ───────────────────────────────────────────────┐   │
│  │  Supabase Auth (Google OAuth via web browser)                      │   │
│  │  RevenueCat (in-app purchases: Starter / Pro tiers)                │   │
│  │  Feature gating: BlurUpgradeOverlay for locked content             │   │
│  │  Promo codes: backend atomic redemption via Supabase RPC           │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  ┌──── OBSERVABILITY ─────────────────────────────────────────────────┐   │
│  │  Amplitude (screen views, feature usage, conversion tracking)      │   │
│  │  Sentry (crash reporting + error tracking)                         │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Request Lifecycle

```
User opens Board screen
        │
        ▼
useProjections() hook fires
        │
        ▼
Axios GET /api/projections/today  (JWT in Authorization header)
        │
        ▼
┌── Backend: projections route ──────────────────────────────┐
│                                                             │
│   1. Check Redis  →  "projections:today" key exists?       │
│      YES → return cached array (sub-ms)                    │
│      NO  ↓                                                  │
│   2. Check Supabase → pre_computed_props table has today?  │
│      YES → return rows (ms)                                │
│      NO  ↓                                                  │
│   3. Live pipeline:                                         │
│      a. Fetch today's odds from TheOddsAPI                 │
│      b. Fetch player props per game                        │
│      c. For each prop:                                      │
│         - Pull game_logs from Supabase (last 60 days)      │
│         - Run EWMA projection model                         │
│         - Calculate edge vs. market line                    │
│         - Compute VisBets Score                             │
│      d. Return full projection array                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
Frontend receives ProjectedProp[]
        │
        ▼
Board renders 2-column grid of PlayerPropCards
  - Each card: avatar, VIS prediction, score, edge, book lines
  - Free users: ~5 unlocked, rest blurred
  - Tap card → navigate to /player/[id] with stat context
```

---

## Backend: Service-by-Service Breakdown

### External API Clients

| Service              | Source                         | What It Fetches                                |
|----------------------|--------------------------------|------------------------------------------------|
| `oddsApi.ts`         | TheOddsAPI                     | Game odds (H2H, spreads, totals) + player props per event |
| `apiSports.ts`       | API-Sports (basketball)        | Game schedule, box scores, player search       |
| `prizePicks.ts`      | PrizePicks public API          | NBA player projections (stat + line)           |
| `underdogFantasy.ts` | Underdog Fantasy API           | Over/under lines for NBA players               |
| `nbaPlayers.ts`      | NBA CDN (static JSON)          | Player index + headshot URLs                   |

### Core Logic

| Service                | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `projections.ts`       | EWMA projection model, P(over) calculation, edge + VisBets Score |
| `playerAnalysis.ts`    | Streak detection, trajectory, volatility, splits, line shopping |
| `playerDetail.ts`      | Orchestrator — composes all services into one unified response  |
| `teamDefense.ts`       | Opponent defensive rating lookup (dynamic + hardcoded fallback) |
| `playerResolver.ts`    | Fuzzy name matching across data sources                        |
| `projectionLogger.ts`  | Logs daily projections + fills in actuals for accuracy tracking |

### Infrastructure

| File                    | Purpose                                                     |
|-------------------------|-------------------------------------------------------------|
| `lib/redis.ts`          | Redis client with graceful no-op if REDIS_URL unset         |
| `lib/supabaseAdmin.ts`  | Supabase service-role client for DB operations              |
| `lib/logger.ts`         | Pino logger (pretty in dev, JSON in prod)                   |
| `lib/sentry.ts`         | Sentry error tracking init                                  |
| `cache/gameCache.ts`    | In-memory node-cache + in-flight request deduplication      |
| `cache/oddsQuota.ts`    | Tracks TheOddsAPI remaining request quota                   |

---

## Frontend: Screen-by-Screen Breakdown

### Board (Main Tab)
The primary screen. Displays a 2-column grid of `PlayerPropCard` components, each showing a player's projected stat, VisBets Score, edge vs. market, and sportsbook lines from up to 7 books. Users can filter by stat type (PTS, REB, AST, 3PM, STL), sort by score/edge/confidence, toggle "positive edge only," and search for specific players via a live dropdown. A collapsing animated header shows the logo and prop count.

### Player Detail (/player/[id])
A deep-dive screen with multiple sections: Hero (avatar, projection, stat pills), Performance Trends (interactive chart with game chip carousel), Analytics Dashboard (tabbed: hit rate, distribution, consistency, momentum), Splits & Matchups (radar chart, split comparisons), and Odds Comparison across books. This is the analytics powerhouse of the app.

### Parlays Tab
Curated parlay suggestions generated algorithmically from today's top projections. Five parlay types: Safe Double, Balanced Triple, Value Quad, Scorers Special, Edge Hunter. Each shows risk level, combined confidence, estimated American odds, and individual leg breakdowns. Gated behind the Starter subscription tier.

### Builder Tab
Custom parlay construction. Search for players, preview their projections/lines, select stat + over/under + line, add legs (max 10), then analyze. The analysis modal computes combined confidence, correlation factor (same-team detection), risk level, and estimated payout odds.

### Profile Tab
User settings, subscription management, promo code redemption, display name editing, and support links. Dev mode includes tier override buttons for testing.

---

## Database Schema (Supabase / PostgreSQL)

```
┌─────────────────────────────────────────────────────────────┐
│                      SUPABASE TABLES                        │
│                                                             │
│  game_logs                     player_metadata              │
│  ├─ player_id (int)            ├─ player_id (int, PK)      │
│  ├─ player_name                ├─ full_name                 │
│  ├─ game_date                  └─ team_name                 │
│  ├─ game_id                                                 │
│  ├─ team / opponent            pre_computed_props            │
│  ├─ is_home, game_result       ├─ player_name               │
│  ├─ minutes                    ├─ stat, line                 │
│  ├─ pts, reb, ast, tpm,        ├─ projection, p_over         │
│  │  stl, blk, turnovers        ├─ edge, direction            │
│  ├─ plus_minus                 ├─ visbets_score, confidence  │
│  └─ fetched_at                 ├─ bookmaker, book odds       │
│  (indexed: player_id +         ├─ opponent, is_home          │
│   game_date; 60-day window)    └─ computed_at                │
│                                                             │
│  projection_logs               user_subscriptions            │
│  ├─ player_name, stat, line    ├─ user_id (PK)              │
│  ├─ projection, p_over         ├─ tier (free/starter/pro)   │
│  ├─ visbets_score, direction   ├─ revenuecat_customer_id    │
│  ├─ model_version              ├─ expires_at                │
│  ├─ game_date                  └─ updated_at                │
│  ├─ actual_value (filled next                                │
│  │   day by nightly ingest)    promo_redemptions             │
│  └─ hit (bool)                 ├─ user_id                   │
│                                ├─ promo_tier, code           │
│                                ├─ promo_expires_at           │
│                                └─ redeemed_at                │
└─────────────────────────────────────────────────────────────┘
```

---

## Subscription & Auth Flow

```
Google Sign-In (mobile browser)
        │
        ▼
Supabase OAuth callback → JWT issued
        │
        ▼
JWT stored in SecureStore → attached to all API requests
        │
        ├─ New user? → Onboarding flow (username → sportsbooks → sports → welcome)
        │
        └─ Returning user? → Board screen
                │
                ├─ Free tier: ~5 props unlocked daily (deterministic hash)
                │                analytics blurred with BlurUpgradeOverlay
                │
                └─ Starter/Pro: Full access
                        │
                        ├─ RevenueCat in-app purchase
                        │   └─ Webhook → /api/subscriptions/webhook
                        │       └─ Updates user_subscriptions table
                        │
                        └─ Promo code redemption
                            └─ POST /api/promo/redeem (atomic RPC)
                                └─ Updates promo_redemptions + tier cache
```

---

## Deployment Topology

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Railway    │     │   Supabase   │     │   Upstash    │
│  (Backend)   │◄───►│  (Postgres   │     │   (Redis)    │
│  Express +   │     │   + Auth)    │     │              │
│  Cron Jobs   │◄────┼──────────────┼────►│  Cache layer │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       │  HTTPS
       │
┌──────┴───────┐     ┌──────────────┐     ┌──────────────┐
│  Expo App    │     │  RevenueCat  │     │  Amplitude   │
│  (iOS via    │◄───►│  (IAP +      │     │  + Sentry    │
│  TestFlight) │     │  Webhooks)   │     │  (Analytics) │
└──────────────┘     └──────────────┘     └──────────────┘
```

---

## Tech Stack Summary

| Layer          | Technology                                              |
|----------------|---------------------------------------------------------|
| Frontend       | Expo 54, React Native 0.81, React 19, TypeScript       |
| Navigation     | Expo Router 6 (file-based routing)                      |
| State          | Zustand 5 (persisted to SecureStore/AsyncStorage)       |
| Data Fetching  | React Query 5, Axios                                    |
| Charts         | Victory Native, Wagmi Charts                            |
| Animations     | React Native Reanimated 4, Lottie                       |
| Backend        | Node.js, Express, TypeScript                            |
| Database       | Supabase (PostgreSQL)                                   |
| Cache          | Upstash Redis + node-cache (in-memory)                  |
| Auth           | Supabase Auth + Google OAuth                            |
| Payments       | RevenueCat (iOS in-app purchases)                       |
| Hosting        | Railway (backend), EAS Build (mobile)                   |
| Monitoring     | Sentry (errors), Amplitude (analytics), Pino (logging)  |
| Scheduling     | node-cron (nightly ingest + odds refresh)               |
