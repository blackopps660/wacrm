import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, type Palette } from '../../../lib/theme';
import { loadTags, loadLifecycleStages } from '../../../lib/contacts/queries';
import type { Contact, Tag, LifecycleStage, ContactNote } from '../../../lib/types';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function ContactDetailScreen() {
  const { id: contactId } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const { user, accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [stageId, setStageId] = useState<string | null>(null);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ data: contact, error: cErr }, allTags, allStages, { data: contactTags }, { data: noteRows }] =
        await Promise.all([
          supabase.from('contacts').select('*').eq('id', contactId).single(),
          loadTags(supabase),
          loadLifecycleStages(supabase),
          supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId),
          supabase
            .from('contact_notes')
            .select('*')
            .eq('contact_id', contactId)
            .order('created_at', { ascending: false }),
        ]);
      if (cErr) throw cErr;
      const c = contact as Contact;
      setName(c.name || '');
      setPhone(c.phone || '');
      setEmail(c.email || '');
      setCompany(c.company || '');
      setStageId(c.lifecycle_stage_id ?? null);
      setTags(allTags);
      setStages(allStages);
      setSelectedTagIds(((contactTags ?? []) as { tag_id: string }[]).map((r) => r.tag_id));
      setNotes((noteRows ?? []) as ContactNote[]);
      navigation.setOptions({ title: c.name || c.phone });
    } catch (err) {
      console.error('[ContactDetail] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load contact');
    }
  }, [contactId, navigation]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { error: updateErr } = await supabase
        .from('contacts')
        .update({
          name: name.trim() || null,
          phone: phone.trim(),
          email: email.trim() || null,
          company: company.trim() || null,
          lifecycle_stage_id: stageId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contactId);
      if (updateErr) throw updateErr;
      navigation.setOptions({ title: name.trim() || phone.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  }

  async function toggleTag(tagId: string) {
    const isSelected = selectedTagIds.includes(tagId);
    setSelectedTagIds((prev) => (isSelected ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
    if (isSelected) {
      await supabase.from('contact_tags').delete().eq('contact_id', contactId).eq('tag_id', tagId);
    } else {
      await supabase.from('contact_tags').insert({ contact_id: contactId, tag_id: tagId });
    }
  }

  function toggleStage(id: string) {
    setStageId((prev) => (prev === id ? null : id));
  }

  async function handleAddNote() {
    const trimmed = newNote.trim();
    if (!trimmed || !user || !accountId) return;
    setAddingNote(true);
    try {
      const { data, error: noteErr } = await supabase
        .from('contact_notes')
        .insert({
          contact_id: contactId,
          account_id: accountId,
          user_id: user.id,
          note_text: trimmed,
        })
        .select('*')
        .single();
      if (noteErr) throw noteErr;
      setNotes((prev) => [data as ContactNote, ...prev]);
      setNewNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add note');
    } finally {
      setAddingNote(false);
    }
  }

  async function handleDeleteNote(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    await supabase.from('contact_notes').delete().eq('id', noteId);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Details</Text>
        <Text style={styles.label}>Name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor={colors.textFaint} />
        <Text style={styles.label}>Phone</Text>
        <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="+1234567890" placeholderTextColor={colors.textFaint} keyboardType="phone-pad" />
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={colors.textFaint} keyboardType="email-address" autoCapitalize="none" />
        <Text style={styles.label}>Company</Text>
        <TextInput style={styles.input} value={company} onChangeText={setCompany} placeholder="Company" placeholderTextColor={colors.textFaint} />

        <Text style={styles.label}>Lifecycle Stage</Text>
        <View style={styles.chipRow}>
          {stages.map((s) => {
            const active = stageId === s.id;
            return (
              <Pressable
                key={s.id}
                onPress={() => toggleStage(s.id)}
                style={[styles.chip, active && { backgroundColor: s.color, borderColor: s.color }]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {s.name}
                  {s.is_lost ? ' (lost)' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.white} size="small" /> : <Text style={styles.saveButtonText}>Save</Text>}
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Tags</Text>
        <View style={styles.chipRow}>
          {tags.map((t) => {
            const active = selectedTagIds.includes(t.id);
            return (
              <Pressable
                key={t.id}
                onPress={() => toggleTag(t.id)}
                style={[styles.chip, active && { backgroundColor: t.color, borderColor: t.color }]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{t.name}</Text>
              </Pressable>
            );
          })}
          {tags.length === 0 && <Text style={styles.emptyText}>No tags defined yet</Text>}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Notes</Text>
        <View style={styles.noteInputRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={newNote}
            onChangeText={setNewNote}
            placeholder="Add a note…"
            placeholderTextColor={colors.textFaint}
            multiline
          />
          <Pressable
            style={[styles.addNoteButton, (!newNote.trim() || addingNote) && { opacity: 0.5 }]}
            onPress={handleAddNote}
            disabled={!newNote.trim() || addingNote}
          >
            <Text style={styles.saveButtonText}>Add</Text>
          </Pressable>
        </View>
        {notes.length === 0 ? (
          <Text style={styles.emptyText}>No notes yet</Text>
        ) : (
          notes.map((n) => (
            <View key={n.id} style={styles.noteRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.noteText}>{n.note_text}</Text>
                <Text style={styles.noteTime}>{timeAgo(n.created_at)}</Text>
              </View>
              <Pressable onPress={() => handleDeleteNote(n.id)}>
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, paddingBottom: 40, gap: 16 },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    errorBox: { backgroundColor: colors.dangerBg, borderRadius: 8, padding: 10 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 4,
    },
    cardTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
    label: { color: colors.textMuted, fontSize: 12, marginTop: 8 },
    input: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: colors.text,
      marginTop: 4,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    chipText: { color: colors.textMuted, fontSize: 12 },
    chipTextActive: { color: colors.white, fontWeight: '600' },
    saveButton: {
      marginTop: 14,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveButtonText: { color: colors.white, fontWeight: '600' },
    emptyText: { color: colors.textFaint, fontSize: 13 },
    noteInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end', marginBottom: 12 },
    addNoteButton: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    noteRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingVertical: 10,
    },
    noteText: { color: colors.textSecondary, fontSize: 13 },
    noteTime: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
    deleteText: { color: colors.danger, fontSize: 12 },
  });
}
