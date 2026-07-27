"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, Loader2, Lock, LockOpen, Trash2, TriangleAlert } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";

const MAX_NAME_LEN = 80;

/**
 * Workspace name + lock. Both go through PATCH /api/account rather
 * than a direct Supabase write (unlike DealsSettings' default-currency
 * field) because the route also enforces the lock: a rename attempt
 * while locked is rejected server-side (423), so this can't be
 * bypassed by a client that skips the disabled-input UI state.
 */
export function WorkspaceGeneralSettings() {
  const { account, canEditSettings, isOwner, profileLoading, refreshProfile } =
    useAuth();

  const [name, setName] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);

  // Delete-workspace danger zone. Owner-only, and gated behind a
  // type-the-name confirmation so a stray click can't wipe an account's
  // entire history.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          account: { name: string; is_locked: boolean };
        };
        if (!cancelled) {
          setName(data.account.name);
          setIsLocked(data.account.is_locked);
          setLoaded(true);
        }
      } catch (err) {
        console.error("[WorkspaceGeneralSettings] load error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = loaded && name.trim() !== (account?.name ?? "");

  async function handleSaveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LEN) return;
    setSavingName(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to rename workspace");
        return;
      }
      toast.success("Workspace renamed");
      await refreshProfile();
    } catch (err) {
      console.error("[WorkspaceGeneralSettings] rename error:", err);
      toast.error("Could not reach the server");
    } finally {
      setSavingName(false);
    }
  }

  async function handleToggleLock() {
    const next = !isLocked;
    setTogglingLock(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_locked: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to update lock");
        return;
      }
      setIsLocked(next);
      toast.success(next ? "Workspace locked" : "Workspace unlocked");
    } catch (err) {
      console.error("[WorkspaceGeneralSettings] lock toggle error:", err);
      toast.error("Could not reach the server");
    } finally {
      setTogglingLock(false);
    }
  }

  async function handleDelete() {
    if (!account) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/workspaces/${account.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to delete workspace");
        setDeleting(false);
        return;
      }
      // Hard reload into the workspace the server switched us to — same
      // pattern as workspace-switcher, so every account-scoped hook and
      // query re-fetches against the new active workspace cleanly.
      toast.success("Workspace deleted");
      window.location.href = "/dashboard";
    } catch (err) {
      console.error("[WorkspaceGeneralSettings] delete error:", err);
      toast.error("Could not reach the server");
      setDeleting(false);
    }
  }

  const confirmMatches = confirmName.trim() === (account?.name ?? "").trim();

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Workspace"
        description="This workspace's name, and whether it's locked against accidental changes."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Building2 className="size-4 text-primary" />
            Workspace name
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Shown across the app — sidebar, workspace switcher, and invites.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-sm">
            <Label className="text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_NAME_LEN}
              disabled={!canEditSettings || !loaded || isLocked}
              className="bg-muted border-border text-foreground"
            />
            {isLocked ? (
              <p className="text-xs text-amber-400">
                Workspace is locked — unlock it below before renaming.
              </p>
            ) : !canEditSettings ? (
              <p className="text-xs text-muted-foreground">
                Only account admins can rename the workspace.
              </p>
            ) : null}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSaveName}
              disabled={savingName || !dirty || isLocked || profileLoading}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingName ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            {isLocked ? (
              <Lock className="size-4 text-amber-400" />
            ) : (
              <LockOpen className="size-4 text-primary" />
            )}
            {isLocked ? "Locked" : "Unlocked"}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Locking only protects the workspace name above from accidental
            edits — messaging, contacts, and every other feature keep
            working normally while locked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEditSettings ? (
            <Button
              variant="outline"
              onClick={handleToggleLock}
              disabled={togglingLock || !loaded}
              className="border-border text-foreground hover:bg-muted"
            >
              {togglingLock ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isLocked ? (
                <LockOpen className="size-4" />
              ) : (
                <Lock className="size-4" />
              )}
              {isLocked ? "Unlock workspace" : "Lock workspace"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only account admins can lock or unlock the workspace.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Danger zone — owner-only. Deleting a workspace cascade-wipes
       *  every contact, conversation, message and setting under it and
       *  cannot be undone, so it lives behind a type-the-name confirm. */}
      {isOwner && (
        <Card className="mt-6 border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="size-4" />
              Delete workspace
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Permanently deletes this workspace and everything in it —
              contacts, conversations, messages, templates and settings.
              This cannot be undone. You&apos;ll be switched to another
              workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmName("");
                setDeleteOpen(true);
              }}
              disabled={!loaded}
              className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Delete this workspace
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="size-4" />
              Delete “{account?.name}”?
            </DialogTitle>
            <DialogDescription>
              This wipes all of this workspace&apos;s data permanently and
              cannot be undone. Type the workspace name to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">
              Workspace name
            </Label>
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={account?.name ?? ""}
              autoFocus
              className="bg-muted border-border text-foreground"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={!confirmMatches || deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Delete workspace
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
