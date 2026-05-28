"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Image as ImageIcon,
  GalleryHorizontalEnd,
  MessageCircle,
  Users,
  UserPlus,
  FolderOpen,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Zap,
  Palette,
  LogOut,
  Briefcase,
  Github,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { clearAuthSessionCache, getValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const adminNavItems = [
  { href: "/chat", label: "聊天", Icon: MessageCircle },
  { href: "/image", label: "画图", Icon: ImageIcon },
  { href: "/gallery", label: "画廊", Icon: GalleryHorizontalEnd },
  { href: "/accounts", label: "号池管理", Icon: Users },
  { href: "/register", label: "注册机", Icon: UserPlus },
  { href: "/register-settings", label: "注册配置", Icon: SlidersHorizontal },
  { href: "/design", label: "设计工具", Icon: Palette },
  { href: "/gateway", label: "API 反代", Icon: Zap },
  { href: "/sentiment", label: "舆情搜索", Icon: Radar },
  { href: "/image-manager", label: "图片管理", Icon: FolderOpen },
  { href: "/logs", label: "日志管理", Icon: ScrollText },
  { href: "/settings", label: "设置", Icon: Settings },
];

const userNavItems = [
  { href: "/chat", label: "聊天", Icon: MessageCircle },
  { href: "/image", label: "画图", Icon: ImageIcon },
  { href: "/gallery", label: "画廊", Icon: GalleryHorizontalEnd },
  { href: "/design", label: "设计工具", Icon: Palette },
  { href: "/works", label: "我的作品", Icon: Briefcase },
];

function normalizePath(value: string) {
  if (!value) return "/";
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
}

export function SideNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("sidebar-collapsed") === "true";
    return false;
  });

  useEffect(() => {
    localStorage.setItem("sidebar-collapsed", String(collapsed));
    // 通知 main 区域调整 margin
    document.documentElement.style.setProperty("--sidebar-width", collapsed ? "64px" : "240px");
  }, [collapsed]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (pathname === "/login") { if (!active) return; setSession(null); return; }
      const storedSession = await getValidatedAuthSession();
      if (!active) return;
      setSession(storedSession);
    };
    void load();
    return () => { active = false; };
  }, [pathname]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    clearAuthSessionCache();
    router.replace("/login");
  };

  if (pathname === "/login" || session === undefined || !session) return null;

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;
  const initial = (displayName[0] || "U").toUpperCase();

  return (
    <aside className={cn(
      "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-white transition-all duration-200",
      collapsed ? "w-16" : "w-60",
    )}>
      {/* Logo */}
      <div className={cn("flex items-center border-b border-border", collapsed ? "justify-center px-2 py-4" : "gap-3 px-5 py-5")}>
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-md">
          <span className="text-[16px] font-extrabold leading-none text-white">G</span>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[14px] font-bold tracking-tight text-foreground leading-tight">ChatGPT2API</div>
            <div className="text-[11px] text-muted-foreground leading-tight">Account Manager</div>
          </div>
        )}
      </div>

      {/* Nav Items */}
      <nav className={cn("flex-1 overflow-y-auto space-y-0.5", collapsed ? "p-2" : "p-3")}>
        {navItems.map((item) => {
          const active = normalizePath(item.href) === normalizePath(pathname || "/");
          const Icon = item.Icon;
          return (
            <Link key={item.href} href={item.href} title={collapsed ? item.label : undefined} className={cn(
              "flex items-center rounded-lg transition-all duration-150",
              collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
              active ? "bg-violet-50 text-violet-700 shadow-sm" : "text-gray-600 hover:bg-gray-50 hover:text-foreground",
            )}>
              <Icon className={cn("shrink-0", collapsed ? "size-5" : "size-[18px]", active ? "text-violet-600" : "text-gray-400")} strokeWidth={active ? 2.5 : 2} />
              {!collapsed && <span className="truncate text-[13.5px] font-medium">{item.label}</span>}
              {!collapsed && active && <span className="ml-auto size-1.5 rounded-full bg-violet-500" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={cn("border-t border-border space-y-2", collapsed ? "p-2" : "p-3")}>
        {/* Collapse toggle */}
        <button type="button" onClick={() => setCollapsed(!collapsed)} className={cn(
          "flex w-full items-center rounded-lg text-muted-foreground transition hover:bg-gray-50 hover:text-foreground cursor-pointer",
          collapsed ? "justify-center p-2.5" : "gap-2 px-3 py-2",
        )} title={collapsed ? "展开菜单" : "收起菜单"}>
          {collapsed ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" /><span className="text-[12px]">收起</span></>}
        </button>

        {!collapsed && (
          <a href="https://github.com/boteSu/aiChatGptAgent" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-muted-foreground transition hover:bg-gray-50 hover:text-foreground">
            <Github className="size-4 shrink-0" /><span>GitHub</span>
          </a>
        )}

        {/* User */}
        <div className={cn("flex items-center rounded-lg bg-gray-50", collapsed ? "justify-center p-2" : "gap-2 px-3 py-2.5")}>
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-white text-[13px] font-bold">{initial}</div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-foreground leading-tight">{displayName}</div>
              <div className="text-[11px] text-muted-foreground leading-tight">{roleLabel}</div>
            </div>
          )}
          {!collapsed && (
            <button type="button" className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition hover:bg-rose-50 hover:text-rose-500" onClick={() => void handleLogout()} title="退出">
              <LogOut className="size-4" />
            </button>
          )}
        </div>

        {/* Status */}
        <div className={cn("flex items-center gap-2", collapsed ? "justify-center py-1.5" : "px-3 py-1.5")}>
          <span className="relative flex size-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" /></span>
          {!collapsed && <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">已连接</span>}
        </div>
      </div>
    </aside>
  );
}
