import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import { PageTransition } from "@/components/page-transition";
import { RouteProgress } from "@/components/route-progress";
import { SideNav } from "@/components/side-nav";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "薅艾AI",
  description: "薅艾AI 管理平台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f7f8fa",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body
        className="antialiased font-sans"
        style={{
          fontFamily:
            'var(--font-sans), "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif',
        }}
      >
        <Toaster position="top-center" richColors offset={48} />
        <RouteProgress />
        <SideNav />
        {/* 左侧菜单占位：防止首次加载时内容区闪烁到左边 */}
        <div className="fixed inset-y-0 left-0 z-30 hidden border-r border-gray-100 bg-white md:block" aria-hidden="true" style={{ width: "var(--sidebar-width, 240px)" }} />
        <main className="h-screen overflow-x-hidden overflow-y-auto px-4 pt-4 pb-2 text-foreground [scrollbar-gutter:stable_both-edges] sm:px-6 lg:px-8" style={{ marginLeft: "var(--sidebar-width, 240px)" }}>
          <div className="mx-auto box-border flex max-w-[1440px] flex-col pt-[env(safe-area-inset-top)]">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </body>
    </html>
  );
}
