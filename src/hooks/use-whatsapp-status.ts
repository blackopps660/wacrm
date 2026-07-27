"use client";

import { useEffect, useState } from "react";

/**
 * WhatsApp connection health, derived from `GET /api/whatsapp/config`:
 *
 *   green   — connected: true (number registered, token valid, Meta reachable)
 *   yellow  — configured but unhealthy (corrupted token, Meta API error, …)
 *   red     — not configured at all (reason: no_config)
 *   unknown — still loading / request failed
 *
 * That config route makes a live Meta API call, so the result is cached
 * at module scope for the lifetime of the page session — the sidebar dot
 * re-renders on every route change and must not re-hit Meta each time.
 * Settings' own "Connect/Save" flow is where a fresh check belongs; this
 * is just an ambient indicator.
 */
export type WhatsappStatus = "green" | "yellow" | "red" | "unknown";

interface ConfigResponse {
  connected: boolean;
  reason?: string;
}

let cached: WhatsappStatus | null = null;
let inFlight: Promise<WhatsappStatus> | null = null;

function classify(data: ConfigResponse): WhatsappStatus {
  if (data.connected) return "green";
  // The route returns reason: 'no_config' only when nothing has been set
  // up yet. Every other falsy state (token_corrupted, meta_api_error,
  // db_error, unknown) means it WAS configured but is currently broken —
  // that's the amber "needs attention" case, not the red "never set up".
  if (data.reason === "no_config") return "red";
  return "yellow";
}

async function fetchStatus(): Promise<WhatsappStatus> {
  try {
    const res = await fetch("/api/whatsapp/config", { cache: "no-store" });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as ConfigResponse;
    return classify(data);
  } catch {
    return "unknown";
  }
}

export function useWhatsappStatus(): WhatsappStatus {
  const [status, setStatus] = useState<WhatsappStatus>(cached ?? "unknown");

  useEffect(() => {
    if (cached) {
      setStatus(cached);
      return;
    }
    let active = true;
    // Dedupe concurrent mounts (sidebar + any other consumer) onto one
    // request.
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

/** Invalidate the cached status — call after Settings saves/resets the
 *  WhatsApp connection so the sidebar dot refreshes without a reload. */
export function invalidateWhatsappStatus() {
  cached = null;
  inFlight = null;
}
