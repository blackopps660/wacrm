import { supabase, apiFetch, API_BASE_URL } from './supabase';

// Media plumbing shared by the chat composer (send) and message bubbles
// (render). Two very different auth situations apply to a `media_url`:
//
// - Outbound (agent-sent) media lands in the public `chat-media` bucket
//   (uploadDirectMedia below, or the compress-then-store API route) and
//   comes back as a public Storage URL — no auth needed to fetch it.
// - Inbound (customer-sent) media is proxied through
//   `/api/whatsapp/media/[mediaId]` (a *relative* path,
//   e.g. `/api/whatsapp/media/abc123`) which requires the caller's
//   session — the web app gets this for free via cookies, mobile has to
//   attach its Bearer token explicitly, same as any other API route.
//
// `resolveAuthedSource` makes both cases work with one call: absolute
// URLs pass through untouched (the extra header is harmless — Storage's
// public endpoint ignores it), relative ones get the API base URL
// prefixed and the current session's token attached.
export interface AuthedSource {
  uri: string;
  headers: Record<string, string>;
}

export async function resolveAuthedSource(url: string): Promise<AuthedSource | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  const uri = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
  return { uri, headers: { Authorization: `Bearer ${session.access_token}` } };
}

/** Same-shape helper for contexts that can't attach headers (Linking.openURL) — appends the token as a query param instead, which the media proxy route also accepts. */
export async function resolveOpenableUrl(url: string): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  const absolute = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
  if (absolute.startsWith(API_BASE_URL)) {
    const sep = absolute.includes('?') ? '&' : '?';
    return `${absolute}${sep}token=${encodeURIComponent(session.access_token)}`;
  }
  return absolute;
}

// ---- Uploads ----

export const CHAT_MEDIA_BUCKET = 'chat-media';

export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

// Mirrors src/lib/storage/upload-media.ts's buildMediaPath exactly
// (same account-scoped convention the bucket's RLS write policy
// matches on) — duplicated rather than shared since mobile can't
// import from the Next.js app's source tree.
function buildMediaPath(accountId: string, fileName: string, now: number = Date.now()): string {
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split('.').pop()!.toLowerCase() : 'bin';
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 40) || 'file';
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface UploadResult {
  publicUrl: string;
  path: string;
}

/** Images/video — routed through the server so they get the same sharp/ffmpeg compression pass inbound media gets. */
export async function uploadImageOrVideo(
  file: PickedFile,
  kind: 'image' | 'video',
): Promise<UploadResult> {
  const form = new FormData();
  // React Native's FormData accepts this {uri,name,type} shape directly;
  // it is not a real Blob but fetch's RN implementation knows how to
  // stream it from the uri.
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType,
  } as unknown as Blob);
  form.append('kind', kind);

  const res = await apiFetch('/api/whatsapp/media/upload', { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Upload failed');
  return { publicUrl: body.publicUrl, path: body.path };
}

/** Documents + voice notes — straight to Storage, same as the web composer's uploadAccountMedia (nothing to compress server-side). */
export async function uploadDirectMedia(file: PickedFile, accountId: string): Promise<UploadResult> {
  const response = await fetch(file.uri);
  const blob = await response.blob();
  const path = buildMediaPath(accountId, file.name);

  const { error } = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(path, blob, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.mimeType,
  });
  if (error) throw new Error(error.message);

  const {
    data: { publicUrl },
  } = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
  return { publicUrl, path };
}
