import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  Modal,
  FlatList,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../../../lib/supabase';
import { useAppTheme } from '../../../hooks/use-theme';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';

// Ported from src/components/settings/whatsapp-business-profile.tsx (web)
// — same fields, same GET/PATCH/photo-POST routes (live from Meta, not
// cached locally), same limits. The photo picker uses the RN
// {uri,name,type} FormData shape already established for media sends
// (mobile/lib/media.ts) rather than the web's raw File blob.

const VERTICAL_LABEL: Record<string, string> = {
  UNDEFINED: 'Not set',
  OTHER: 'Other',
  AUTO: 'Automotive',
  BEAUTY: 'Beauty, Spa and Salon',
  APPAREL: 'Clothing and Apparel',
  EDU: 'Education',
  ENTERTAIN: 'Entertainment',
  EVENT_PLAN: 'Event Planning and Service',
  FINANCE: 'Finance and Banking',
  GROCERY: 'Grocery, Supermarket, Convenience Store',
  GOVT: 'Public Service',
  HOTEL: 'Hotel and Lodging',
  HEALTH: 'Medical and Health',
  NONPROFIT: 'Non-profit',
  PROF_SERVICES: 'Professional Services',
  RETAIL: 'Shopping and Retail',
  TRAVEL: 'Travel and Transportation',
  RESTAURANT: 'Restaurant',
  NOT_A_BIZ: 'Not a Business',
};
const VERTICAL_OPTIONS = Object.keys(VERTICAL_LABEL);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

interface BusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_url?: string;
  websites?: string[];
  vertical?: string;
}

