"use client";

import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { templateHeaderKind } from "@/lib/media/gallery";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /** Who sent an outbound message ("Neha", "Bot"), shown by the time. */
  senderLabel?: string | null;
  /** Briefly ring the bubble after a jump-to-message from search. */
  highlighted?: boolean;
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  // WhatsApp's ticks: grey ✓ sent, grey ✓✓ delivered, blue ✓✓ read.
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-[var(--wa-meta)]" />;
    case "sent":
      return <Check className="h-3.5 w-3.5 text-[var(--wa-meta)]" />;
    case "delivered":
      return <CheckCheck className="h-3.5 w-3.5 text-[var(--wa-meta)]" />;
    case "read":
      return <CheckCheck className="h-3.5 w-3.5 text-[var(--wa-read)]" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3.5 w-3.5 text-red-500" />
        </span>
      );
    default:
      return null;
  }
}

/** A template's image / video / document header, above its body. */
function TemplateHeaderMedia({
  message,
  onOpen,
  t,
}: {
  message: Message;
  onOpen?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const kind = templateHeaderKind(message.media_url!);
  return (
    <div className="mb-1.5">
      {kind === "video" ? (
        <MediaVideoBubble message={message} onOpen={onOpen} t={t} />
      ) : kind === "document" ? (
        // The body is rendered below — don't repeat it as the file label.
        <MediaDocumentBubble message={{ ...message, content_text: undefined }} t={t} />
      ) : (
        <MediaImageBubble message={message} onOpen={onOpen} t={t} />
      )}
    </div>
  );
}

function MessageContent({
  message,
  t,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  onOpenMedia?: (messageId: string) => void;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case "template":
      // A neutral "Template" chip that reads on both the WhatsApp green
      // (outbound) and white (inbound) fills. Falls back to the
      // template's name when we have no stored body (legacy rows sent
      // before issue #483 was fixed).
      return (
        <div>
          {message.media_url && (
            <TemplateHeaderMedia message={message} onOpen={openMedia} t={t} />
          )}
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              "bg-black/5 text-[var(--wa-meta)] dark:bg-white/10",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          ) : (
            message.template_name && (
              <p className="mt-1 break-words text-sm italic opacity-80">
                {message.template_name}
              </p>
            )
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  senderLabel,
  highlighted,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-lg px-2.5 py-1.5 transition-shadow",
          highlighted && "ring-4 ring-amber-400/70",
          // WhatsApp's own chat colours: light green out, white in.
          "text-[var(--wa-text)] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
          isAgent
            ? "rounded-tr-sm bg-[var(--wa-out)]"
            : "rounded-tl-sm bg-[var(--wa-in)]",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
          />
        )}
        <MessageContent
          message={message}
          t={t}
          onOpenMedia={onOpenMedia}
        />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            "justify-end",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-black/5 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-[var(--wa-meta)] dark:bg-white/10"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className="text-[10px] text-[var(--wa-meta)]"
          >
            {senderLabel ? `${senderLabel} · ` : ""}
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
      </div>
      {failure && (
        <p
          className="mt-0.5 max-w-xs px-1 text-[10.5px] leading-tight text-red-600 dark:text-red-400"
          title={failure}
        >
          <span className="font-semibold">{t("notDelivered")}:</span> {failure}
        </p>
      )}
      {failure && message.error_code === 131049 && (
        // Meta's per-person cap on marketing templates — not a Bluetick
        // fault, so say what the agent can actually do about it.
        <p className="mt-0.5 max-w-xs px-1 text-[10.5px] leading-tight text-[var(--wa-meta)]">
          {t("marketingLimitHint")}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
