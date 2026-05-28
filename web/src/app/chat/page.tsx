"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp, ImagePlus, LoaderCircle, MessageSquare, Plus, Sparkles, Trash2, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import localforage from "localforage";
import webConfig from "@/constants/common-env";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { getStoredAuthKey } from "@/store/auth";
import { cn } from "@/lib/utils";

type Role = "user" | "assistant";
interface ChatMessage { id: string; role: Role; content: string; images?: string[]; loading?: boolean; }
interface Conversation { id: string; title: string; messages: ChatMessage[]; model: string; createdAt: number; updatedAt: number; }

const MODELS = [
  { value: "auto", label: "Auto" }, { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 Mini" }, { value: "gpt-5-1", label: "GPT-5.1" },
  { value: "gpt-5-2", label: "GPT-5.2" }, { value: "gpt-5-3", label: "GPT-5.3" },
  { value: "gpt-5-3-mini", label: "GPT-5.3 Mini" },
  { value: "gpt-image-2", label: "GPT Image 2 (画图)" },
  { value: "codex-gpt-image-2", label: "Codex Image (Plus)" },
];
const STORAGE_KEY = "chat_conversations";
const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const toB64 = (f: File): Promise<string> => new Promise((r, j) => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.onerror = j; rd.readAsDataURL(f); });
const genTitle = (msgs: ChatMessage[]) => { const u = msgs.find(m => m.role === "user"); if (!u?.content) return "新对话"; const t = u.content.slice(0, 30); return t.length < u.content.length ? t + "..." : t; };

