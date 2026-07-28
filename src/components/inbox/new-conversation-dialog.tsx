"use client";

// Business-initiated conversations: WhatsApp requires an approved
// message template to text someone who hasn't messaged the account
// first (no free-form send outside the 24h customer-service window —
// see template-picker.tsx). This dialog is the UI for that path: pick
// an existing contact or add a new number, then pick+fill a template.
// There is no "is this number on WhatsApp" check available on the
// Cloud API — Meta only tells us by rejecting the send, so that error
// surfaces as a toast from the actual send attempt below.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from "@/lib/contacts/dedupe";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, Search, Check } from "lucide-react";
import {
  TemplatePicker,
  type TemplateSendValues,
} from "@/components/inbox/template-picker";
import type { MessageTemplate } from "@/types";
import { cn } from "@/lib/utils";

interface ContactHit {
  id: string;
  name: string | null;
  phone: string;
}

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (conversationId: string) => void;
}

export function NewConversationDialog({
  open,
  onOpenChange,
  onSent,
}: NewConversationDialogProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactHit | null>(
    null,
  );

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);
  const [checkingDup, setCheckingDup] = useState(false);
  const [creating, setCreating] = useState(false);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [sending, setSending] = useState(false);

  function reset() {
    setMode("existing");
    setSearch("");
    setResults([]);
    setSelectedContact(null);
    setNewName("");
    setNewPhone("");
    setDupMatch(null);
    setTemplateOpen(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  // Search existing contacts by name/phone, debounced. Strip
  // comma/paren so the term can't break PostgREST's `.or()` mini-syntax.
  useEffect(() => {
    if (mode !== "existing" || !open) return;
    const q = search.trim().replace(/[,()]/g, "");
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .order("name", { ascending: true })
        .limit(8);
      setResults((data as ContactHit[]) ?? []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [search, mode, open, supabase]);

  async function checkDuplicate() {
    if (!accountId) return;
    const value = newPhone.trim();
    if (!value) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(supabase, accountId, value);
      setDupMatch(
        existing
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null,
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function proceedToTemplate() {
    if (mode === "existing") {
      if (!selectedContact) return;
      setTemplateOpen(true);
      return;
    }

    // New contact — create it now (mirrors contact-form.tsx's create
    // path) so the template send below has a contact_id to target.
    if (!newPhone.trim()) {
      toast.error("Phone number is required");
      return;
    }
    if (dupMatch?.exact) {
      toast.error("A contact with this phone number already exists");
      return;
    }
    if (!accountId) return;

    setCreating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contacts")
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: newName.trim() || null,
          phone: newPhone.trim(),
        })
        .select("id, name, phone")
        .single();

      if (error) {
        if (isUniqueViolation(error)) {
          toast.error("A contact with this phone number already exists");
          const existing = await findExistingContact(
            supabase,
            accountId,
            newPhone.trim(),
          );
          if (existing) setDupMatch({ contact: existing, exact: true });
          return;
        }
        throw error;
      }

      setSelectedContact(data as ContactHit);
      setTemplateOpen(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create contact";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!selectedContact) return;
    setSending(true);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: selectedContact.id,
          message_type: "template",
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Meta rejects unreachable/non-WhatsApp numbers right here —
        // there's no separate "check if this number has WhatsApp" call.
        toast.error(
          payload?.error ||
            "Failed to send — this number may not be on WhatsApp",
        );
        return;
      }
      toast.success(
        `Message sent to ${selectedContact.name || selectedContact.phone}`,
      );
      if (payload.conversation_id) onSent(payload.conversation_id as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      toast.error(message);
    } finally {
      setSending(false);
    }
  }

  const canProceed =
    mode === "existing"
      ? !!selectedContact
      : !!newPhone.trim() && !dupMatch?.exact;

  return (
    <>
      <Dialog open={open && !templateOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              New message
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              WhatsApp requires an approved template to message someone who
              hasn&apos;t texted you first. Pick or add a contact, then
              choose a template.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-1 rounded-md bg-muted p-1">
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors",
                mode === "existing"
                  ? "bg-popover text-popover-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Existing contact
            </button>
            <button
              type="button"
              onClick={() => setMode("new")}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors",
                mode === "new"
                  ? "bg-popover text-popover-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              New number
            </button>
          </div>

          {mode === "existing" ? (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelectedContact(null);
                  }}
                  placeholder="Search by name or phone..."
                  className="border-border bg-muted pl-9 text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {searching ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  </div>
                ) : results.length === 0 ? (
                  search.trim() && (
                    <p className="py-3 text-center text-xs text-muted-foreground">
                      No contacts match &quot;{search.trim()}&quot;
                    </p>
                  )
                ) : (
                  results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedContact(c)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selectedContact?.id === c.id
                          ? "border-primary/50 bg-primary/10 text-popover-foreground"
                          : "border-border bg-background/50 text-popover-foreground hover:border-primary/30",
                      )}
                    >
                      <span className="truncate">
                        {c.name || (
                          <span className="italic text-muted-foreground">
                            Unnamed
                          </span>
                        )}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      </span>
                      {selectedContact?.id === c.id && (
                        <Check className="h-4 w-4 text-primary" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="John Doe"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Phone <span className="text-red-400">*</span>
                </Label>
                <Input
                  value={newPhone}
                  onChange={(e) => {
                    setNewPhone(e.target.value);
                    if (dupMatch) setDupMatch(null);
                  }}
                  onBlur={checkDuplicate}
                  placeholder="+1 234 567 8900"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                {dupMatch ? (
                  <div
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
                      dupMatch.exact
                        ? "border-red-500/40 bg-red-500/10 text-red-300"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-300",
                    )}
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <p>
                      {dupMatch.exact
                        ? "A contact with this phone number already exists."
                        : "A contact with a very similar number already exists."}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Include country code, e.g. +1 for US
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={proceedToTemplate}
              disabled={!canProceed || creating || checkingDup}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Next: pick template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={open && templateOpen}
        onOpenChange={(next) => {
          setTemplateOpen(next);
          if (!next) handleOpenChange(false);
        }}
        onSelect={handleSendTemplate}
      />

      {sending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/40">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}
    </>
  );
}
