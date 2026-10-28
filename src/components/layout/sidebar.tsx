"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import {
  BarChart3,
  Bell,
  Bot,
  FileSpreadsheet,
  LineChart,
  CalendarClock,
  ChevronDown,
  Crown,
  FileText,
  Megaphone,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: "roleOwner",
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    labelKey: "roleAdmin",
    // Primary-tinted: significant but not as scarce as owner.
    className:
      "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    labelKey: "roleAgent",
    // Neutral slate: the operational default.
    className:
      "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    labelKey: "roleViewer",
    // Muted slate: read-only role; visually quieter than agent.
    className:
      "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

interface NavGroup {
  groupKey: string;
  icon: typeof LayoutDashboard;
  children: NavItem[];
}

type NavEntry = NavItem | NavGroup;

// Ordering: inbox first, then everything about reaching
// customers grouped under "Campaigns". Every route that existed before
// is still here (Contacts lives on as "Customers" at /contacts).
const navEntries: NavEntry[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
  {
    groupKey: "campaigns",
    icon: Megaphone,
    children: [
      { href: "/contacts", labelKey: "customers", icon: Users },
      { href: "/templates", labelKey: "templates", icon: FileText },
      { href: "/broadcasts", labelKey: "broadcasts", icon: Radio },
      { href: "/broadcasts/scheduled", labelKey: "scheduledBroadcasts", icon: CalendarClock },
      // Meta Ads (/ads) is hidden — see ADS_DASHBOARD_ENABLED.
    ],
  },
  {
    // Insights (Analytics + Reports). Enterprise analytics from the
    // reference is not listed: nothing behind it exists.
    groupKey: "insights",
    icon: BarChart3,
    children: [
      { href: "/analytics", labelKey: "analytics", icon: LineChart },
      { href: "/reports", labelKey: "reports", icon: FileSpreadsheet },
    ],
  },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch },
  // Automations live inside Flows now (one Flow, migration 048); the
  // old /automations page stays reachable from the Flows page.
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
  { href: "/agents", labelKey: "aiAgents", icon: Bot },
];

const allNavHrefs = navEntries.flatMap((e) =>
  "children" in e ? e.children.map((c) => c.href) : [e.href],
);

/**
 * The most specific nav href that contains `pathname`, so
 * /broadcasts/scheduled lights up "Scheduled Broadcasts" and not
 * "Broadcasts" too, while /broadcasts/123 still lights up "Broadcasts".
 */
/** Pages without their own entry that belong under another one. */
const NAV_ALIASES: Record<string, string> = {
  // Automations live inside Flows (migration 048); the archive page
  // is reached from the Flows page and lights Flows up.
  "/automations": "/flows",
};

export function activeNavHref(pathname: string, hrefs: string[] = allNavHrefs): string | null {
  for (const [from, to] of Object.entries(NAV_ALIASES)) {
    if ((pathname === from || pathname.startsWith(from + "/")) && hrefs.includes(to)) return to;
  }
  let best: string | null = null;
  for (const href of hrefs) {
    const hit =
      pathname === href ||
      (href !== "/dashboard" && pathname.startsWith(href + "/"));
    if (hit && (!best || href.length > best.length)) best = href;
  }
  return best;
}

// Per-group open state, remembered per browser. Campaigns keeps its
// original key so existing preferences survive.
const groupOpenKey = (group: string) => (group === "campaigns" ? "bluetick.nav.campaignsOpen" : `bluetick.nav.${group}Open`);

