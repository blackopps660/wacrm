import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Switch,
  ScrollView,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiFetch } from '../../../lib/supabase';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, spacing, radius, type Palette } from '../../../lib/theme';

// Ported from src/components/settings/ai-config.tsx (web) — same
// POST/PATCH /api/ai/agents[/id] routes, same "bring your own key,
// encrypted at rest, never shown again" model. Embeddings key +
// knowledge base fields are intentionally not here (see agents.tsx).

type Provider = 'openai' | 'anthropic';

const MASKED = '••••••••••••••••';

export default function AgentEditScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState('gpt-4o');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [unlimited, setUnlimited] = useState(true);
  const [maxPerConversation, setMaxPerConversation] = useState('3');
  const [newConvOwner, setNewConvOwner] = useState<'human' | 'ai'>('human');

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/ai/agents/${id}`, { method: 'GET' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Failed to load agent');
        if (cancelled) return;
        setName(body.name ?? '');
        setProvider(body.provider === 'anthropic' ? 'anthropic' : 'openai');
        setModel(body.model ?? '');
        setHasKey(!!body.has_key);
        setApiKey(body.has_key ? MASKED : '');
        setSystemPrompt(body.system_prompt ?? '');
        setIsActive(!!body.is_active);
        setAutoReplyEnabled(!!body.auto_reply_enabled);
        setUnlimited(body.auto_reply_max_per_conversation == null);
        setMaxPerConversation(String(body.auto_reply_max_per_conversation ?? 3));
        setNewConvOwner(body.default_new_conversation_owner === 'ai' ? 'ai' : 'human');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load agent');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!model.trim()) {
      setError('Model is required');
      return;
    }
    const keyToSend = apiKey === MASKED ? '' : apiKey.trim();
    if (isNew && !keyToSend) {
      setError('API key is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        provider,
        model: model.trim(),
        api_key: keyToSend || undefined,
        system_prompt: systemPrompt.trim() || null,
        is_active: isActive,
        auto_reply_enabled: autoReplyEnabled,
        auto_reply_max_per_conversation: unlimited ? null : Math.max(1, parseInt(maxPerConversation, 10) || 1),
        default_new_conversation_owner: newConvOwner,
      };
      const res = isNew
        ? await apiFetch('/api/ai/agents', { method: 'POST', body: JSON.stringify(payload) })
        : await apiFetch(`/api/ai/agents/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to save agent');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault() {
    if (isNew) return;
    try {
      const res = await apiFetch('/api/ai/agents/default', {
        method: 'POST',
        body: JSON.stringify({ agent_id: id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to set default agent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set default agent');
    }
  }

  function handleDelete() {
    if (isNew) return;
    Alert.alert('Delete agent', `Delete "${name}"? This can’t be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            const res = await apiFetch(`/api/ai/agents/${id}`, { method: 'DELETE' });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Failed to delete agent');
            router.back();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete agent');
            setDeleting(false);
          }
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Text style={styles.label}>Agent name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="e.g. TikFlick Sales Assistant"
        placeholderTextColor={colors.textFaint}
      />

      <Text style={styles.label}>Provider</Text>
      <View style={styles.toggleRow}>
        {(['openai', 'anthropic'] as Provider[]).map((p) => (
          <Pressable
            key={p}
            onPress={() => setProvider(p)}
            style={[styles.toggleOption, provider === p && styles.toggleOptionActive]}
          >
            <Text style={[styles.toggleOptionText, provider === p && styles.toggleOptionTextActive]}>
              {p === 'openai' ? 'OpenAI' : 'Anthropic'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Model</Text>
      <TextInput
        style={styles.input}
        value={model}
        onChangeText={setModel}
        placeholder="gpt-4o"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
      />

      <Text style={styles.label}>API key</Text>
      <TextInput
        style={styles.input}
        value={apiKey}
        onChangeText={setApiKey}
        onFocus={() => {
          if (apiKey === MASKED) setApiKey('');
        }}
        placeholder="sk-..."
        placeholderTextColor={colors.textFaint}
        secureTextEntry
        autoCapitalize="none"
      />
      {hasKey && apiKey !== MASKED && (
        <Text style={styles.hint}>Leave blank to keep the stored key.</Text>
      )}

      <Text style={styles.label}>Business context &amp; instructions</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        value={systemPrompt}
        onChangeText={setSystemPrompt}
        placeholder="Tell the assistant about your business — products, tone, what it may and may not promise."
        placeholderTextColor={colors.textFaint}
        multiline
        numberOfLines={8}
        textAlignVertical="top"
      />

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchLabel}>Enable AI assistant</Text>
          <Text style={styles.hint}>Master switch — turns on the &quot;Draft with AI&quot; button in the inbox.</Text>
        </View>
        <Switch value={isActive} onValueChange={setIsActive} trackColor={{ true: colors.primary }} />
      </View>

      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchLabel}>Auto-reply to inbound messages</Text>
          <Text style={styles.hint}>Answers new messages automatically when no agent is assigned.</Text>
        </View>
        <Switch value={autoReplyEnabled} onValueChange={setAutoReplyEnabled} trackColor={{ true: colors.primary }} />
      </View>

      {autoReplyEnabled && (
        <>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Unlimited replies per conversation</Text>
            <Switch value={unlimited} onValueChange={setUnlimited} trackColor={{ true: colors.primary }} />
          </View>
          {!unlimited && (
            <TextInput
              style={styles.input}
              value={maxPerConversation}
              onChangeText={(v) => setMaxPerConversation(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder="3"
              placeholderTextColor={colors.textFaint}
            />
          )}

          <Text style={styles.label}>New conversations go to</Text>
          <View style={styles.toggleRow}>
            <Pressable
              onPress={() => setNewConvOwner('human')}
              style={[styles.toggleOption, newConvOwner === 'human' && styles.toggleOptionActive]}
            >
              <Text style={[styles.toggleOptionText, newConvOwner === 'human' && styles.toggleOptionTextActive]}>
                Agent
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setNewConvOwner('ai')}
              style={[styles.toggleOption, newConvOwner === 'ai' && styles.toggleOptionActive]}
            >
              <Text style={[styles.toggleOptionText, newConvOwner === 'ai' && styles.toggleOptionTextActive]}>
                AI Agent
              </Text>
            </Pressable>
          </View>
        </>
      )}

      <Pressable style={[styles.saveButton, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
        {saving ? <ActivityIndicator color={colors.white} size="small" /> : <Text style={styles.saveButtonText}>Save</Text>}
      </Pressable>

      {!isNew && (
        <>
          <Pressable style={styles.outlineButton} onPress={handleSetDefault}>
            <Text style={styles.outlineButtonText}>Set as default agent</Text>
          </Pressable>
          <Pressable style={[styles.deleteButton, deleting && { opacity: 0.6 }]} onPress={handleDelete} disabled={deleting}>
            {deleting ? (
              <ActivityIndicator color={colors.dangerMuted} size="small" />
            ) : (
              <Text style={styles.deleteButtonText}>Delete agent</Text>
            )}
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    errorBox: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm + 2 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    label: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
    hint: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
    input: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
    },
    textArea: { minHeight: 140 },
    toggleRow: { flexDirection: 'row', gap: 8 },
    toggleOption: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    toggleOptionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    toggleOptionText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    toggleOptionTextActive: { color: colors.white },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    switchLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
    saveButton: {
      marginTop: spacing.sm,
      backgroundColor: colors.primary,
      borderRadius: radius.sm,
      paddingVertical: 14,
      alignItems: 'center',
    },
    saveButtonText: { color: colors.white, fontWeight: '700' },
    outlineButton: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
      paddingVertical: 12,
      alignItems: 'center',
    },
    outlineButtonText: { color: colors.textSecondary, fontWeight: '600', fontSize: 13 },
    deleteButton: {
      backgroundColor: colors.dangerBg,
      borderWidth: 1,
      borderColor: colors.dangerBorder,
      borderRadius: radius.sm,
      paddingVertical: 12,
      alignItems: 'center',
      marginBottom: spacing.xl,
    },
    deleteButtonText: { color: colors.dangerMuted, fontWeight: '600', fontSize: 13 },
  });
}
