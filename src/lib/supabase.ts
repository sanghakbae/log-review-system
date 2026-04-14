import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const fallbackUrl = 'https://placeholder.invalid';
const fallbackKey = 'public-anon-key';
const hasValidUrl = Boolean(supabaseUrl && !supabaseUrl.includes('placeholder.supabase.co'));
const hasValidAnonKey = Boolean(supabaseAnonKey && supabaseAnonKey !== fallbackKey);

export const isSupabaseConfigured = hasValidUrl && hasValidAnonKey;

if (!isSupabaseConfigured) {
  // App still renders, but auth/data actions will be disabled until env vars exist.
  console.warn('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

export const supabase = createClient(supabaseUrl ?? fallbackUrl, supabaseAnonKey ?? fallbackKey);
