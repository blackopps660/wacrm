"use client";

import { useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, SmilePlus, Pin, PinOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Message } from "@/types";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// WhatsApp's own pin-duration choices. Values are hours so the caller can
// compute `pinned_until = now + hours` without a date-math library.
export const PIN_DURATIONS: { label: string; hours: number }[] = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  /** True when this message is currently pinned (pinned_until in the future). */
  isPinned: boolean;
  /** Pin for the given number of hours (from PIN_DURATIONS). */
  onPin: (hours: number) => void;
  onUnpin: () => void;
  /** Hide this message from the account's own inbox view ("Delete for
   *  Me" — WhatsApp gives businesses no way to unsend from the
   *  customer's device, see migration 049). */
  onDelete: () => void;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  isPinned,
  onPin,
  onUnpin,
  onDelete,
  children,
}: MessageActionsProps) {
  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pinMenuOpen, setPinMenuOpen] = useState(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  const handlePin = (hours: number) => {
    onPin(hours);
    setPinMenuOpen(false);
    setTouchOpen(false);
  };

  const handleUnpin = () => {
    onUnpin();
    setTouchOpen(false);
  };

  const handleDelete = () => {
    if (
      window.confirm(
        "Delete this message? It's removed from your team's inbox — the customer keeps it on their own WhatsApp.",
      )
    ) {
      onDelete();
    }
    setTouchOpen(false);
  };

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative min-w-0 max-w-[75%]">
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen || pinMenuOpen ? "true" : undefined}
        className={cn(
          "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          isAgent ? "right-3" : "left-3",
        )}
      >
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
            aria-label="React"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </PopoverTrigger>
          <PopoverContent
            className="flex w-auto flex-row gap-1 p-1.5"
            sideOffset={6}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handlePickEmoji(e)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                aria-label={`React with ${e}`}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={handleReply}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label="Reply"
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {isPinned ? (
          <button
            type="button"
            onClick={handleUnpin}
            className="flex h-5 w-5 items-center justify-center rounded-full text-primary hover:bg-muted"
            aria-label="Unpin"
          >
            <PinOff className="h-3.5 w-3.5" />
          </button>
        ) : (
          <Popover open={pinMenuOpen} onOpenChange={setPinMenuOpen}>
            <PopoverTrigger
              className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
              aria-label="Pin"
            >
              <Pin className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent className="flex w-auto flex-col p-1" sideOffset={6}>
              <span className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Pin for
              </span>
              {PIN_DURATIONS.map((d) => (
                <button
                  key={d.hours}
                  type="button"
                  onClick={() => handlePin(d.hours)}
                  className="rounded px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
                >
                  {d.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
        <button
          type="button"
          onClick={handleDelete}
          className="flex h-5 w-5 items-center justify-center rounded-full text-destructive hover:bg-destructive/10"
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>
    </div>
  );
}
