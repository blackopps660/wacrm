"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, TimerReset, MessageSquareReply } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import type { MessageTemplate } from "@/types";

/**
 * Inbox settings — per-workspace auto-close.
 *
 * `accounts.auto_close_after_days` (migration 037) is NULL by default,
 * meaning auto-close is off until an admin opts in here. The sweep
 * itself runs out-of-band (GET /api/conversations/cron, migration 038);
 * this panel only edits the threshold that sweep reads.
 */
export function InboxSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(3);

  // Quick re-engage — which Approved template the expired-session banner
  // sends with one click. Loaded alongside auto-close since both live on
  // the same accounts row; saved independently below since it has its
  // own "no templates yet" empty state to handle.
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [reengageTemplateId, setReengageTemplateId] = useState<string | null>(null);
  const [savingReengage, setSavingReengage] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data, error }, { data: templateRows }] = await Promise.all([
        supabase
          .from("accounts")
          .select("auto_close_after_days, default_reengagement_template_id")
          .eq("id", accountId)
          .maybeSingle(),
        supabase
          .from("message_templates")
          .select("*")
          .eq("account_id", accountId)
          .eq("status", "APPROVED")
          .order("name"),
      ]);
      if (cancelled) return;
      if (error) {
        toast.error("Failed to load inbox settings");
        setLoading(false);
        return;
      }
      const value = data?.auto_close_after_days as number | null | undefined;
      setEnabled(value != null);
      if (value != null) setDays(value);
      setReengageTemplateId(
        (data?.default_reengagement_template_id as string | null) ?? null,
      );
      setTemplates((templateRows as MessageTemplate[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  const disabled = !canEditSettings || saving || loading;

  const handleSaveReengageTemplate = async (value: string | null) => {
    if (!accountId) return;
    setReengageTemplateId(value);
    setSavingReengage(true);
    const { error } = await supabase
      .from("accounts")
      .update({ default_reengagement_template_id: value })
      .eq("id", accountId);
    setSavingReengage(false);
    if (error) {
      toast.error("Failed to save quick re-engage template");
      return;
    }
    toast.success(value ? "Quick re-engage template set" : "Quick re-engage turned off");
  };

  const handleSave = async () => {
    if (!accountId) return;
    if (enabled && (!Number.isFinite(days) || days < 1)) {
      toast.error("Enter a number of days of 1 or more.");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ auto_close_after_days: enabled ? Math.floor(days) : null })
      .eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error("Failed to save inbox settings");
      return;
    }
    toast.success("Inbox settings saved");
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="Inbox"
        description="Automatically close conversations that have gone quiet, so the active list only shows what still needs attention."
      />

      {!canEditSettings && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins and owners can change inbox settings.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TimerReset className="h-4 w-4 text-primary" /> Auto-close inactive
            conversations
          </CardTitle>
          <CardDescription>
            When on, an open or pending conversation with no new messages for
            this many days is moved to Closed automatically. If the contact
            messages in again, it reopens and is routed like any new
            conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                Auto-close after inactivity
              </p>
              <p className="text-xs text-muted-foreground">
                Off by default — every workspace opts in separately.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="auto-close-days">Days of inactivity</Label>
              <p className="text-xs text-muted-foreground">
                Measured from the conversation&apos;s last message.
              </p>
            </div>
            <Input
              id="auto-close-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) =>
                setDays(Math.min(365, Math.max(1, Number(e.target.value) || 1)))
              }
              disabled={disabled || !enabled}
              className="w-20"
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={disabled}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareReply className="h-4 w-4 text-primary" /> Quick
            re-engage
          </CardTitle>
          <CardDescription>
            When a conversation&apos;s 24-hour window has expired, the inbox
            composer normally requires picking a template every time. Set one
            Approved template here to send it in a single click instead —
            useful for a plain check-in that only needs the contact&apos;s
            name, if it uses a variable at all.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {templates.length === 0 ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              No Approved templates yet — create one under Settings →
              Templates first.
            </p>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>Template</Label>
                <p className="text-xs text-muted-foreground">
                  Off sends nobody a template automatically — the composer
                  falls back to the full picker.
                </p>
              </div>
              <Select
                value={reengageTemplateId ?? "__none__"}
                onValueChange={(v) =>
                  handleSaveReengageTemplate(v === "__none__" ? null : v)
                }
                disabled={!canEditSettings || savingReengage}
              >
                <SelectTrigger className="w-56 bg-muted">
                  {/* Select.Value renders the raw stored value (a
                      template UUID here) by default — its function-
                      children form didn't get invoked in practice
                      (confirmed live: the DOM showed the bare id
                      regardless), so the label is computed directly
                      here instead of relying on that mechanism. */}
                  <SelectValue placeholder="Off">
                    {reengageTemplateId
                      ? (templates.find((t) => t.id === reengageTemplateId)?.name ?? "Off")
                      : "Off"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Off</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
