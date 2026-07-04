"use client";

// ============================================================
// WorkspaceSwitcher
//
// Lets the caller move between every workspace they belong to
// (account_memberships, migration 031) and spin up a new one. Sits
// in the sidebar, above the user menu.
//
// Switching / creating both end in a hard reload (window.location,
// not router.push) — same pattern as sign-out and invite-redeem
// elsewhere in this app. A workspace switch changes profiles.
// account_id, which every RLS policy and every hook (useAuth,
// per-page data fetches) reads fresh on load; a soft navigation
// would leave a dozen components holding stale account-scoped data
// mid-flight. A full reload is the simple, robust choice here.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  Check,
  ChevronsUpDown,
  Loader2,
  Plus,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MAX_NAME_LEN = 80;

export function WorkspaceSwitcher() {
  const { account, accountRole } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Fetch-on-mount only — a switch or create both end in a full page
  // reload (see handleSwitch / CreateWorkspaceDialog below), so this
  // never needs to re-run mid-session. Wrapped in an async IIFE
  // (matching the pattern in join/[token]/page.tsx) rather than an
  // effect-scoped named callback, plus a `cancelled` flag so a
  // fast unmount can't setState on a gone component.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/workspaces", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { workspaces: Workspace[] };
        if (!cancelled) setWorkspaces(data.workspaces);
      } catch (err) {
        console.error("[WorkspaceSwitcher] load error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSwitch = useCallback(async (workspace: Workspace) => {
    if (workspace.isCurrent) return;
    setSwitchingId(workspace.id);
    try {
      const res = await fetch("/api/account/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: workspace.id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || "Failed to switch workspace");
        setSwitchingId(null);
        return;
      }
      // Full reload so every account-scoped hook/query re-fetches
      // under the new workspace.
      window.location.href = "/dashboard";
    } catch (err) {
      console.error("[WorkspaceSwitcher] switch error:", err);
      toast.error("Could not reach the server");
      setSwitchingId(null);
    }
  }, []);

  // Only single workspaces so far can't be told apart visually, so
  // skip the "Nothing to switch to yet" empty state — the trigger
  // still shows the current workspace name and Create is always
  // available.
  const hasMultiple = (workspaces?.length ?? 0) > 1;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="mb-2 flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70"
          aria-label="Switch workspace"
        >
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {account?.name ?? "Loading…"}
            </p>
            {accountRole ? (
              <p className="truncate text-[11px] capitalize text-muted-foreground">
                {accountRole}
              </p>
            ) : null}
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="min-w-64 bg-popover text-popover-foreground ring-border"
        >
          {hasMultiple ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
                {workspaces?.map((ws) => (
                  <DropdownMenuItem
                    key={ws.id}
                    onClick={() => handleSwitch(ws)}
                    disabled={switchingId !== null}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center",
                      )}
                    >
                      {switchingId === ws.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : ws.isCurrent ? (
                        <Check className="size-3.5" />
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{ws.name}</p>
                    </div>
                    <span className="shrink-0 text-[10px] capitalize text-muted-foreground">
                      {ws.role}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-border" />
            </>
          ) : null}
          <DropdownMenuItem
            onClick={() => setCreateOpen(true)}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <Plus className="size-4" />
            Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error("Workspace name is required");
      return;
    }
    if (trimmed.length > MAX_NAME_LEN) {
      toast.error(`Workspace name must be ${MAX_NAME_LEN} characters or fewer`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || "Failed to create workspace");
        setSubmitting(false);
        return;
      }
      // create_workspace() already switches the caller's active
      // pointer to the new workspace — reload lands them there.
      window.location.href = "/dashboard";
    } catch (err) {
      console.error("[CreateWorkspaceDialog] create error:", err);
      toast.error("Could not reach the server");
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
          setSubmitting(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Create a workspace
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A new, fully isolated workspace with its own contacts, inbox,
            and WhatsApp number. You&apos;ll be its owner and switched into
            it right away.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label className="text-muted-foreground">Workspace name</Label>
          <Input
            autoFocus
            placeholder="e.g. Acme Retail"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LEN}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) handleCreate();
            }}
          />
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create workspace"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
