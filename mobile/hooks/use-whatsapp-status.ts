import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/supabase';

/**
 * WhatsApp connection health, derived from `GET /api/whatsapp/config` —
 * same classification as the web sidebar's dot (`src/hooks/use-whatsapp-status.ts`),
 * ported here since the web and mobile apps don't share a package.
 *
 *   green   — connected: true
 *   yellow  — configured but unhealthy (corrupted token, Meta API error, …)
 *   red     — never configured (reason: 'no_config')
 *   unknown — still loading / request failed
 *
 * Cached at module scope so navigating between Settings screens doesn't
 * re-hit the live Meta API call behind this route each time.
 */
export type WhatsappStatus = 'green' | 'yellow' | 'red' | 'unknown';

interface ConfigResponse {
  connected: boolean;
  reason?: string;
}

let cached: WhatsappStatus | null = null;
let inFlight: Promise<WhatsappStatus> | null = null;

function classify(data: ConfigResponse): WhatsappStatus {
  if (data.connected) return 'green';
  if (data.reason === 'no_config') return 'red';
  return 'yellow';
}

async function fetchStatus(): Promise<WhatsappStatus> {
  try {
    const res = await apiFetch('/api/whatsapp/config', { method: 'GET' });
    if (!res.ok) return 'unknown';
    const data = (await res.json()) as ConfigResponse;
    return classify(data);
  } catch {
    return 'unknown';
  }
}

export function useWhatsappStatus(): WhatsappStatus {
  const [status, setStatus] = useState<WhatsappStatus>(cached ?? 'unknown');

  useEffect(() => {
    if (cached) {
      setStatus(cached);
      return;
    }
    let active = true;
    inFlight ??= fetchStatus();
    inFlight.then((s) => {
      cached = s;
      inFlight = null;
      if (active) setStatus(s);
    });
    return () => {
      active = false;
    };
  }, []);

  return status;
}

/** Invalidate the cache — call after the WhatsApp settings screen
 *  connects/resets so the status dot refreshes without a full reload. */
export function invalidateWhatsappStatus() {
  cached = null;
  inFlight = null;
}
