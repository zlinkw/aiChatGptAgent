"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle, SlidersHorizontal } from "lucide-react";

import webConfig from "@/constants/common-env";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { RegisterConfig } from "@/lib/api";
import { getStoredAuthKey } from "@/store/auth";

import { useSettingsStore } from "../settings/store";
import { RegisterSettingsCard } from "../register/components/register-settings-card";

function RegisterDataController() {
  const didLoadRef = useRef(false);
  const loadRegister = useSettingsStore((state) => state.loadRegister);
  const setRegisterConfig = useSettingsStore((state) => state.setRegisterConfig);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadRegister();
  }, [loadRegister]);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    void getStoredAuthKey().then((token) => {
      if (closed || !token) return;
      const baseUrl = webConfig.apiUrl.replace(/\/$/, "");
      source = new EventSource(`${baseUrl}/api/register/events?token=${encodeURIComponent(token)}`);
      source.onmessage = (event) => {
        setRegisterConfig(JSON.parse(event.data) as RegisterConfig);
      };
    });
    return () => {
      closed = true;
      source?.close();
    };
  }, [setRegisterConfig]);

  return null;
}

function RegisterSettingsContent() {
  return (
    <>
      <RegisterDataController />
      <section className="mt-4 mb-4 flex items-center gap-3 sm:mt-6">
        <div className="grid size-10 place-items-center rounded-xl bg-kiro-gradient shadow-lg shadow-violet-500/30">
          <SlidersHorizontal className="size-5 text-white" />
        </div>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">注册配置</h1>
          <p className="text-[13px] text-muted-foreground">
            配置注册参数、邮箱 provider、CPA 推送和 SMS 接码
          </p>
        </div>
      </section>
      <section>
        <RegisterSettingsCard />
      </section>
    </>
  );
}

export default function RegisterSettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <RegisterSettingsContent />;
}
