import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';

// Ported from src/components/settings/profile-form.tsx (web app) —
// same avatars bucket + path convention (`${user.id}/avatar-<ts>.<ext>`),
// same direct profiles update, same "email change goes through
// supabase.auth.updateUser + confirmation email" flow. No backend
// changes needed — this is all direct Supabase/Storage.

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export default function ProfileScreen() {
  const { user, profile, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setAvatarUrl(profile.avatar_url ?? null);
  }, [profile]);

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('Photo library access is required to change your avatar.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    if (asset.fileSize && asset.fileSize > MAX_AVATAR_BYTES) {
      setError('Image is too large. Maximum 2 MB.');
      return;
    }
    setPendingUri(asset.uri);
    setError(null);
  }

  async function handleSave() {
    if (!user || !profile) return;
    const trimmedName = fullName.trim();
    if (!trimmedName) {
      setError('Display name is required');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      let nextAvatarUrl = profile.avatar_url ?? null;

      if (pendingUri) {
        setUploading(true);
        const ext = pendingUri.split('.').pop()?.toLowerCase() || 'jpg';
        const path = `${user.id}/avatar-${Date.now()}.${ext}`;
        const response = await fetch(pendingUri);
        const blob = await response.blob();
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(path, blob, {
            cacheControl: '3600',
            upsert: true,
            contentType: blob.type || `image/${ext}`,
          });
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
        const {
          data: { publicUrl },
        } = supabase.storage.from('avatars').getPublicUrl(path);
        nextAvatarUrl = publicUrl;
        setUploading(false);
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ full_name: trimmedName, avatar_url: nextAvatarUrl })
        .eq('user_id', user.id);
      if (updateError) throw new Error(`Save failed: ${updateError.message}`);

      setAvatarUrl(nextAvatarUrl);
      setPendingUri(null);
      await refreshProfile();
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
      setUploading(false);
    }
  }

  const displayAvatar = pendingUri ?? avatarUrl;
  const initial = (fullName || profile?.email || 'U').charAt(0).toUpperCase();

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {success && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>Profile saved</Text>
        </View>
      )}

      <View style={styles.avatarRow}>
        <Pressable onPress={pickImage} style={styles.avatar}>
          {displayAvatar ? (
            <Image source={{ uri: displayAvatar }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarInitial}>{initial}</Text>
          )}
        </Pressable>
        <Pressable style={styles.changePhotoButton} onPress={pickImage} disabled={uploading}>
          <Text style={styles.changePhotoText}>
            {displayAvatar ? 'Change photo' : 'Upload photo'}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={fullName}
        onChangeText={setFullName}
        placeholder="Your name"
        placeholderTextColor="#64748b"
      />

      <Text style={styles.label}>Email</Text>
      <Text style={styles.readonlyValue}>{profile?.email ?? '—'}</Text>

      <Pressable
        style={[styles.saveButton, (saving || !fullName.trim()) && { opacity: 0.5 }]}
        onPress={handleSave}
        disabled={saving || !fullName.trim()}
      >
        {saving ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.saveButtonText}>Save changes</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617', padding: 16 },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, padding: 10, marginBottom: 12 },
  errorText: { color: '#fca5a5', fontSize: 12 },
  successBox: { backgroundColor: 'rgba(74,222,128,0.1)', borderRadius: 8, padding: 10, marginBottom: 12 },
  successText: { color: '#86efac', fontSize: 12 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 20 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(124,58,237,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: { width: 64, height: 64, borderRadius: 32 },
  avatarInitial: { color: '#a78bfa', fontSize: 24, fontWeight: '700' },
  changePhotoButton: {
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  changePhotoText: { color: '#e2e8f0', fontSize: 13, fontWeight: '500' },
  label: { color: '#94a3b8', fontSize: 12, marginTop: 12 },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    marginTop: 4,
  },
  readonlyValue: { color: '#64748b', fontSize: 15, marginTop: 4 },
  saveButton: {
    marginTop: 24,
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveButtonText: { color: '#fff', fontWeight: '600' },
});
