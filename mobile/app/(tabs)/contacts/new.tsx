import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { loadTags, loadLifecycleStages } from '../../../lib/contacts/queries';
import type { Tag, LifecycleStage } from '../../../lib/types';

export default function NewContactScreen() {
  const router = useRouter();
  const { user, accountId } = useAuth();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [stageId, setStageId] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const [tags, setTags] = useState<Tag[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTags(supabase).then(setTags).catch(console.error);
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
  }, []);

  function toggleTag(id: string) {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleStage(id: string) {
    setStageId((prev) => (prev === id ? null : id));
  }

  async function handleCreate() {
    if (!phone.trim()) {
      setError('Phone is required');
      return;
    }
    if (!user || !accountId) return;

    setSaving(true);
    setError(null);
    try {
      const { data, error: insertErr } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: name.trim() || null,
          phone: phone.trim(),
          email: email.trim() || null,
          company: company.trim() || null,
          lifecycle_stage_id: stageId,
        })
        .select('id')
        .single();

      if (insertErr) {
        // Postgres unique_violation on phone_normalized — friendlier
        // than the raw constraint error, without porting the web's
        // full fuzzy phone-variant dedupe helper for this first pass.
        if (insertErr.code === '23505') {
          setError('A contact with this phone number already exists.');
        } else {
          setError(insertErr.message);
        }
        return;
      }

      const contactId = data.id as string;
      if (selectedTagIds.length > 0) {
        await supabase
          .from('contact_tags')
          .insert(selectedTagIds.map((tag_id) => ({ contact_id: contactId, tag_id })));
      }

      router.replace(`/contacts/${contactId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contact');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor="#64748b" />
      <Text style={styles.label}>Phone *</Text>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="+1234567890" placeholderTextColor="#64748b" keyboardType="phone-pad" />
      <Text style={styles.label}>Email</Text>
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#64748b" keyboardType="email-address" autoCapitalize="none" />
      <Text style={styles.label}>Company</Text>
      <TextInput style={styles.input} value={company} onChangeText={setCompany} placeholder="Company" placeholderTextColor="#64748b" />

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

      <Text style={styles.label}>Tags</Text>
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

      <Pressable
        style={[styles.createButton, (!phone.trim() || saving) && { opacity: 0.5 }]}
        onPress={handleCreate}
        disabled={!phone.trim() || saving}
      >
        {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.createButtonText}>Create Contact</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  content: { padding: 16, paddingBottom: 40, gap: 4 },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, padding: 10, marginBottom: 8 },
  errorText: { color: '#fca5a5', fontSize: 12 },
  label: { color: '#94a3b8', fontSize: 12, marginTop: 12 },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    marginTop: 4,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  chipText: { color: '#94a3b8', fontSize: 12 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  emptyText: { color: '#64748b', fontSize: 13 },
  createButton: {
    marginTop: 24,
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  createButtonText: { color: '#fff', fontWeight: '600' },
});
