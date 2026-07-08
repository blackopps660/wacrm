import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Same public project URL/anon key the web app embeds in its client
// bundle (src/lib/supabase/client.ts) — safe to ship, protected by RLS.
// Session persistence uses AsyncStorage instead of the web app's
// HTTP-only cookies; both read/write the same auth.users /
// public.profiles rows, just with a different session store.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set (see .env.example).',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/** Base URL for the Next.js API routes this app calls with a Bearer session token. */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Fetch wrapper for wacrm's Next.js API routes (the ones that need the
 * Meta access token server-side, e.g. sending a WhatsApp message).
 * Attaches the current session's JWT as a Bearer token — see
 * createClientForRequest() in the web app's src/lib/supabase/server.ts,
 * which accepts this as an alternative to the browser's cookie session.
 */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.access_token}`);
  // FormData bodies (media upload) need the multipart boundary that
  // fetch generates itself — setting Content-Type manually here would
  // strip it and break the upload.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}
