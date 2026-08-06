// Hand-written Database type covering the public schema created by
// supabase/migrations/0001_music_source_neutral.sql (music),
// supabase/migrations/0002_user_llm_keys.sql (BYOK keys),
// supabase/migrations/0003_music_imports.sql (playlist ingestion), and
// supabase/migrations/0004_provider_tokens.sql (encrypted OAuth tokens for the
// playlist-import flows). Mirrors what `supabase gen typescript` would produce
// (no CLI in this repo's toolchain yet). Keep in sync with those migrations
// when columns change.

export type Database = {
  public: {
    Tables: {
      // ---------------------------------------------------------------- music_plays
      music_plays: {
        Row: {
          id: string;
          user_id: string;
          track_id: string;
          title: string;
          artist: string;
          thumbnail: string | null;
          play_count: number;
          skip_count: number;
          complete_count: number;
          first_played_at: string;
          last_played_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          track_id: string;
          title: string;
          artist?: string;
          thumbnail?: string | null;
          play_count?: number;
          skip_count?: number;
          complete_count?: number;
          first_played_at?: string;
          last_played_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          track_id?: string;
          title?: string;
          artist?: string;
          thumbnail?: string | null;
          play_count?: number;
          skip_count?: number;
          complete_count?: number;
          first_played_at?: string;
          last_played_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_likes
      music_likes: {
        Row: {
          user_id: string;
          track_id: string;
          title: string;
          artist: string;
          thumbnail: string | null;
          liked_at: string;
        };
        Insert: {
          user_id: string;
          track_id: string;
          title: string;
          artist?: string;
          thumbnail?: string | null;
          liked_at?: string;
        };
        Update: {
          user_id?: string;
          track_id?: string;
          title?: string;
          artist?: string;
          thumbnail?: string | null;
          liked_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_suppressions
      music_suppressions: {
        Row: {
          user_id: string;
          track_id: string;
          kind: string;
          until: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          track_id: string;
          kind: string;
          until?: string | null;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          track_id?: string;
          kind?: string;
          until?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_transitions
      music_transitions: {
        Row: {
          user_id: string;
          from_track_id: string;
          to_track_id: string;
          skips: number;
          completions: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          from_track_id: string;
          to_track_id: string;
          skips?: number;
          completions?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          from_track_id?: string;
          to_track_id?: string;
          skips?: number;
          completions?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_track_tags
      music_track_tags: {
        Row: {
          track_id: string;
          tags: string[];
          created_at: string;
        };
        Insert: {
          track_id: string;
          tags?: string[];
          created_at?: string;
        };
        Update: {
          track_id?: string;
          tags?: string[];
          created_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_settings
      music_settings: {
        Row: {
          user_id: string;
          volume: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          volume?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          volume?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_track_sources
      music_track_sources: {
        Row: {
          track_id: string;
          provider: string;
          source_id: string;
        };
        Insert: {
          track_id: string;
          provider: string;
          source_id: string;
        };
        Update: {
          track_id?: string;
          provider?: string;
          source_id?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- music_imports
      // SP-3: per-user playlist-ingestion provenance. Distinct from music_plays
      // (which the import ALSO writes as a cold-start prior) so a source can be
      // audited/cleared. PK (user_id, provider, source_playlist_id, track_id)
      // makes re-importing the same playlist idempotent.
      music_imports: {
        Row: {
          user_id: string;
          provider: string;
          source_playlist_id: string;
          source_playlist_name: string;
          track_id: string;
          isrc: string | null;
          imported_at: string;
        };
        Insert: {
          user_id: string;
          provider: string;
          source_playlist_id: string;
          source_playlist_name?: string;
          track_id: string;
          isrc?: string | null;
          imported_at?: string;
        };
        Update: {
          user_id?: string;
          provider?: string;
          source_playlist_id?: string;
          source_playlist_name?: string;
          track_id?: string;
          isrc?: string | null;
          imported_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- user_llm_keys
      // SP-2 BYOK: encrypted API keys, one ciphertext per (user, provider).
      // `encrypted_key` + `iv` are bytea; the typed client surfaces bytea as a
      // base64 `string`. Plaintext is never stored and never sent to the client.
      user_llm_keys: {
        Row: {
          user_id: string;
          provider: string;
          encrypted_key: string;
          iv: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          provider: string;
          encrypted_key: string;
          iv: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          provider?: string;
          encrypted_key?: string;
          iv?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      // ---------------------------------------------------------------- provider_tokens
      // SP-3: encrypted OAuth tokens for the playlist-import flows (YouTube +
      // Spotify). One row per (user, provider). `encrypted_token` + `iv` are
      // bytea (typed client surfaces base64 strings); the plaintext token
      // envelope ({access, refresh?, expiresAt?}) is encrypted at rest via the
      // SAME AES-256-GCM root key as BYOK (`LLM_KEY_ENCRYPTION_KEY`).
      provider_tokens: {
        Row: {
          user_id: string;
          provider: string;
          encrypted_token: string;
          iv: string;
          scope: string;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          provider: string;
          encrypted_token: string;
          iv: string;
          scope?: string;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          provider?: string;
          encrypted_token?: string;
          iv?: string;
          scope?: string;
          expires_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [key: string]: never };
    Functions: {
      log_music_play: {
        Args: {
          p_track_id: string;
          p_title: string;
          p_artist: string;
          p_thumbnail: string;
        };
        Returns: void;
      };
      log_music_signal: {
        Args: {
          p_track_id: string;
          p_signal: string;
        };
        Returns: void;
      };
      log_music_transition: {
        Args: {
          p_from_track_id: string;
          p_to_track_id: string;
          p_signal: string;
        };
        Returns: void;
      };
    };
    Enums: { [key: string]: never };
    CompositeTypes: { [key: string]: never };
  };
};

// Convenience aliases so callers can write `Tables['music_plays']['Row']`.
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T];
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
