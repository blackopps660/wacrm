'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Save, Upload, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';

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

interface BusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_url?: string;
  websites?: string[];
  vertical?: string;
}

interface WhatsAppBusinessProfileProps {
  /** Only fetch/render once the underlying number is actually connected. */
  enabled: boolean;
}

export function WhatsAppBusinessProfile({ enabled }: WhatsAppBusinessProfileProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);

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
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/whatsapp/config/profile', { method: 'GET' });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error || 'Failed to load business profile');
        return;
      }
      applyProfile(data.profile || {});
    } catch (err) {
      console.error('fetchProfile error:', err);
      setLoadError('Failed to reach Meta. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [applyProfile]);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    fetchProfile();
  }, [enabled, fetchProfile]);

  async function handleSync() {
    await fetchProfile();
    if (!loadError) toast.success('Synced latest profile from Meta');
  }

  async function handleSave() {
    setSaving(true);
    try {
      const websites = [website1.trim(), website2.trim()].filter(Boolean);
      const res = await fetch('/api/whatsapp/config/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
        toast.error(data.error || 'Failed to save business profile');
        return;
      }
      toast.success('Business profile saved to Meta');
      await fetchProfile();
    } catch (err) {
      console.error('save profile error:', err);
      toast.error('Failed to save business profile');
    } finally {
      setSaving(false);
    }
  }

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('Profile photo must be JPEG or PNG.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Photo is too large. Maximum 5 MB.');
      return;
    }

    void uploadPhoto(file);
  }

  async function uploadPhoto(file: File) {
    setUploadingPhoto(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/whatsapp/config/profile/photo', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to upload profile photo');
        return;
      }
      toast.success('Profile photo updated. It may take a minute to appear on WhatsApp.');
      await fetchProfile();
    } catch (err) {
      console.error('upload photo error:', err);
      toast.error('Failed to upload profile photo');
    } finally {
      setUploadingPhoto(false);
    }
  }

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-foreground">WhatsApp Business Profile</CardTitle>
            <CardDescription className="text-muted-foreground">
              The photo, about, and bio your contacts see on this WhatsApp number —
              synced directly with Meta.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={loading}
            className="border-border bg-transparent text-foreground hover:bg-muted shrink-0"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync Profile
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading && !profile ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : loadError ? (
          <p className="text-sm text-red-400">{loadError}</p>
        ) : (
          <>
            {/* Photo */}
            <div className="flex flex-wrap items-center gap-4">
              <Avatar size="lg" className="size-16">
                {profile?.profile_picture_url ? (
                  <AvatarImage src={profile.profile_picture_url} alt="Business profile photo" />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-primary">
                  <Building2 className="size-6" />
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={onPickPhoto}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPhoto}
                  className="border-border text-foreground hover:bg-muted w-fit"
                >
                  {uploadingPhoto ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  {profile?.profile_picture_url ? 'Change photo' : 'Upload photo'}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Square JPEG or PNG, up to 5 MB.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">About</Label>
                <Input
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  maxLength={139}
                  placeholder="A short line shown next to your number"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={128}
                  placeholder="support@yourbusiness.com"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Address</Label>
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  maxLength={256}
                  placeholder="Business address"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Category</Label>
                <Select value={vertical} onValueChange={(v) => setVertical(v ?? 'UNDEFINED')}>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: string) => VERTICAL_LABEL[v] ?? v}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {VERTICAL_OPTIONS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {VERTICAL_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Website 1</Label>
                <Input
                  value={website1}
                  onChange={(e) => setWebsite1(e.target.value)}
                  placeholder="https://yourbusiness.com"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Website 2</Label>
                <Input
                  value={website2}
                  onChange={(e) => setWebsite2(e.target.value)}
                  placeholder="https://yourbusiness.com/shop"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={512}
                rows={3}
                placeholder="Tell customers what your business does"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="size-4" />
                    Save Profile
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
