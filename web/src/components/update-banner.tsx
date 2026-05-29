"use client";

/**
 * 全站顶部「有新版本」横幅。
 *
 * 行为：
 * - 仅 admin 角色可见（普通用户不打扰）
 * - 后端 /version/check 返回 has_update=true 时显示
 * - 用户点 "下次提醒" 会把当前 latest 版本号写到 localStorage，
 *   直到 GitHub 上又出来更新的版本才会再提示
 * - 任何错误都静默吞掉，绝不影响页面正常使用
 */

import { useEffect, useState } from "react";
import { ExternalLink, Sparkles, X } from "lucide-react";
import { usePathname } from "next/navigation";

import { httpRequest } from "@/lib/request";
import { getCachedAuthSession, getValidatedAuthSession } from "@/lib/auth-session";

interface VersionCheckResponse {
  current: string;
  latest: string | null;
  has_update: boolean;
  release_url: string;
  repo_url: string;
}

const DISMISS_KEY = "update-banner-dismissed-version";

export function UpdateBanner() {
  const pathname = usePathname();
  const [info, setInfo] = useState<VersionCheckResponse | null>(null);
  const [dismissed, setDismissed] = useState(true); // 默认 true 避免闪烁

  useEffect(() => {
    if (pathname === "/login") {
      setInfo(null);
      return;
    }
    let active = true;

    const load = async () => {
      try {
        // 先用缓存判断是不是 admin，避免无谓的请求
        const cached = getCachedAuthSession();
        const session = cached ?? (await getValidatedAuthSession());
        if (!active || !session || session.role !== "admin") return;

        const res = await httpRequest<VersionCheckResponse>("/version/check", {
          redirectOnUnauthorized: false,
        });
        if (!active) return;

        // 用户已经"下次提醒"过的版本就不再弹
        const stored = typeof window !== "undefined" ? localStorage.getItem(DISMISS_KEY) : null;
        const isDismissed = stored !== null && stored === res.latest;

        setInfo(res);
        setDismissed(isDismissed);
      } catch {
        // 网络或权限问题都直接吞，更新提示不应该影响主流程
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  if (!info || !info.has_update || !info.latest || dismissed) return null;

  const handleDismiss = () => {
    if (info.latest && typeof window !== "undefined") {
      localStorage.setItem(DISMISS_KEY, info.latest);
    }
    setDismissed(true);
  };

  return (
    <div className="sticky top-0 z-50 border-b border-violet-200 bg-gradient-to-r from-violet-50 via-purple-50 to-violet-50">
      <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <Sparkles className="size-4 shrink-0 text-violet-600" />
        <div className="flex-1 text-[12.5px] text-foreground">
          <span className="font-semibold text-violet-700">发现新版本 v{info.latest}</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-muted-foreground">当前 v{info.current}</span>
          <span className="mx-2 text-muted-foreground hidden sm:inline">·</span>
          <span className="hidden text-muted-foreground sm:inline">建议拉取最新代码后重新部署</span>
        </div>
        <a
          href={info.release_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11.5px] font-semibold text-white transition hover:bg-violet-700"
        >
          查看更新
          <ExternalLink className="size-3" />
        </a>
        <button
          type="button"
          onClick={handleDismiss}
          className="cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-violet-100 hover:text-foreground"
          title="下次提醒"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
