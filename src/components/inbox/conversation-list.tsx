"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation, ConversationStatus, LifecycleStage, Tag } from "@/types";
import { Search, ChevronDown, X, Bot, User, CircleDashed } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Conversation lists grow unbounded over time (one row per contact who has
// ever messaged in), so the initial/resync fetch only pulls the most
// recent page — loading every conversation an account has ever had would
// slow inbox-open more and more as history accumulates (the whole point
// of this fix). Older conversations are reached via "Load more", a
// straightforward last_message_at cursor rather than OFFSET: this list's
// sort key changes constantly (any new message bumps a conversation back
// to the top), and OFFSET pagination silently skips/duplicates rows when
// the ordering shifts under it between page fetches.
const PAGE_SIZE = 50;

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  /**
   * Called with a batch of freshly-fetched conversation rows — the first
   * page (mount / resync) or a subsequent "Load more" page. The parent
   * merges the batch into its `conversations` state by id rather than
   * replacing it wholesale, so a resync-triggered refetch of page 1
   * doesn't discard older pages the user already loaded.
   */
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   * Always refetches page 1 — a missed event is by definition recent, so
   * older loaded pages don't need to be re-verified.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

type InboxFilter = ConversationStatus | "all" | "unread";

// "Closed" used to be one more option in this dropdown, mixed in with
// open/pending conversations. Closed conversations are a different kind
// of thing (done, archived) from open/pending (needs attention), so they
// now get their own top-level section — this dropdown only ever narrows
// within the active section.
const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Open", value: "open" },
  { label: "Pending", value: "pending" },
];

type InboxSection = "active" | "closed" | "archived";