const bottomNavItems = [
  { href: "/settings", labelKey: "settings", icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

import { useTranslations } from "next-intl";

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Desktop: the nav is a narrow icon rail by default on every page and
  // slides open OVER the content while hovered (or keyboard-focused), so
  // pages keep their full width. The account menu keeps it open while its
  // popup is showing. Mobile keeps the slide-in drawer.
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expand = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setHovered(true);
  }, []);
  const collapse = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    // Short grace period so brushing past the edge doesn't flicker.
    closeTimer.current = setTimeout(() => setHovered(false), 150);
  }, []);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  const rail = !hovered && !menuOpen;
  const railHide = rail ? "lg:hidden" : "";
  const activeHref = activeNavHref(pathname);

  // Nav groups open/closed, remembered per browser. Default open.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const closed = new Set<string>();
      for (const e of navEntries) {
        if ("children" in e && localStorage.getItem(groupOpenKey(e.groupKey)) === "0") closed.add(e.groupKey);
      }
      if (closed.size) setClosedGroups(closed);
    } catch {
      // Storage blocked — keep the default.
    }
  }, []);
  const toggleGroup = (group: string) => {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      const nowClosed = !next.has(group);
      if (nowClosed) next.add(group);
      else next.delete(group);
      try {
        localStorage.setItem(groupOpenKey(group), nowClosed ? "0" : "1");
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Navigating from the expanded rail collapses it again.
    setHovered(false);
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const renderItem = (item: NavItem, nested: boolean) => {
              const isActive = activeHref === item.href;

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={rail ? t(item.labelKey as string) : undefined}
                    aria-label={rail ? t(item.labelKey as string) : undefined}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      rail && "lg:justify-center lg:px-0 lg:py-2.5",
                      nested && !rail && "pl-9",
                      nested && "lg:py-1.5",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className={cn("flex-1", railHide)}>{t(item.labelKey as string)}</span>
                    {item.beta && (
                      <span
                        aria-label={t("beta")}
                        className={cn(railHide, "rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300")}
                      >
                        {t("beta")}
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={t("unreadConversations", { count: totalUnread })}
                        className={cn("relative flex h-2 w-2", rail && "lg:absolute lg:top-1.5 lg:right-2.5")}
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={t("unreadNotifications", { count: unreadNotifications })}
                        className={cn(rail && "lg:absolute lg:-top-0.5 lg:right-0.5 lg:h-4 lg:min-w-4", "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground")}
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                  </Link>
                </li>
              );
              };

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      {/* Desktop spacer: reserves the collapsed rail's width in the page
          layout; the real panel below floats over content when expanded. */}
      <div aria-hidden className="hidden w-[68px] shrink-0 lg:block" />

      <aside
        onMouseEnter={expand}
        onMouseLeave={collapse}
        onFocus={expand}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) collapse();
        }}
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: fixed rail that widens over the page on hover.
          "lg:z-50 lg:translate-x-0 lg:overflow-hidden lg:whitespace-nowrap lg:transition-[width,box-shadow] lg:duration-200",
          rail ? "lg:w-[68px]" : "lg:w-60 lg:shadow-2xl",
        )}
        aria-label={t("primaryNav")}
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className={cn("flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4", rail && "lg:justify-center lg:px-0")}>
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </div>
            <span className={cn("text-sm font-semibold text-foreground", railHide)}>
              {t("title")}
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("closeMenu")}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className={cn("flex-1 overflow-y-auto px-3 py-4", rail && "lg:px-2")}>
          <ul className="flex flex-col gap-1">
            {navEntries.map((entry) => {
              if (!("children" in entry)) return renderItem(entry, false);
              const groupActive = entry.children.some((c) => c.href === activeHref);
              // The rail can't show a collapsed group, so its children are
              // always listed there (as icons, between dividers).
              const showChildren = rail || !closedGroups.has(entry.groupKey) || groupActive;
              return (
                <li key={entry.groupKey} className={cn(rail && "lg:border-y lg:border-border lg:py-1")}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(entry.groupKey)}
                    aria-expanded={showChildren}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      rail && "lg:hidden",
                      groupActive ? "text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <entry.icon className="h-4 w-4" />
                    <span className="flex-1 text-left">{t(entry.groupKey)}</span>
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !showChildren && "-rotate-90")} />
                  </button>
                  {showChildren && (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {entry.children.map((c) => renderItem(c, true))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="my-4 border-t border-border" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={rail ? t(item.labelKey as string) : undefined}
                    aria-label={rail ? t(item.labelKey as string) : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      rail && "lg:justify-center lg:px-0 lg:py-2.5",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className={railHide}>{t(item.labelKey as string)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div className={cn("shrink-0 border-t border-border p-3", rail && "lg:px-2")}>
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div className={cn("mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground", railHide)}>
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_CHIP[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {t(meta.labelKey as string)}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger className={cn(rail && "lg:justify-center lg:px-0", "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60")}>
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className={cn("min-w-0 flex-1", railHide)}>
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t("menuSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
