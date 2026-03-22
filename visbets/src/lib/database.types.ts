/**
 * Supabase Database Types
 * Auto-generate the full version with: npx supabase gen types typescript --project-id YOUR_SUPABASE_PROJECT_ID
 * This is a minimal hand-written version until you run the generator.
 */

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          username: string | null;
          avatar_url: string | null;
          push_token: string | null;
          onboarding_complete: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          username?: string | null;
          avatar_url?: string | null;
          push_token?: string | null;
          onboarding_complete?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          email?: string | null;
          display_name?: string | null;
          username?: string | null;
          avatar_url?: string | null;
          push_token?: string | null;
          onboarding_complete?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          tier: 'free' | 'starter' | 'pro';
          revenuecat_customer_id: string | null;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          tier?: 'free' | 'starter' | 'pro';
          revenuecat_customer_id?: string | null;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          tier?: 'free' | 'starter' | 'pro';
          revenuecat_customer_id?: string | null;
          expires_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_preferences: {
        Row: {
          user_id: string;
          sportsbooks: string[];
          sports: string[];
          updated_at: string;
        };
        Insert: {
          user_id: string;
          sportsbooks?: string[];
          sports?: string[];
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          sportsbooks?: string[];
          sports?: string[];
          updated_at?: string;
        };
        Relationships: [];
      };
      saved_picks: {
        Row: {
          id: string;
          user_id: string;
          player_id: string;
          player_name: string;
          stat_type: string;
          line: number;
          direction: 'over' | 'under';
          visbets_score: number | null;
          game_date: string;
          created_at: string;
          actual_value: number | null;
          hit: boolean | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          player_id: string;
          player_name: string;
          stat_type: string;
          line: number;
          direction: 'over' | 'under';
          visbets_score?: number | null;
          game_date: string;
          created_at?: string;
          actual_value?: number | null;
          hit?: boolean | null;
        };
        Update: {
          visbets_score?: number | null;
          actual_value?: number | null;
          hit?: boolean | null;
        };
        Relationships: [];
      };
      promo_redemptions: {
        Row: {
          id: string;
          user_id: string;
          promo_code: string;
          promo_tier: 'free' | 'starter' | 'pro';
          promo_expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          promo_code: string;
          promo_tier: 'free' | 'starter' | 'pro';
          promo_expires_at: string;
          created_at?: string;
        };
        Update: {
          promo_tier?: 'free' | 'starter' | 'pro';
          promo_expires_at?: string;
        };
        Relationships: [];
      };
      game_logs: {
        Row: {
          id: string;
          player_id: number;
          player_name: string;
          game_date: string;
          opponent_name: string;
          was_home_game: boolean;
          game_result: 'W' | 'L' | null;
          points: number | null;
          totReb: number | null;
          assists: number | null;
          tpm: number | null;
          steals: number | null;
          blocks: number | null;
          turnovers: number | null;
          min: string | null;
          plusMinus: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          player_id: number;
          player_name: string;
          game_date: string;
          opponent_name?: string;
          was_home_game?: boolean;
          game_result?: 'W' | 'L' | null;
          points?: number | null;
          totReb?: number | null;
          assists?: number | null;
          tpm?: number | null;
          steals?: number | null;
          blocks?: number | null;
          turnovers?: number | null;
          min?: string | null;
          plusMinus?: string | null;
          created_at?: string;
        };
        Update: {
          opponent_name?: string;
          was_home_game?: boolean;
          game_result?: 'W' | 'L' | null;
          points?: number | null;
          totReb?: number | null;
          assists?: number | null;
          tpm?: number | null;
          steals?: number | null;
          blocks?: number | null;
          turnovers?: number | null;
          min?: string | null;
          plusMinus?: string | null;
        };
        Relationships: [];
      };
      pre_computed_props: {
        Row: {
          id: string;
          player_id: number;
          player_name: string;
          stat_type: string;
          line: number;
          projected_value: number;
          edge: number;
          confidence: number;
          bookmaker: string | null;
          game_date: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          player_id: number;
          player_name: string;
          stat_type: string;
          line: number;
          projected_value: number;
          edge: number;
          confidence: number;
          bookmaker?: string | null;
          game_date: string;
          created_at?: string;
        };
        Update: {
          projected_value?: number;
          edge?: number;
          confidence?: number;
          bookmaker?: string | null;
        };
        Relationships: [];
      };
      projection_logs: {
        Row: {
          id: string;
          player_id: number;
          stat: string;
          projected_value: number;
          actual_value: number | null;
          line: number;
          game_date: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          player_id: number;
          stat: string;
          projected_value: number;
          actual_value?: number | null;
          line: number;
          game_date: string;
          created_at?: string;
        };
        Update: {
          actual_value?: number | null;
        };
        Relationships: [];
      };
      nba_schedule: {
        Row: {
          id: string;
          game_id: number;
          home_team: string;
          away_team: string;
          game_date: string;
          game_time: string | null;
          status: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          game_id: number;
          home_team: string;
          away_team: string;
          game_date: string;
          game_time?: string | null;
          status?: string | null;
          created_at?: string;
        };
        Update: {
          status?: string | null;
          game_time?: string | null;
        };
        Relationships: [];
      };
      bug_reports: {
        Row: {
          id: string;
          user_id: string | null;
          reporter_name: string | null;
          page: string;
          description: string;
          app_version: string | null;
          platform: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          reporter_name?: string | null;
          page: string;
          description: string;
          app_version?: string | null;
          platform?: string | null;
          created_at?: string;
        };
        Update: {
          reporter_name?: string | null;
          page?: string;
          description?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
