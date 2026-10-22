import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CodexDesktopContract, ListThreadsResult, OpenThreadResult, Unavailable } from "./contract.js";

const reasonLabels: Record<Unavailable["reason"], string> = {
  host_not_configured: "Выберите Mac в настройках плагина Codex Desktop.",
  host_unavailable: "Выбранный Mac недоступен. Список чатов неизвестен.",
  service_unavailable: "Personal OS на Mac недоступна. Повторите чтение позже.",
  invalid_response: "Не удалось подтвердить данные Personal OS.",
  snapshot_unavailable: "В Personal OS ещё нет снимка чатов Codex.",
  unsupported_platform: "Открытие поддерживается только на Mac.",
  unknown_thread: "Этот ID не найден среди наблюдённых локальных чатов Codex.",
  unsupported_thread: "Это не поддерживаемый чат Codex Desktop.",
  nonlocal_thread: "Этот чат относится к другому компьютеру. Открытие не отправлено.",
  unknown_desktop_host: "Компьютер чата неизвестен. Открытие не отправлено.",
  open_failed: "Не удалось подтвердить передачу команды открытия в macOS.",
  open_outcome_unknown: "Исход команды неизвестен. Проверьте окно Codex перед повторным открытием.",
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function CodexDesktopPanel() {
  const rpc = useRpc<CodexDesktopContract>();
  const [result, setResult] = useState<ListThreadsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<OpenThreadResult | null>(null);
  const [query, setQuery] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("listThreads", null).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, revision]);

  async function open(threadId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpening(threadId);
    setOpenResult(null);
    try {
      const value = await rpc.call("openThread", { threadId });
      if (mounted.current) setOpenResult(value);
    } catch {
      if (mounted.current) setOpenResult({ state: "unavailable", observedAt: new Date().toISOString(), reason: "open_outcome_unknown" });
    } finally {
      inFlight.current = false;
      if (mounted.current) setOpening(null);
    }
  }

  const list = result?.state === "available" ? result.data : null;
  const search = query.trim().toLocaleLowerCase();
  const visibleThreads = list?.threads.filter(thread => !search || thread.title.toLocaleLowerCase().includes(search) || thread.threadId.includes(search)) ?? [];
  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 md:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Чаты Codex</h1><p className="text-sm text-muted-foreground">Открываются на настроенном Mac. Здесь сохранённый список Personal OS.</p></div><Button variant="outline" size="sm" disabled={opening !== null} onClick={() => { setOpenResult(null); setRevision(value => value + 1); }}>Обновить список</Button></header>
    {result === null && !failed && <p className="text-sm text-muted-foreground" role="status">Читаем наблюдения чатов…</p>}
    {(failed || result?.state === "unavailable") && <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground" role="status">{result?.state === "unavailable" ? reasonLabels[result.reason] : "Не удалось прочитать список. Наличие чатов неизвестно."}</p>}
    {openResult && <p className="rounded-lg border border-border bg-card p-4 text-sm" role="status">{openResult.state === "open_requested" ? "Запрос открытия передан macOS. Переход к нужному чату в Codex ещё не подтверждён." : reasonLabels[openResult.reason]}</p>}
    {list && <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>Снимок {formatTime(list.sourceObservedAt)}</span><span>{list.sourceFreshness === "fresh" ? "В пределах срока обновления" : list.sourceFreshness === "stale" ? "Снимок устарел" : "Свежесть неизвестна"}</span>{list.sourceHealth !== "available" && <span>Последнее обновление источника не подтверждено</span>}</div>
      <div className="flex flex-wrap items-end justify-between gap-3"><label className="flex w-full flex-col gap-2 text-sm sm:max-w-sm" htmlFor="codex-desktop-search">Найти чат<Input id="codex-desktop-search" type="search" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Название или UUID" autoComplete="off" /></label><span className="text-xs tabular-nums text-muted-foreground" role="status">Найдено {visibleThreads.length} из {list.threads.length} {list.truncated ? "показанных" : "локальных"}</span></div>
      <section className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card" aria-label="Наблюдённые локальные чаты Codex">{visibleThreads.map(thread => {
        const observationId = "codex-observation-" + thread.threadId;
        const showStale = thread.freshness === "stale" && list.sourceFreshness !== "stale";
        const showUnknown = thread.freshness === "unknown" && list.sourceFreshness !== "unknown";
        return <article key={thread.threadId} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1 space-y-1"><h2 className="break-words text-sm font-medium" title={thread.title + "\nНаблюдение: " + thread.observedAt + "\nCodex ID: " + thread.threadId}>{thread.title}</h2><span id={observationId} className="sr-only">Наблюдение: {thread.observedAt}. Codex Desktop ID: {thread.threadId}.</span>{(showStale || showUnknown || !thread.inCurrentScope) && <p className="text-xs text-muted-foreground">{[showStale ? "Наблюдение устарело" : showUnknown ? "Свежесть неизвестна" : null, !thread.inCurrentScope ? "Вне последнего охвата" : null].filter(Boolean).join(" · ")}</p>}</div><Button variant="outline" size="sm" disabled={opening !== null} aria-label={"Открыть чат «" + thread.title + "» в Codex"} aria-describedby={observationId} onClick={() => void open(thread.threadId)}>{opening === thread.threadId ? "Передаём запрос…" : "Открыть в Codex ↗"}</Button></article>;
      })}{visibleThreads.length === 0 && <p className="p-5 text-sm text-muted-foreground">{list.threads.length === 0 ? "В доступном снимке нет поддерживаемых локальных чатов Codex." : "По этому названию или UUID чаты не найдены."}</p>}</section>
      {(list.omittedCount > 0 || list.truncated) && <p className="text-xs text-muted-foreground">Не показано: {list.omittedCount}. Включены только локальные чаты Codex с подтверждённой структурой ID.{list.truncated ? " Достигнут предел списка." : ""}</p>}
    </>}
    <footer className="text-xs text-muted-foreground">Открытие не создаёт чат, не отправляет сообщение и не запускает работу агента.</footer>
  </main>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "codex-desktop", title: "Чаты Codex", icon: "MessageSquare", path: "codex-desktop", component: CodexDesktopPanel });
});