export default function BusinessProfileScreen() {
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const loadedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);

  const [about, setAbout] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [vertical, setVertical] = useState('UNDEFINED');
  const [website1, setWebsite1] = useState('');
  const [website2, setWebsite2] = useState('');

  const applyProfile = useCallback((p: BusinessProfile) => {
    setProfile(p);
    setAbout(p.about ?? '');
    setAddress(p.address ?? '');
    setDescription(p.description ?? '');
    setEmail(p.email ?? '');
    setVertical(p.vertical ?? 'UNDEFINED');
    setWebsite1(p.websites?.[0] ?? '');
    setWebsite2(p.websites?.[1] ?? '');
  }, []);

  const fetchProfile = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch('/api/whatsapp/config/profile', { method: 'GET' });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'Failed to load business profile');
        return;
      }
      applyProfile(data.profile || {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to reach Meta');
    }
  }, [applyProfile]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    fetchProfile().finally(() => setLoading(false));
  }, [fetchProfile]);

  async function handleSync() {
    setLoading(true);
    await fetchProfile();
    setLoading(false);
  }

  async function handleSave() {
    setSaving(true);
    setLoadError(null);
    try {
      const websites = [website1.trim(), website2.trim()].filter(Boolean);
      const res = await apiFetch('/api/whatsapp/config/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          about: about.trim(),
          address: address.trim(),
          description: description.trim(),
          email: email.trim(),
          vertical,
          websites,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'Failed to save business profile');
        return;
      }
      await fetchProfile();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to save business profile');
    } finally {
      setSaving(false);
    }
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setLoadError('Photo library access is required to change the business photo.');
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
    if (asset.fileSize && asset.fileSize > MAX_PHOTO_BYTES) {
      setLoadError('Photo is too large. Maximum 5 MB.');
      return;
    }
    const mimeType = asset.mimeType || 'image/jpeg';
    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
      setLoadError('Profile photo must be JPEG or PNG.');
      return;
    }

    setUploadingPhoto(true);
    setLoadError(null);
    try {
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const form = new FormData();
      form.append('file', {
        uri: asset.uri,
        name: `business-photo-${Date.now()}.${ext}`,
        type: mimeType,
      } as unknown as Blob);
      const res = await apiFetch('/api/whatsapp/config/profile/photo', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'Failed to upload profile photo');
        return;
      }
      await fetchProfile();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to upload profile photo');
    } finally {
      setUploadingPhoto(false);
    }
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
      <Text style={styles.subtitle}>
        The photo, about, and bio your contacts see on this WhatsApp number — synced
        directly with Meta.
      </Text>

      {loadError && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      )}

      <View style={styles.photoRow}>
        <View style={styles.avatar}>
          {profile?.profile_picture_url ? (
            <Image source={{ uri: profile.profile_picture_url }} style={styles.avatarImage} />
          ) : (
            <Ionicons name="business" size={26} color={colors.primary} />
          )}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Pressable
            style={[styles.photoButton, uploadingPhoto && { opacity: 0.6 }]}
            onPress={pickPhoto}
            disabled={uploadingPhoto}
          >
            {uploadingPhoto ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
            )}
            <Text style={styles.photoButtonText}>
              {profile?.profile_picture_url ? 'Change photo' : 'Upload photo'}
            </Text>
          </Pressable>
          <Text style={styles.hint}>Square JPEG or PNG, up to 5 MB.</Text>
        </View>
      </View>

      <Field label="About" value={about} onChangeText={setAbout} maxLength={139} placeholder="A short line shown next to your number" colors={colors} styles={styles} />
      <Field label="Email" value={email} onChangeText={setEmail} maxLength={128} placeholder="support@yourbusiness.com" keyboardType="email-address" autoCapitalize="none" colors={colors} styles={styles} />
      <Field label="Address" value={address} onChangeText={setAddress} maxLength={256} placeholder="Business address" colors={colors} styles={styles} />

      <Text style={styles.label}>Category</Text>
      <Pressable style={styles.selectButton} onPress={() => setCategoryPickerOpen(true)}>
        <Text style={styles.selectButtonText}>{VERTICAL_LABEL[vertical] ?? vertical}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textFaint} />
      </Pressable>

      <Field label="Website 1" value={website1} onChangeText={setWebsite1} placeholder="https://yourbusiness.com" autoCapitalize="none" colors={colors} styles={styles} />
      <Field label="Website 2" value={website2} onChangeText={setWebsite2} placeholder="https://yourbusiness.com/shop" autoCapitalize="none" colors={colors} styles={styles} />

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        value={description}
        onChangeText={setDescription}
        maxLength={512}
        multiline
        numberOfLines={4}
        placeholder="Tell customers what your business does"
        placeholderTextColor={colors.textFaint}
      />

      <View style={styles.actionsRow}>
        <Pressable style={styles.syncButton} onPress={handleSync}>
          <Ionicons name="refresh" size={16} color={colors.textSecondary} />
          <Text style={styles.syncButtonText}>Sync</Text>
        </Pressable>
        <Pressable
          style={[styles.saveButton, saving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save Profile</Text>
          )}
        </Pressable>
      </View>

      <Modal
        visible={categoryPickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCategoryPickerOpen(false)}
      >
        <View style={styles.container}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Category</Text>
            <Pressable onPress={() => setCategoryPickerOpen(false)} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>
          <FlatList
            data={VERTICAL_OPTIONS}
            keyExtractor={(v) => v}
            renderItem={({ item }) => (
              <Pressable
                style={styles.pickerRow}
                onPress={() => {
                  setVertical(item);
                  setCategoryPickerOpen(false);
                }}
              >
                <Text style={styles.pickerRowText}>{VERTICAL_LABEL[item]}</Text>
                {vertical === item && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </Pressable>
            )}
          />
        </View>
      </Modal>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  keyboardType,
  autoCapitalize,
  colors,
  styles,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  maxLength?: number;
  keyboardType?: 'default' | 'email-address';
  autoCapitalize?: 'none' | 'sentences';
  colors: Palette;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        maxLength={maxLength}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
      />
    </>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: spacing.lg, paddingBottom: 48, gap: 4 },
    subtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginBottom: spacing.sm },
    errorBox: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm + 2, marginBottom: spacing.sm },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarImage: { width: 64, height: 64 },
    photoButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 2,
    },
    photoButtonText: { color: colors.text, fontSize: 13, fontWeight: '600' },
    hint: { color: colors.textFaint, fontSize: 11 },
    label: { color: colors.textMuted, fontSize: 12, marginTop: spacing.md },
    input: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm,
      color: colors.text,
      marginTop: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    textarea: { minHeight: 90, textAlignVertical: 'top' },
    selectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.sm + 2,
      marginTop: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    selectButtonText: { color: colors.text, fontSize: 14 },
    actionsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
    syncButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    syncButtonText: { color: colors.textSecondary, fontWeight: '600', fontSize: 13 },
    saveButton: {
      flex: 1,
      backgroundColor: colors.primary,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.sm + 2,
    },
    saveButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
    pickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerRowText: { color: colors.text, fontSize: 14 },
  });
}
