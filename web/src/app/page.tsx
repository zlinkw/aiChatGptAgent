"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { getValidatedAuthSession } from "@/lib/auth-session";
import { getDefaultRouteForRole } from "@/store/auth";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    const redirect = async () => {
      const session = await getValidatedAuthSession();
      if (!active) {
        return;
      }
      router.replace(session ? getDefaultRouteForRole(session.role) : "/login");
    };

    void redirect();
    return () => {
      active = false;
    };
  }, [router]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-4">
        <div className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/30 animate-pulse">
          <span className="text-[28px] font-extrabold text-white">G</span>
        </div>
        <div className="text-center">
          <div className="text-[18px] font-bold tracking-tight text-gray-900">ChatGPT2API</div>
          <div className="mt-1 text-[13px] text-gray-400">正在加载...</div>
        </div>
      </div>
    </div>
  );
}
