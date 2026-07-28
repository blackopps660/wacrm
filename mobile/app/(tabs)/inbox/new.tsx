import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase, apiFetch } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, type Palette } from '../../../lib/theme';
import { TemplatePicker, renderBodyPreview } from '../../../components/TemplatePicker';
import type { MessageTemplate } from '../../../lib/types';

// Business-initiated conversation: WhatsApp requires an approved
// template to message someone who hasn't texted the account first (see
// TemplatePicker). Pick an existing contact or add a new number, then
// pick+fill a template. There's no "check if this number has WhatsApp"
// call on the Cloud API — an invalid number only surfaces as Meta
// rejecting the actual send, which lands as the error below.

interface ContactHit {
  id: string;
  name: string | null;
  phone: string;
}

export default function NewConversationScreen() {
  const router = useRouter();
  const { user, accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ContactHit | null>(null);

  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (mode !== 'existing') return;
    const q = search.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .order('name', { ascending: true })
        .limit(20);
      setResults((data as ContactHit[]) ?? []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [search, mode]);

  async function proceedToTemplate() {
    setError(null);
    if (mode === 'existing') {
      if (!selected) return;
      setTemplateOpen(true);
      return;
    }

    if (!newPhone.trim()) {
      setError('Phone number is required');
      return;
    }
    if (!user || !accountId) return;

    setCreating(true);
    try {
      const { data, error: insertErr } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: newName.trim() || null,
          phone: newPhone.trim(),
        })
        .select('id, name, phone')
        .single();

      if (insertErr) {
        if (insertErr.code === '23505') {
          setError('A contact with this phone number already exists.');
        } else {
          setError(insertErr.message);
        }
        return;
      }

      setSelected(data as ContactHit);
      setTemplateOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contact');
    } finally {
      setCreating(false);
    }
  }

  async function handleSendTemplate(template: MessageTemplate, values: { body: string[] }) {
    if (!selected) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: selected.id,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: { body: values.body },
          template_params: values.body,
          content_text: renderBodyPreview(template.body_text, values.body),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload.error || 'Failed to send — this number may not be on WhatsApp');
        return;
      }
      if (payload.conversation_id) {
        router.replace({
          pathname: '/inbox/[id]',
          params: {
            id: payload.conversation_id,
            name: selected.name ?? selected.phone,
            phone: selected.phone,
          },
        });
      } else {
        router.back();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send template');
    } finally {
      setSending(false);
    }
  }

  const canProceed = mode === 'existing' ? !!selected : !!newPhone.trim();

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.hint}>
        <Text style={styles.hintText}>
          WhatsApp requires an approved template to message someone who hasn&apos;t texted
          you first. Pick or add a contact, then choose a template.
        </Text>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tab, mode === 'existing' && styles.tabActive]}
          onPress={() => setMode('existing')}
        >
          <Text style={[styles.tabText, mode === 'existing' && styles.tabTextActive]}>
            Existing contact
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, mode === 'new' && styles.tabActive]}
          onPress={() => setMode('new')}
        >
          <Text style={[styles.tabText, mode === 'new' && styles.tabTextActive]}>New number</Text>
        </Pressable>
      </View>

      {mode === 'existing' ? (
        <View style={{ flex: 1 }}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={colors.textFaint} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={(t) => {
                setSearch(t);
                setSelected(null);
              }}
              placeholder="Search by name or phone..."
              placeholderTextColor={colors.textFaint}
            />
          </View>
          {searching ? (
            <ActivityIndicator style={{ marginTop: 20 }} color={colors.primary} />
          ) : (
            <FlatList
              data={results}
              keyExtractor={(c) => c.id}
              contentContainerStyle={{ padding: 16, paddingTop: 8 }}
              ListEmptyComponent={
                search.trim() ? (
                  <Text style={styles.emptyText}>No contacts match &quot;{search.trim()}&quot;</Text>
                ) : (
                  <Text style={styles.emptyText}>Start typing to search your contacts</Text>
                )
              }
              renderItem={({ item }) => {
                const isSelected = selected?.id === item.id;
                return (
                  <Pressable
                    style={[styles.contactRow, isSelected && styles.contactRowSelected]}
                    onPress={() => setSelected(item)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.contactName}>{item.name || 'Unnamed'}</Text>
                      <Text style={styles.contactPhone}>{item.phone}</Text>
                    </View>
                    {isSelected && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      ) : (
        <View style={{ padding: 16, gap: 4 }}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            placeholder="Full name"
            placeholderTextColor={colors.textFaint}
          />
          <Text style={styles.label}>Phone *</Text>
          <TextInput
            style={styles.input}
            value={newPhone}
            onChangeText={setNewPhone}
            placeholder="+1234567890"
            placeholderTextColor={colors.textFaint}
            keyboardType="phone-pad"
          />
        </View>
      )}

      <View style={styles.footer}>
        <Pressable
          style={[styles.nextButton, (!canProceed || creating) && { opacity: 0.5 }]}
          onPress={proceedToTemplate}
          disabled={!canProceed || creating}
        >
          {creating ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.nextButtonText}>Next: pick template</Text>
          )}
        </Pressable>
      </View>

      <TemplatePicker
        visible={templateOpen}
        onClose={() => setTemplateOpen(false)}
        onSelect={handleSendTemplate}
      />

      {sending && (
        <View style={styles.sendingOverlay}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    hint: { paddingHorizontal: 16, paddingTop: 12 },
    hintText: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
    errorBox: { marginHorizontal: 16, marginTop: 10, backgroundColor: colors.dangerBg, borderRadius: 8, padding: 10 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    tabRow: { flexDirection: 'row', gap: 6, padding: 16, paddingBottom: 8 },
    tab: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 8,
      alignItems: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    tabActive: { backgroundColor: colors.primaryMuted },
    tabText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    tabTextActive: { color: colors.primary },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      backgroundColor: colors.surfaceRaised,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    searchInput: { flex: 1, color: colors.text, fontSize: 14 },
    emptyText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', marginTop: 24 },
    contactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    contactRowSelected: { borderColor: colors.primary },
    contactName: { color: colors.text, fontSize: 14, fontWeight: '600' },
    contactPhone: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
    label: { color: colors.textMuted, fontSize: 12, marginTop: 12 },
    input: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      marginTop: 4,
    },
    footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    nextButton: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    nextButtonText: { color: colors.white, fontWeight: '600' },
    sendingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.3)',
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
