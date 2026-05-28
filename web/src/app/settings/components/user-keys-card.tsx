"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, Copy, Infinity as InfinityIcon, KeyRound, LoaderCircle, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createUserKey, deleteUserKey, fetchUserKeys, updateUserKey, type UserKey } from "@/lib/api";

// 模块级缓存。组件在路由切换里会被反复 mount，
// 每次都从 isLoading=true / items=[] 起跳，会让卡片塌缩成 spinner，
// 视觉上就是设置页内容大幅跳动。命中缓存时直接给出已有 items，不闪。
let cachedItems: UserKey[] | null = null;

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function UserKeysCard() {
  const didLoadRef = useRef(false);
  // 命中模块级缓存时直接拿来当初始 state，避免再次切到设置页时
  // items 从 [] 起跳、isLoading=true 让卡片塌缩成 spinner。
  const [items, setItemsState] = useState<UserKey[]>(() => cachedItems ?? []);
  const [isLoading, setIsLoading] = useState(() => cachedItems === null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [createQuota, setCreateQuota] = useState("100");
  const [createUnlimited, setCreateUnlimited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [revealedKey, setRevealedKey] = useState("");
  const [deletingItem, setDeletingItem] = useState<UserKey | null>(null);
  const [editingItem, setEditingItem] = useState<UserKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editQuota, setEditQuota] = useState("");
  // 编辑额度时的两种心智模型：
  //   add — 在现有总上限上再追加 N 张（admin 最常用："再给 5 张"）
  //   set — 直接覆盖总上限（少用：想精确把上限改成 X）
  // 默认 add 才符合"用完了再加点"的直觉，避免 admin 看到当前=2 想加 2 张于是输 2 结果什么也没发生。
  const [editQuotaMode, setEditQuotaMode] = useState<"add" | "set">("add");
  const [editUnlimited, setEditUnlimited] = useState(false);
  const [editResetUsed, setEditResetUsed] = useState(false);

  // 写 items 时同步刷新缓存，路由切换重新挂载也能拿到最新值。
  const setItems = (next: UserKey[]) => {
    cachedItems = next;
    setItemsState(next);
  };

  const load = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchUserKeys();
      setItems(data.items);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载用户密钥失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    // 已经有缓存：后台静默刷新；否则正常 spinner。
    void load(cachedItems !== null);
  }, []);

  const handleCreate = async () => {
    const quotaValue = createUnlimited ? 0 : Math.max(0, Math.floor(Number(createQuota) || 0));
    if (!createUnlimited && quotaValue <= 0) {
      toast.error("请填写一个大于 0 的额度，或勾选不限额度");
      return;
    }
    setIsCreating(true);
    try {
      const data = await createUserKey({
        name: name.trim(),
        quota: quotaValue,
        unlimited: createUnlimited,
      });
      setItems(data.items);
      setRevealedKey(data.key);
      setName("");
      setCreateQuota("100");
      setCreateUnlimited(false);
      setIsDialogOpen(false);
      toast.success("用户密钥已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建用户密钥失败");
    } finally {
      setIsCreating(false);
    }
  };

  const setItemPending = (id: string, isPending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggle = async (item: UserKey) => {
    setItemPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, { enabled: !item.enabled });
      setItems(data.items);
      toast.success(item.enabled ? "用户密钥已禁用" : "用户密钥已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) {
      return;
    }
    const item = deletingItem;
    setItemPending(item.id, true);
    try {
      const data = await deleteUserKey(item.id);
      setItems(data.items);
      setDeletingItem(null);
      toast.success("用户密钥已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const openEditDialog = (item: UserKey) => {
    setEditingItem(item);
    setEditName(item.name);
    setEditKey("");
    // 默认走 "追加" 模式，输入留空——admin 在这个场景下 90% 的诉求是
    // "再给 N 张"，让他直接输 N 即可，不用先心算 currentQuota+N。
    setEditQuotaMode("add");
    setEditQuota("");
    setEditUnlimited(Boolean(item.unlimited));
    setEditResetUsed(false);
  };

  const handleEdit = async () => {
    if (!editingItem) {
      return;
    }
    const item = editingItem;
    const trimmedName = editName.trim();
    const trimmedKey = editKey.trim();
    // 没填数字时视为"不动额度"，避免 add 模式下保存又把 quota 重置成 0。
    const quotaInput = editQuota.trim();
    const quotaInputNum = quotaInput === "" ? 0 : Math.max(0, Math.floor(Number(quotaInput) || 0));
    const nextQuota = editUnlimited
      ? 0
      : editQuotaMode === "add"
        ? Math.max(0, (item.quota || 0) + quotaInputNum)
        : quotaInputNum;
    const quotaChanged =
      !editUnlimited && quotaInput !== "" && nextQuota !== item.quota;
    const unlimitedChanged = editUnlimited !== Boolean(item.unlimited);
    if (
      trimmedName === item.name &&
      !trimmedKey &&
      !quotaChanged &&
      !unlimitedChanged &&
      !editResetUsed
    ) {
      setEditingItem(null);
      return;
    }
    if (
      !editUnlimited &&
      editQuotaMode === "set" &&
      quotaInput !== "" &&
      nextQuota <= 0 &&
      (quotaChanged || unlimitedChanged)
    ) {
      toast.error("请填写一个大于 0 的额度，或勾选不限额度");
      return;
    }
    if (!editUnlimited && editQuotaMode === "add" && quotaInputNum <= 0 && !unlimitedChanged && !editResetUsed && trimmedName === item.name && !trimmedKey) {
      toast.error("请填写要追加的额度数量");
      return;
    }
    setItemPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, {
        ...(trimmedName !== item.name ? { name: trimmedName } : {}),
        ...(trimmedKey ? { key: trimmedKey } : {}),
        ...(unlimitedChanged ? { unlimited: editUnlimited } : {}),
        ...(quotaChanged ? { quota: nextQuota } : {}),
        ...(editResetUsed ? { reset_used: true } : {}),
      });
      setItems(data.items);
      setEditingItem(null);
      setEditKey("");
      setEditQuota("");
      setEditQuotaMode("add");
      setEditResetUsed(false);
      toast.success("用户密钥已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户密钥失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                <KeyRound className="size-5 text-stone-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">用户密钥管理</h2>
                <p className="text-sm text-stone-500">为普通用户创建专用密钥；普通用户只能进入画图页，不能查看设置和号池。</p>
              </div>
            </div>
            <Button className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => setIsDialogOpen(true)}>
              <Plus className="size-4" />
              创建用户密钥
            </Button>
          </div>

          {revealedKey ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
              <div className="font-medium">新密钥仅展示一次，请立即保存：</div>
              <div className="mt-3 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-white/80 p-3 md:flex-row md:items-center md:justify-between">
                <code className="break-all font-mono text-[13px]">{revealedKey}</code>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-xl border-emerald-200 bg-white px-4 text-emerald-700"
                  onClick={() => void handleCopy(revealedKey)}
                >
                  <Copy className="size-4" />
                  复制
                </Button>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-stone-50 px-6 py-10 text-center text-sm text-stone-500">
              暂无普通用户密钥。点击右上角按钮后即可创建并分发给其他人。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isPending = pendingIds.has(item.id);
                const remaining = item.unlimited ? null : Math.max(0, (item.quota || 0) - (item.used || 0));
                const isExhausted = !item.unlimited && remaining !== null && remaining <= 0;
                return (
                  <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-medium text-stone-800">{item.name}</div>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">
                          {item.enabled ? "已启用" : "已禁用"}
                        </Badge>
                        {item.unlimited ? (
                          <Badge variant="secondary" className="rounded-md bg-violet-50 text-violet-700">
                            <InfinityIcon className="size-3" />
                            不限额度
                          </Badge>
                        ) : isExhausted ? (
                          <Badge variant="secondary" className="rounded-md bg-rose-50 text-rose-700">
                            额度用完
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                        {item.unlimited ? (
                          <span className="font-data tabular-nums text-stone-700">已用 {item.used || 0} / 不限</span>
                        ) : (
                          <span className="font-data tabular-nums text-stone-700">
                            额度 {item.used || 0} / {item.quota || 0}
                            <span className="ml-1 text-stone-500">（剩 {remaining}）</span>
                          </span>
                        )}
                        <span>创建时间 {formatDateTime(item.created_at)}</span>
                        <span>最近使用 {formatDateTime(item.last_used_at)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => openEditDialog(item)}
                        disabled={isPending}
                      >
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => void handleToggle(item)}
                        disabled={isPending}
                      >
                        {isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : item.enabled ? (
                          <Ban className="size-4" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        {item.enabled ? "禁用" : "启用"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-rose-200 bg-white px-4 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        onClick={() => setDeletingItem(item)}
                        disabled={isPending}
                      >
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>创建用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              可选填写一个备注名称，方便区分不同使用者；创建后会生成一条只能查看一次的原始密钥。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称（可选）</label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：设计同学 A、运营临时账号"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">画图额度</label>
              <Input
                type="number"
                min={0}
                value={createQuota}
                onChange={(event) => setCreateQuota(event.target.value)}
                disabled={createUnlimited}
                placeholder="例如：100"
                className="h-11 rounded-xl border-stone-200 bg-white font-data tabular-nums"
              />
              <p className="text-xs leading-5 text-stone-500">
                按生成的图片张数计数；用完后该密钥无法再发起画图任务，需管理员追加额度。
              </p>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
                <Checkbox
                  checked={createUnlimited}
                  onCheckedChange={(checked) => setCreateUnlimited(Boolean(checked))}
                />
                <span>不限额度（与管理员一致）</span>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setIsDialogOpen(false)}
              disabled={isCreating}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleCreate()}
              disabled={isCreating}
            >
              {isCreating ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>删除用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              确认删除用户密钥「{deletingItem?.name}」吗？删除后该密钥将无法继续调用接口。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setDeletingItem(null)}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-rose-600 px-5 text-white hover:bg-rose-700"
              onClick={() => void handleDelete()}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              {deletingItem && pendingIds.has(deletingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingItem(null);
            setEditKey("");
            setEditResetUsed(false);
          }
        }}
      >
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑用户密钥</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              可以修改备注名称、画图额度，或更换专用密钥。留空则保持当前密钥不变。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称</label>
              <Input
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                placeholder="例如：设计同学 A、运营临时账号"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-stone-700">画图额度</label>
                {editingItem && !editingItem.unlimited ? (
                  <span className="font-data tabular-nums text-xs text-stone-500">
                    已用 {editingItem.used || 0} / 当前 {editingItem.quota || 0}
                    {(() => {
                      const remaining = Math.max(0, (editingItem.quota || 0) - (editingItem.used || 0));
                      return <span className="ml-1 text-stone-400">（剩 {remaining}）</span>;
                    })()}
                  </span>
                ) : null}
              </div>
              {!editUnlimited ? (
                <div className="inline-flex rounded-lg border border-stone-200 bg-stone-50 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setEditQuotaMode("add");
                      setEditQuota("");
                    }}
                    className={`cursor-pointer rounded-md px-3 py-1 transition ${
                      editQuotaMode === "add"
                        ? "bg-white text-stone-900 shadow-sm"
                        : "text-stone-500 hover:text-stone-700"
                    }`}
                  >
                    在现有上追加
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditQuotaMode("set");
                      setEditQuota(String(editingItem?.quota || 0));
                    }}
                    className={`cursor-pointer rounded-md px-3 py-1 transition ${
                      editQuotaMode === "set"
                        ? "bg-white text-stone-900 shadow-sm"
                        : "text-stone-500 hover:text-stone-700"
                    }`}
                  >
                    直接覆盖
                  </button>
                </div>
              ) : null}
              <Input
                type="number"
                min={0}
                value={editQuota}
                onChange={(event) => setEditQuota(event.target.value)}
                disabled={editUnlimited}
                placeholder={editQuotaMode === "add" ? "再追加多少张，例如：5" : "新的总上限，例如：100"}
                className="h-11 rounded-xl border-stone-200 bg-white font-data tabular-nums"
              />
              {!editUnlimited && editQuotaMode === "add" && editingItem && editQuota.trim() !== "" ? (
                <p className="font-data tabular-nums text-xs text-stone-500">
                  保存后总上限将变为{" "}
                  <span className="font-semibold text-stone-700">
                    {(editingItem.quota || 0) + Math.max(0, Math.floor(Number(editQuota) || 0))}
                  </span>
                </p>
              ) : null}
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
                <Checkbox
                  checked={editUnlimited}
                  onCheckedChange={(checked) => setEditUnlimited(Boolean(checked))}
                />
                <span>不限额度（与管理员一致）</span>
              </label>
              <button
                type="button"
                onClick={() => setEditResetUsed((prev) => !prev)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                  editResetUsed
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                }`}
              >
                <RotateCcw className="size-3.5" />
                {editResetUsed ? "保存时将重置已用计数" : "重置已用计数"}
              </button>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">新的专用密钥（可选）</label>
              <Input
                value={editKey}
                onChange={(event) => setEditKey(event.target.value)}
                placeholder="例如：sk-your-custom-user-key"
                className="h-11 rounded-xl border-stone-200 bg-white font-mono"
              />
              <p className="text-xs leading-5 text-stone-500">
                保存后旧密钥会立即失效，新密钥生效。系统仍只保存哈希，不会回显当前密钥。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => {
                setEditingItem(null);
                setEditKey("");
                setEditResetUsed(false);
              }}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleEdit()}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              {editingItem && pendingIds.has(editingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