// Who owns the conversation, orthogonal to Active/Closed — "Mine" is
// scoped to the logged-in agent's own assignments, "Unassigned" surfaces
// what nobody (human or AI) has picked up yet. Mirrors respond.io's
// All/Mine/Unassigned sidebar split.
type OwnerFilter = "all" | "mine" | "unassigned";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [section, setSection] = useState<InboxSection>("active");
  // Closed/Archived get their own dedicated, correctly-scoped fetch
  // rather than reusing the `conversations` prop (the parent's
  // top-PAGE_SIZE-by-recent-activity page, merged incrementally via
  // "Load more"). A closed or archived conversation is, by definition,
  // usually stale — exactly the kind of row least likely to survive
  // into that "most recently active" window — so filtering only the
  // already-loaded page (the old behavior) routinely showed "no
  // conversations" for these tabs even when matching rows existed.
  // Scoped locally here rather than touching the parent/realtime
  // pipeline that the Active section still relies on unchanged.
  const [sectionRows, setSectionRows] = useState<Conversation[]>([]);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [closedCountAccurate, setClosedCountAccurate] = useState(0);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Lifecycle stage — a single, exclusive filter (a contact has at most
  // one stage), unlike tags which are OR-combinable. This is the literal
  // match for respond.io's sidebar ("New Lead 123", "Hot Lead 2", ...),
  // which surfaces stages, not colour tags, despite both being loosely
  // called "tags" in casual conversation.
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  // Cursor for "Load more" — the oldest `last_message_at` seen so far.
  // Kept in a ref (not state) since it's only read inside the load-more
  // callback, never rendered.
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false })
        .limit(PAGE_SIZE);

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      const rows = data ?? [];
      // A full page suggests there may be more; a short page is the
      // definitive end of the list. This can occasionally under-report
      // (exactly PAGE_SIZE remaining rows shows one harmless extra
      // "Load more" click that then reports no more) but never loses data.
      cursorRef.current =
        rows.length > 0
          ? (rows[rows.length - 1] as { last_message_at: string | null })
              .last_message_at
          : null;
      setHasMore(rows.length === PAGE_SIZE);

      onConversationsLoadedRef.current(normalizeConversations(rows));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
    // Resets pagination to page 1 — a resync is about catching up on
    // recent events, not re-verifying pages the user already scrolled to.
  }, [resyncToken]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const supabase = createClient();
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false })
        .limit(PAGE_SIZE);
      // No cursor (all loaded rows had a null last_message_at, which
      // shouldn't happen in practice) — nothing further to page into.
      if (cursorRef.current) {
        query = query.lt("last_message_at", cursorRef.current);
      } else {
        setHasMore(false);
        return;
      }
      const { data, error } = await query;
      if (error) {
        console.error("Failed to load more conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      const rows = data ?? [];
      cursorRef.current =
        rows.length > 0
          ? (rows[rows.length - 1] as { last_message_at: string | null })
              .last_message_at
          : cursorRef.current;
      setHasMore(rows.length === PAGE_SIZE);
      onConversationsLoadedRef.current(normalizeConversations(rows));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore]);

  // Auto-loads older pages as the list scrolls near its end, instead of
  // requiring an explicit "Load older conversations" click every 50 rows
  // — at real scale (a few hundred conversations) that read as "most of
  // my chats are just missing" since nothing suggested more existed below
  // the fold. loadMore() is already guarded against overlapping/redundant
  // calls (see its own loadingMore/hasMore check above), so it's safe to
  // fire this on every intersection without extra debouncing here.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    // Base UI's ScrollArea scrolls its own Viewport div, not the document
    // — an IntersectionObserver with the default root (the document
    // viewport) never reports this sentinel as intersecting no matter how
    // far the list is scrolled, since it's clipped by that inner
    // scrollable ancestor rather than the page. Root must be that actual
    // scrolling element for the observer to fire at all.
    const root = scrollContainerRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { root, rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lifecycle stage definitions for the sidebar — same "load once, keep
  // stable" reasoning as tags above.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("lifecycle_stages")
        .select("*")
        .order("position", { ascending: true });
      if (!cancelled && data) setStages(data as LifecycleStage[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  // Closed and Archived read from their own dedicated fetch (sectionRows)
  // rather than re-filtering the Active section's paginated `conversations`
  // prop — a closed or archived conversation is by definition usually
  // stale, exactly the kind of row least likely to survive into that
  // "most recently active" page, so filtering only the loaded page
  // routinely showed "no conversations" for these tabs even when
  // matching rows existed. Active also now excludes archived_at, which
  // nothing previously did — an archived conversation used to keep
  // showing in the normal Active list forever.
  useEffect(() => {
    if (section === "active") return;
    let cancelled = false;
    (async () => {
      setSectionLoading(true);
      const supabase = createClient();
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order(section === "archived" ? "archived_at" : "last_message_at", {
          ascending: false,
        })
        .limit(PAGE_SIZE);
      query =
        section === "archived"
          ? query.not("archived_at", "is", null)
          : query.eq("status", "closed").is("archived_at", null);
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch section conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setSectionRows([]);
      } else {
        setSectionRows(normalizeConversations(data ?? []));
      }
      setSectionLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [section]);

  // Tab badge counts — a real count query rather than "however many
  // happen to be in the loaded page", for the same reason as above.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [{ count: archived }, { count: closed }] = await Promise.all([
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .not("archived_at", "is", null),
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("status", "closed")
          .is("archived_at", null),
      ]);
      if (cancelled) return;
      setArchivedCount(archived ?? 0);
      setClosedCountAccurate(closed ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  const sectioned = useMemo(() => {
    if (section === "closed" || section === "archived") return sectionRows;
    return conversations.filter((c) => c.status !== "closed" && !c.archived_at);
  }, [conversations, section, sectionRows]);

  const activeCount = useMemo(
    () => conversations.filter((c) => c.status !== "closed" && !c.archived_at).length,
    [conversations]
  );

  // Mine/Unassigned counts are scoped to the current section (Active or
  // Closed) so the number next to each pill matches what clicking it
  // would actually show, not a total across both sections.
  const mineCount = useMemo(
    () => sectioned.filter((c) => !!user && c.assigned_agent_id === user.id).length,
    [sectioned, user]
  );
  const unassignedCount = useMemo(
    () => sectioned.filter((c) => c.owner_kind === "unassigned").length,
    [sectioned]
  );

  const filtered = useMemo(() => {
    let result = sectioned;

    // The status/unread sub-filter only makes sense within the active
    // section — every row in the closed section already has
    // status === "closed", so applying it there would just re-filter to
    // the same set (or, for "open"/"pending", to nothing).
    if (section === "active") {
      if (filter === "unread") {
        result = result.filter((c) => c.unread_count > 0);
      } else if (filter !== "all") {
        result = result.filter((c) => c.status === filter);
      }
    }

    if (ownerFilter === "mine") {
      result = result.filter((c) => !!user && c.assigned_agent_id === user.id);
    } else if (ownerFilter === "unassigned") {
      result = result.filter((c) => c.owner_kind === "unassigned");
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (selectedStageId !== null) {
      result = result.filter(
        (c) => c.contact?.lifecycle_stage_id === selectedStageId
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [sectioned, section, filter, ownerFilter, user, search, selectedTagIds, selectedCompany, selectedStageId]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Active / Closed sections. Closed conversations are done/archived,
          so they live in their own tab rather than mixed into the same
          list as open/pending ones. */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setSection("active")}
          className={cn(
            "flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            section === "active"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Active
          {activeCount > 0 && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {activeCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setSection("closed")}
          className={cn(
            "flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            section === "closed"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Closed
          {closedCountAccurate > 0 && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {closedCountAccurate}
            </span>
          )}
        </button>
        <button
          onClick={() => setSection("archived")}
          className={cn(
            "flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            section === "archived"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Archived
          {archivedCount > 0 && (
            <span className="ml-1.5 text-xs text-muted-foreground">
              {archivedCount}
            </span>
          )}
        </button>
      </div>

      {/* Owner quick filters — All / Mine / Unassigned, orthogonal to
          Active/Closed above. Mirrors respond.io's sidebar split so an
          agent can jump straight to their own queue or to what nobody
          has picked up yet. */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <button
          onClick={() => setOwnerFilter("all")}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            ownerFilter === "all"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          All
        </button>
        <button
          onClick={() => setOwnerFilter("mine")}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            ownerFilter === "mine"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <User className="size-3" />
          Mine
          {mineCount > 0 && (
            <span className="text-[10px] opacity-80">{mineCount}</span>
          )}
        </button>
        <button
          onClick={() => setOwnerFilter("unassigned")}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            ownerFilter === "unassigned"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <CircleDashed className="size-3" />
          Unassigned
          {unassignedCount > 0 && (
            <span className="text-[10px] opacity-80">{unassignedCount}</span>
          )}
        </button>
      </div>

      {/* Lifecycle stage — the literal match for respond.io's sidebar
          ("New Lead 123", "Hot Lead 2", "Customer", ...): a contact has
          exactly one stage, so this list is naturally exclusive. Rendered
          as wrapped chips rather than full-width rows — the selected chip
          fills solid with the stage's own colour (not a generic accent
          tint) so the active filter reads at a glance. */}
      {stages.length > 0 && (
        <div className="space-y-1.5 border-b border-border px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Stage
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedStageId(null)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                selectedStageId === null
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              )}
            >
              All
              <span className="ml-1 opacity-80">{sectioned.length}</span>
            </button>
            {stages.map((stage) => {
              const isSelected = selectedStageId === stage.id;
              const count = sectioned.filter(
                (c) => c.contact?.lifecycle_stage_id === stage.id
              ).length;
              return (
                <button
                  key={stage.id}
                  onClick={() =>
                    setSelectedStageId(isSelected ? null : stage.id)
                  }
                  style={
                    isSelected
                      ? { backgroundColor: stage.color, color: "#fff" }
                      : undefined
                  }
                  className={cn(
                    "inline-flex max-w-40 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                    !isSelected &&
                      "bg-muted text-muted-foreground hover:text-foreground"
                  )}
                >
                  {!isSelected && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                  )}
                  <span className="truncate">{stage.name}</span>
                  <span className="shrink-0 opacity-80">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tags — same wrapped-chip treatment as Stage above, each chip
          exclusively selecting that one tag. Deliberately single-select
          and separate from the multi-select Tags dropdown further down
          (which stays for OR-combining several tags) — most agents just
          want "show me the New Lead queue," not a filter builder. */}
      {tags.length > 0 && (
        <div className="space-y-1.5 border-b border-border px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tags
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedTagIds([])}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                selectedTagIds.length === 0
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              )}
            >
              All
              <span className="ml-1 opacity-80">{sectioned.length}</span>
            </button>
            {tags.map((t) => {
              const isSelected =
                selectedTagIds.length === 1 && selectedTagIds[0] === t.id;
              const count = sectioned.filter((c) =>
                matchesContactFilters(c, { tagIds: [t.id], company: null })
              ).length;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTagIds(isSelected ? [] : [t.id])}
                  style={
                    isSelected
                      ? { backgroundColor: t.color, color: "#fff" }
                      : undefined
                  }
                  className={cn(
                    "inline-flex max-w-40 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                    !isSelected &&
                      "bg-muted text-muted-foreground hover:text-foreground"
                  )}
                >
                  {!isSelected && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color }}
                    />
                  )}
                  <span className="truncate">{t.name}</span>
                  <span className="shrink-0 opacity-80">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Search conversations..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {/* Open/Pending/Unread only make sense within the active
              section — every closed-section row already has
              status === "closed". */}
          {section === "active" && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                  {activeFilter?.label ?? "All"}
                  <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover"
              >
                {FILTER_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => setFilter(opt.value)}
                    className={cn(
                      "text-sm",
                      filter === opt.value
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Company"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  All companies
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Tag"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <div ref={scrollContainerRef} className="contents">
        <ScrollArea className="min-h-0 flex-1">
          {loading || (section !== "active" && sectionLoading) ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                {ownerFilter === "mine"
                  ? "No conversations assigned to you"
                  : ownerFilter === "unassigned"
                    ? "Nothing unassigned right now"
                    : section === "closed"
                      ? "No closed conversations"
                      : section === "archived"
                        ? "No archived conversations"
                        : "No conversations found"}
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border/50">
              {filtered.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isActive={conv.id === activeConversationId}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          )}
          {/* Only the most recent PAGE_SIZE conversations load up front
              (issue: unbounded inbox load time as history accumulates).
              Older pages auto-load as this sentinel scrolls into view (see
              the IntersectionObserver effect above); the button underneath
              is a visible fallback for the brief moment before that fires,
              and while a page is in flight. */}
          {/* This pagination (cursor + IntersectionObserver) is wired to
              the Active section's parent-fed `conversations` prop only —
              Closed/Archived load their own single dedicated page above
              instead, so showing this here would silently page through
              Active rows while looking at a different section. */}
          {section === "active" && !loading && hasMore && (
            <div ref={sentinelRef} className="p-3">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full border-border text-muted-foreground hover:bg-muted"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Loading…
                  </>
                ) : (
                  "Load older conversations"
                )}
              </Button>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Unknown";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  const isUnread = conversation.unread_count > 0;

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70",
        isUnread && !isActive && "bg-muted/25"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm text-foreground",
                isUnread ? "font-semibold" : "font-medium"
              )}
            >
              {displayName}
            </span>
            {/* AI-owned badge — the same signal the thread header's
                assign-dropdown trigger shows, surfaced here so an agent
                can spot AI-handled threads without opening each one. */}
            {conversation.owner_kind === "ai" && (
              <span
                title="AI agent is handling this conversation"
                className="flex shrink-0 items-center justify-center rounded-full bg-primary/10 p-0.5 text-primary"
              >
                <Bot className="size-3" />
              </span>
            )}
          </span>
          <span
            className={cn(
              "shrink-0 text-[10px]",
              isUnread ? "font-medium text-primary" : "text-muted-foreground"
            )}
          >
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-xs",
              isUnread ? "text-foreground/80" : "text-muted-foreground"
            )}
          >
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {isUnread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