function ChatPageContent() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [imgs, setImgs] = useState<string[]>([]);
  const [model, setModel] = useState("auto");
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const active = convs.find(c => c.id === activeId) || null;
  const messages = active?.messages || [];

  useEffect(() => { void localforage.getItem<Conversation[]>(STORAGE_KEY).then(d => { if (d?.length) { setConvs(d); setActiveId(d[0].id); } setLoaded(true); }); }, []);
  useEffect(() => { if (loaded) void localforage.setItem(STORAGE_KEY, convs); }, [convs, loaded]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { const ta = taRef.current; if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; } }, [input]);

  const upImg = async (files: FileList | null) => { if (!files) return; const arr: string[] = []; for (const f of Array.from(files)) { if (f.type.startsWith("image/")) arr.push(await toB64(f)); } setImgs(p => [...p, ...arr]); };
  const onPaste = (e: React.ClipboardEvent) => { const items = e.clipboardData?.items; if (!items) return; const fs: File[] = []; for (const i of Array.from(items)) { if (i.type.startsWith("image/")) { const f = i.getAsFile(); if (f) fs.push(f); } } if (fs.length) { e.preventDefault(); const dt = new DataTransfer(); fs.forEach(f => dt.items.add(f)); void upImg(dt.files); } };

  const updateConv = (id: string, u: Partial<Conversation>) => setConvs(p => p.map(c => c.id === id ? { ...c, ...u, updatedAt: Date.now() } : c));

  const newConv = () => { const c: Conversation = { id: genId(), title: "新对话", messages: [], model, createdAt: Date.now(), updatedAt: Date.now() }; setConvs(p => [c, ...p]); setActiveId(c.id); setInput(""); setImgs([]); };
  const delConv = (id: string) => { setConvs(p => p.filter(c => c.id !== id)); if (activeId === id) setActiveId(convs.find(c => c.id !== id)?.id || null); };

  const send = async () => {
    const txt = input.trim(); if (!txt && !imgs.length) return; if (streaming) return;
    let cid = activeId;
    if (!cid) { const c: Conversation = { id: genId(), title: "新对话", messages: [], model, createdAt: Date.now(), updatedAt: Date.now() }; setConvs(p => [c, ...p]); setActiveId(c.id); cid = c.id; }
    const uMsg: ChatMessage = { id: genId(), role: "user", content: txt, images: imgs.length ? [...imgs] : undefined };
    const aMsg: ChatMessage = { id: genId(), role: "assistant", content: "", loading: true };
    const cur = convs.find(c => c.id === cid); const prev = cur?.messages || [];
    const newMsgs = [...prev, uMsg, aMsg];
    const title = prev.length === 0 ? genTitle([uMsg]) : (cur?.title || "新对话");
    updateConv(cid!, { messages: newMsgs, title, model }); setInput(""); setImgs([]); setStreaming(true);

    const apiMsgs = newMsgs.filter(m => !(m.role === "assistant" && !m.content) && !m.loading).map(m => {
      if (m.role === "user" && m.images?.length) {
        const content: any[] = []; if (m.content) content.push({ type: "text", text: m.content });
        for (const img of m.images) content.push({ type: "image_url", image_url: { url: img } });
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    try {
      const token = await getStoredAuthKey(); const base = webConfig.apiUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ model, messages: apiMsgs, stream: true }) });
      if (!res.ok) { const e = await res.text(); updateConv(cid!, { messages: newMsgs.map(m => m.id === aMsg.id ? { ...m, content: `❌ (${res.status}): ${e}`, loading: false } : m) }); setStreaming(false); return; }
      const reader = res.body?.getReader(); const dec = new TextDecoder(); let acc = "";
      if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = dec.decode(value, { stream: true });
        for (const line of chunk.split("\n")) { const t = line.trim(); if (!t || !t.startsWith("data: ")) continue; const d = t.slice(6); if (d === "[DONE]") break;
          try { const p = JSON.parse(d); const delta = p.choices?.[0]?.delta?.content; if (delta) { acc += delta; updateConv(cid!, { messages: newMsgs.map(m => m.id === aMsg.id ? { ...m, content: acc, loading: false } : m) }); } } catch {} } } }
      updateConv(cid!, { messages: newMsgs.map(m => m.id === aMsg.id ? { ...m, content: acc || "（无回复）", loading: false } : m) });
    } catch (err) { updateConv(cid!, { messages: newMsgs.map(m => m.id === aMsg.id ? { ...m, content: `❌ ${err instanceof Error ? err.message : "错误"}`, loading: false } : m) }); }
    finally { setStreaming(false); }
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } };

  return (
    <div className="flex" style={{ height: "calc(100vh - 2rem)" }}>
      {/* 左侧会话列表 */}
      <div className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-foreground">会话记录</span>
          <button type="button" onClick={newConv} className="grid size-7 cursor-pointer place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground" title="新对话"><Plus className="size-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5 scrollbar-fancy">
          {convs.length === 0 ? <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground">暂无会话</div> : convs.map(c => (
            <div key={c.id} className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] transition", activeId === c.id ? "bg-secondary text-violet-700" : "text-foreground/70 hover:bg-secondary/50")} onClick={() => { setActiveId(c.id); setModel(c.model || "auto"); }}>
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{c.title}</span>
              <button type="button" className="hidden shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-rose-500 group-hover:block" onClick={e => { e.stopPropagation(); delConv(c.id); }}><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧聊天区 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto scrollbar-fancy">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div className="grid size-16 place-items-center rounded-2xl bg-kiro-gradient shadow-lg shadow-violet-500/20"><Sparkles className="size-8 text-white" /></div>
              <div><h2 className="text-[20px] font-semibold text-foreground">有什么可以帮你的？</h2><p className="mt-1 text-[13px] text-muted-foreground">支持文字对话、图片识别、代码生成、画图等</p></div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
              {messages.map(msg => (
                <div key={msg.id} className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "justify-start")}>
                  {msg.role === "assistant" && <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg bg-kiro-gradient text-white"><Sparkles className="size-3.5" /></div>}
                  <div className={cn("max-w-[85%] rounded-2xl px-4 py-3 text-[14px] leading-relaxed", msg.role === "user" ? "bg-violet-500 text-white" : "bg-card border border-border text-foreground")}>
                    {msg.images?.length ? <div className="mb-2 flex flex-wrap gap-2">{msg.images.map((img, i) => <img key={i} src={img} alt="" className="max-h-40 rounded-lg object-cover" />)}</div> : null}
                    {msg.loading ? (
                      <div className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /><span className="text-[13px]">思考中...</span></div>
                    ) : msg.role === "assistant" ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                      : <div className="whitespace-pre-wrap">{msg.content}</div>}
                  </div>
                  {msg.role === "user" && <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background text-[11px] font-bold">你</div>}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-border bg-card px-4 py-3">
          <div className="mx-auto max-w-3xl">
            {imgs.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{imgs.map((img, i) => <div key={i} className="relative"><img src={img} alt="" className="h-16 w-16 rounded-lg object-cover border border-border" /><button type="button" className="absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full bg-rose-500 text-white shadow" onClick={() => setImgs(p => p.filter((_, idx) => idx !== i))}><X className="size-3" /></button></div>)}</div>}
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-background p-2 shadow-sm transition focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100">
              <button type="button" className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground" onClick={() => fileRef.current?.click()} title="上传图片"><ImagePlus className="size-5" /></button>
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => void upImg(e.target.files)} />
              <textarea ref={taRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey} onPaste={onPaste} placeholder="输入消息... (Shift+Enter 换行)" rows={1} className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none" />
              <button type="button" disabled={streaming || (!input.trim() && !imgs.length)} onClick={() => void send()} className={cn("grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg transition", input.trim() || imgs.length ? "bg-violet-500 text-white shadow-sm shadow-violet-500/30 hover:bg-violet-600" : "bg-secondary text-muted-foreground")}>{streaming ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-5" />}</button>
            </div>
            <p className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="flex items-center gap-2">
                <select value={model} onChange={e => setModel(e.target.value)} className="h-7 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground outline-none">
                  {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <button type="button" onClick={newConv} className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground transition hover:bg-secondary"><Plus className="size-3" />新对话</button>
              </span>
              <span>模型可能会犯错，请核查重要信息</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  if (isCheckingAuth || !session) return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  return <ChatPageContent />;
}
