import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact, Tag, LifecycleStage } from '../types';

// Ported from src/app/(dashboard)/contacts/page.tsx (web app) — same
// page size, same filter logic (search is server-side ILIKE on
// name/phone/email; tag filter routes through the existing
// filter_contacts_by_tags RPC — migration 025/041 — already callable
// from any Supabase client, no backend changes needed).

export const PAGE_SIZE = 25;

export interface ContactFilters {
  page: number;
  search: string;
  selectedTagIds: string[];
  selectedStageId: string | null;
}

export async function loadTags(db: SupabaseClient): Promise<Tag[]> {
  const { data, error } = await db.from('tags').select('*').order('name');
  if (error) throw error;
  return (data ?? []) as Tag[];
}

export async function loadLifecycleStages(db: SupabaseClient): Promise<LifecycleStage[]> {
  const { data, error } = await db
    .from('lifecycle_stages')
    .select('*')
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LifecycleStage[];
}

export async function loadContacts(
  db: SupabaseClient,
  filters: ContactFilters,
): Promise<{ contacts: Contact[]; totalCount: number }> {
  const { page, search, selectedTagIds, selectedStageId } = filters;
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const term = search.trim();

  if (selectedTagIds.length > 0) {
    const { data, error } = await db.rpc('filter_contacts_by_tags', {
      p_tag_ids: selectedTagIds,
      p_search: term || null,
      p_limit: PAGE_SIZE,
      p_offset: from,
      p_lifecycle_stage_id: selectedStageId,
    });
    if (error) throw error;
    const rows = (data ?? []) as { contact: Contact; total_count: number }[];
    return {
      contacts: rows.map((r) => r.contact),
      totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
    };
  }

  let query = db
    .from('contacts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (term) {
    const like = `%${term}%`;
    query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
  }
  if (selectedStageId) {
    query = query.eq('lifecycle_stage_id', selectedStageId);
  }

  const { data, count, error } = await query;
  if (error) throw error;
  return { contacts: (data ?? []) as Contact[], totalCount: count ?? 0 };
}

/** Hydrate `tags` onto each contact via the contact_tags join, same as web. */
export async function hydrateContactTags(
  db: SupabaseClient,
  contacts: Contact[],
  tagsMap: Record<string, Tag>,
): Promise<Contact[]> {
  if (contacts.length === 0) return contacts;
  const { data, error } = await db
    .from('contact_tags')
    .select('contact_id, tag_id')
    .in(
      'contact_id',
      contacts.map((c) => c.id),
    );
  if (error) throw error;

  const byContact = new Map<string, Tag[]>();
  for (const row of (data ?? []) as { contact_id: string; tag_id: string }[]) {
    const tag = tagsMap[row.tag_id];
    if (!tag) continue;
    const list = byContact.get(row.contact_id) ?? [];
    list.push(tag);
    byContact.set(row.contact_id, list);
  }

  return contacts.map((c) => ({ ...c, tags: byContact.get(c.id) ?? [] }));
}
