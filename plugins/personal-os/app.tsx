import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type FormEvent } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { definePluginApp, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { z } from "zod";
import { submitInputSchema, type InputArtifactResult, type InputDetail, type InputDetailResult, type InputItem, type InputsResult, type Mission, type MissionActivityResult, type MissionResult, type MissionsResult, type OpenTaskChatResult, type PartialResult, type PersonalOsContract, type SubmitInput, type SubmissionLookupResult, type Task, type TaskActivityItem, type TaskActivityResult, type TaskChatResult, type TaskExecutionBinding, type TaskResult, type TasksResult } from "./contract.js";

const PANEL_PATH = "personal-os";
const columns = [
  { state: "doing", title: "В работе" },
  { state: "todo", title: "Дальше" },
  { state: "blocked", title: "Препятствия" },
  { state: "done", title: "Готово" },
] as const;
const missionLabels: Record<string, string> = { active: "Активна", waiting: "Ожидает", paused: "На паузе", completed: "Завершена", cancelled: "Отменена" };
const unavailableLabels = {
  host_not_configured: "Выберите host ID Mac с Personal OS в настройках плагина.",
  host_unavailable: "Нет связи с выбранным Mac. Статусы задач неизвестны.",
  service_unavailable: "Personal OS на Mac недоступна. Статусы задач неизвестны.",
  invalid_response: "Ответ Personal OS не соответствует контракту. Статусы неизвестны.",
};

const inputDraftSchema = z.object({
  version: z.literal(1),
  text: z.string().max(20000),
  target: submitInputSchema.shape.target,
  targetLabel: z.string().max(4000),
  pending: submitInputSchema.nullable(),
}).strict().refine(value => value.pending === null || value.pending.text === value.text && JSON.stringify(value.pending.target) === JSON.stringify(value.target));
type InputDraft = z.infer<typeof inputDraftSchema>;
const emptyInputDraft = (): InputDraft => ({ version: 1, text: "", target: { scope: "personal" }, targetLabel: "", pending: null });

function readInputDraft(storageKey: string): { draft: InputDraft; raw: string | null; error: string; corrupt: boolean } {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return { draft: emptyInputDraft(), raw, error: "", corrupt: false };
    const parsed = inputDraftSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { draft: parsed.data, raw, error: "", corrupt: false };
    return { draft: emptyInputDraft(), raw, error: "Сохранённый черновик повреждён. Прежняя отправка не подтверждена.", corrupt: true };
  } catch {
    return { draft: emptyInputDraft(), raw: null, error: "Не удалось прочитать черновик из браузера.", corrupt: true };
  }
}

function readInputBackups(storageKey: string): InputDraft[] {
  const raw = window.sessionStorage.getItem(storageKey);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  const parsed = z.array(inputDraftSchema).safeParse(Array.isArray(value) ? value : [value]);
  if (!parsed.success || parsed.data.some(draft => draft.pending !== null)) throw new Error("invalid_input_backups");
  return parsed.data;
}

function InputComposer({ missionId, onSaved, onStatus, openRequest, composerId }: { missionId: string | null; onSaved: () => void; onStatus: (label: string) => void; openRequest: number; composerId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const fieldId = useId();
  const storageKey = pluginId + ":personal-os-input:v1";
  const backupKey = storageKey + ":unsent";
  const lockAvailable = typeof navigator.locks?.request === "function";
  const [initial] = useState(() => readInputDraft(storageKey));
  const [draft, setDraft] = useState(initial.draft);
  const [storageError, setStorageError] = useState(initial.error);
  const [notice, setNotice] = useState(initial.draft.pending ? "Исход прежней отправки не подтверждён. Проверьте отправку." : "");
  const [busy, setBusy] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [missionRevision, setMissionRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [backups, setBackups] = useState<InputDraft[]>(() => {
    try { return readInputBackups(backupKey); } catch { return []; }
  });
  const backup = backups[0] ?? null;
  const draftRef = useRef(draft);
  const localOwned = useRef(initial.draft.pending === null && !!initial.draft.text);
  const storageToken = useRef(initial.raw);
  const generation = useRef(0);
  const writeQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const composerRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setMission(null);
    if (missionId) void rpc.call("getMission", { missionId }).then(result => {
      if (active && result.state === "available" && result.data.id === missionId) setMission(result.data);
    }).catch(() => { if (active) setMission(null); });
    return () => { active = false; };
  }, [rpc, missionId, missionRevision]);
  const showDraft = (next: InputDraft) => {
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  };
  const adoptShared = () => {
    generation.current += 1;
    const current = readInputDraft(storageKey);
    if (current.corrupt) {
      if (mounted.current) { setStorageError(current.error); setConflict(true); }
      return;
    }
    const local = draftRef.current;
    if (localOwned.current && !local.pending && local.text && (local.text !== current.draft.text || JSON.stringify(local.target) !== JSON.stringify(current.draft.target))) {
      try {
        const saved = readInputBackups(backupKey);
        const next = saved.some(item => JSON.stringify(item) === JSON.stringify(local)) ? saved : [...saved, local];
        window.sessionStorage.setItem(backupKey, JSON.stringify(next));
        if (mounted.current) setBackups(next);
      } catch {
        if (mounted.current) { setStorageError("Другая вкладка изменила черновик. Этот текст не удалось сохранить отдельно. Не закрывайте вкладку."); setConflict(true); }
        return;
      }
    }
    storageToken.current = current.raw;
    localOwned.current = false;
    showDraft(current.draft);
    if (mounted.current) {
      setConflict(false);
      setStorageError("");
      setNotice(current.draft.pending ? "В другой вкладке есть отправка с неподтверждённым исходом. Проверьте её прежним запросом." : "Черновик обновлён в другой вкладке.");
    }
  };
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === storageKey || event.key === null)) adoptShared();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);
  const persist = (next: InputDraft, pendingId?: string): Promise<boolean> => {
    if (!lockAvailable || initial.corrupt || conflict) return Promise.resolve(false);
    const scheduledGeneration = generation.current;
    if (!pendingId && !next.pending) { localOwned.current = true; showDraft(next); }
    const operation = writeQueue.current.then(() => navigator.locks.request(storageKey, () => {
      if (scheduledGeneration !== generation.current) return false;
      const current = readInputDraft(storageKey);
      if (current.corrupt) { if (mounted.current) { setStorageError(current.error); setConflict(true); } return false; }
      if (current.raw !== storageToken.current || pendingId && current.draft.pending?.requestId !== pendingId) {
        adoptShared();
        return false;
      }
      if (current.draft.pending && next.pending?.requestId !== current.draft.pending.requestId && !pendingId) {
        adoptShared();
        return false;
      }
      try {
        const raw = JSON.stringify(next);
        window.localStorage.setItem(storageKey, raw);
        storageToken.current = raw;
        if (!next.text) localOwned.current = false;
        if (pendingId || next.pending) showDraft(next);
        if (mounted.current) setStorageError("");
        return true;
      } catch {
        if (mounted.current) setStorageError("Черновик не удалось сохранить в браузере. Не закрывайте вкладку.");
        return false;
      }
    })).catch(() => {
      if (mounted.current) setStorageError("Не удалось защитить запись между вкладками. Сохранение черновика не подтверждено.");
      return false;
    });
    writeQueue.current = operation;
    return operation;
  };
  const chooseTarget = (target: SubmitInput["target"], targetLabel: string) => {
    if (busyRef.current || draftRef.current.pending || initial.corrupt) return;
    void persist({ ...draftRef.current, target, targetLabel });
    setNotice("");
  };
  const receive = async (result: SubmissionLookupResult, request: SubmitInput) => {
    if (result.requestId !== request.requestId) {
      setNotice("Ответ не подтвердил прежнюю отправку. Нужна сверка.");
      return;
    }
    if (result.state === "saved") {
      const matches = request.target.scope === "personal" ? result.missionId === null && result.missionVersion === null : result.missionId === request.target.missionId && result.missionVersion === request.target.expectedMissionVersion + 1;
      if (!matches) { setNotice("Ответ не подтвердил выбранную цель. Нужна сверка."); return; }
      const cleared = await persist(emptyInputDraft(), request.requestId);
      setSavedNoteId(result.noteId);
      onSaved();
      setNotice(cleared ? "Поручение сохранено. Следующий этап — разбор директором." : "Поручение сохранено. Общий черновик изменился или недоступен; он не очищен.");
      setMissionRevision(value => value + 1);
    } else if (result.state === "rejected") {
      const cleared = await persist({ ...draftRef.current, pending: null }, request.requestId);
      setNotice(cleared ? result.reason === "version_conflict" ? "Цель изменилась. Обновите привязку перед отправкой." : "Запрос отклонён. Текст сохранён в черновике." : "Запрос отклонён. Общий черновик изменился или недоступен; он не очищен.");
      if (result.reason === "version_conflict") setMissionRevision(value => value + 1);
    } else if (result.state === "not_sent") {
      const cleared = await persist({ ...draftRef.current, pending: null }, request.requestId);
      setNotice(cleared ? "Поручение не отправлено. Выберите Mac в настройках плагина." : "Поручение не отправлено. Общий черновик изменился или недоступен; он не очищен.");
    } else if (result.state === "blocked") {
      setNotice(result.reason === "host_changed" ? "Mac для отправки изменился. Верните прежнюю привязку и проверьте отправку." : result.reason === "host_not_configured" ? "Нужна прежняя привязка Mac. Исход отправки не подтверждён." : "Запрос не совпал с сохранённой отправкой. Нужна сверка.");
    } else {
      setNotice("Сохранение не подтверждено. «Проверить отправку» использует прежний запрос.");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || initial.corrupt || conflict || !lockAvailable) return;
    const current = draftRef.current;
    let request = current.pending;
    const retry = request !== null;
    if (!request) {
      const parsed = submitInputSchema.safeParse({ requestId: crypto.randomUUID(), text: current.text, target: current.target });
      if (!parsed.success) { setNotice("Введите поручение длиной до 20 000 символов."); return; }
      request = parsed.data;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (!await persist({ ...current, pending: request })) return;
      setNotice(retry ? "Проверяем прежнюю отправку…" : "Сохраняем поручение…");
      const known = retry ? await rpc.call("getInputSubmission", { requestId: request.requestId }) : null;
      const result = known && ["saved", "rejected", "not_sent"].includes(known.state) ? known : await rpc.call("submitInput", request);
      if (mounted.current) await receive(result, request);
    } catch {
      if (mounted.current) setNotice("Исход отправки неизвестен. Текст и прежний запрос сохранены для проверки.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const locked = busy || draft.pending !== null || initial.corrupt || conflict || !lockAvailable;
  const composerLabel = busy ? "Отправка сохраняется…" : draft.pending ? "Проверить отправку" : storageError || initial.corrupt || conflict || !lockAvailable ? "Ввод требует внимания" : draft.text.trim() ? "Продолжить черновик" : backup ? "Сохранённые черновики" : "+ Поручение";
  useEffect(() => { onStatus(composerLabel); }, [composerLabel, onStatus]);
  useEffect(() => {
    const panel = composerRef.current;
    if (!openRequest || !panel || panel.closest("[hidden]")) return;
    panel.open = true;
    panel.scrollIntoView({ block: "start" });
    const field = panel.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
    const submitButton = panel.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)');
    (field ?? submitButton ?? panel.querySelector<HTMLElement>("summary"))?.focus();
  }, [openRequest]);
  const availableMission = mission && mission.id === missionId && !["completed", "cancelled"].includes(mission.state) ? mission : null;
  const selectedMission = draft.target.scope === "mission";
  const sameMission = draft.target.scope === "mission" && availableMission?.id === draft.target.missionId;
  const staleTarget = sameMission && draft.target.scope === "mission" && availableMission?.version !== draft.target.expectedMissionVersion;
  return <details ref={composerRef} id={composerId} className="mx-auto w-full max-w-5xl rounded-lg border border-border bg-card">
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{composerLabel}</summary>
    <form onSubmit={submit} className="space-y-3 border-t border-border p-4" aria-label="Новое поручение">
      <label className="sr-only" htmlFor={fieldId}>Что нужно сделать?</label>
      <Textarea id={fieldId} value={draft.text} maxLength={20000} rows={2} placeholder="Что нужно сделать?" disabled={locked} onChange={event => { void persist({ ...draftRef.current, text: event.target.value }); setNotice(""); }} />
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2" role="group" aria-label="Куда добавить поручение">
        <Button type="button" variant={!selectedMission ? "secondary" : "ghost"} size="sm" aria-pressed={!selectedMission} disabled={locked} onClick={() => chooseTarget({ scope: "personal" }, "")}>Личное входящее</Button>
        <Button type="button" variant={sameMission ? "secondary" : "ghost"} size="sm" aria-pressed={sameMission} disabled={locked || !availableMission} onClick={() => { if (availableMission) chooseTarget({ scope: "mission", missionId: availableMission.id, expectedMissionVersion: availableMission.version }, availableMission.title); }}>{staleTarget ? "Обновить привязку" : "К текущей цели"}</Button>
      </div><Button type="submit" size="sm" disabled={busy || initial.corrupt || conflict || !lockAvailable || !draft.pending && (!draft.text.trim() || staleTarget)}>{busy ? "Сохраняем…" : draft.pending ? "Проверить отправку" : "Добавить"}</Button></div>
      {selectedMission && <p className="text-xs text-muted-foreground">К цели: {draft.targetLabel || "ранее выбранная цель"}{staleTarget ? " · условия изменились" : ""}</p>}
      {storageError && <p className="text-xs text-destructive-text" role="alert">{storageError}</p>}
      {!lockAvailable && <p className="text-xs text-destructive-text" role="alert">Браузер не поддерживает безопасную запись между вкладками. Добавление поручений недоступно.</p>}
      {backup && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Отдельных черновиков в этой вкладке: {backups.length}.</span><Button type="button" variant="ghost" size="sm" disabled={locked || !!draft.text} onClick={async () => {
        if (await persist(backup)) {
          try {
            const remaining = readInputBackups(backupKey).filter(item => JSON.stringify(item) !== JSON.stringify(backup));
            if (remaining.length) window.sessionStorage.setItem(backupKey, JSON.stringify(remaining));
            else window.sessionStorage.removeItem(backupKey);
            setBackups(remaining);
          } catch { setStorageError("Черновик восстановлен. Его отдельную копию удалить не удалось."); }
        }
      }}>Вернуть черновик</Button></div>}
      {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
      {savedNoteId && <Button type="button" variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "input/" + savedNoteId })}>Открыть сохранённое поручение →</Button>}
    </form>
  </details>;
}

function Unavailable({ result }: { result: { reason: keyof typeof unavailableLabels } | null }) {
  return <div className="rounded-lg border border-border p-5 text-sm text-muted-foreground" role="status">{result ? unavailableLabels[result.reason] : "Не удалось прочитать данные. Статусы неизвестны."}</div>;
}

function ReadTime({ value }: { value: string }) {
  return <span className="text-xs text-muted-foreground">Прочитано {new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

const inputStateLabels: Record<InputItem["state"], string> = { new: "Ждёт разбора", reviewing: "На разборе", planned: "План сохранён", done: "Отмечено готовым" };
const inputTitle = (note: InputItem) => {
  const first = note.text.trim().split(/\r?\n/)[0] || "Поручение";
  return first.length > 140 ? first.slice(0, 137) + "…" : first;
};
const currentPartial = (item: PartialResult) => item.note_current === true && item.candidate_current === true;

function partialStatus(note: InputItem): string | null {
  if (note.results.state !== "available" || note.results.items.some(item => item.note_id !== note.id)) return "Сведения о результате недоступны";
  if (!note.results.items.length) return !note.results.truncated && note.results.total_count === 0 ? null : "Сведения о результате неполны";
  if (note.results.items.some(currentPartial)) return "Есть частичный результат";
  if (note.results.items.some(item => item.note_current === false || item.candidate_current === false)) return "Есть прежний результат";
  return "Актуальность результата неизвестна";
}

function PlainText({ text }: { text: string }) {
  return <div className="space-y-2 text-sm"><p className="whitespace-pre-wrap break-words">{text.length > 600 ? text.slice(0, 280) + "…" : text}</p>{text.length > 600 && <details><summary className="cursor-pointer text-xs text-muted-foreground">Читать полностью</summary><p className="whitespace-pre-wrap break-words pt-3">{text}</p></details>}</div>;
}

const reportElements = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "ul", "table", "thead", "tbody", "tr", "th", "td"];
const reportPlugins = [remarkGfm];
function reportHttpsHref(value: string): string | null {
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}
const reportUrlTransform: UrlTransform = value => reportHttpsHref(value) ?? "";
function ReportLink({ children, href }: ComponentPropsWithoutRef<"a">) {
  const safeHref = href === undefined ? null : reportHttpsHref(href);
  return safeHref === null ? <span>{children}</span> : <a href={safeHref} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-2">{children}</a>;
}
const reportComponents: Components = {
  a: ReportLink,
  p: ({ children }) => <p className="mb-3 break-words last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-medium first:mt-0">{children}</h4>,
  h5: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-medium first:mt-0">{children}</h4>,
  h6: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-medium first:mt-0">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children, start }) => <ol start={start} className="mb-3 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  code: ({ children }) => <code className="rounded-sm bg-secondary px-1 font-mono text-xs">{children}</code>,
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md border border-border bg-secondary p-3">{children}</pre>,
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => <div className="my-2 max-w-full overflow-x-auto"><table className="w-full border-collapse border border-border">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-secondary">{children}</thead>,
  th: ({ children, align }) => <th scope="col" className={"border border-border px-2 py-2 font-medium " + (align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left")}>{children}</th>,
  td: ({ children, align }) => <td className={"break-words border border-border px-2 py-2 align-top " + (align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left")}>{children}</td>,
};
const reportPreviewComponents: Components = { ...reportComponents, a: ({ children }) => <span>{children}</span> };

function ReportBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const clamped = text.length > 600 && !expanded;
  return <div className="min-w-0 space-y-2 text-sm leading-relaxed"><div id={bodyId} className={clamped ? "max-h-48 overflow-hidden" : undefined}><ReactMarkdown skipHtml allowedElements={reportElements} unwrapDisallowed remarkPlugins={reportPlugins} components={clamped ? reportPreviewComponents : reportComponents} urlTransform={reportUrlTransform}>{text}</ReactMarkdown></div>{text.length > 600 && <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>{expanded ? "Свернуть" : "Читать полностью"}</Button>}</div>;
}

function InputList({ missionId, refreshRevision }: { missionId: string | null; refreshRevision: number }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [scope, setScope] = useState<"personal" | "mission">(missionId ? "mission" : "personal");
  const [result, setResult] = useState<InputsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    setExpanded(false);
    const input = scope === "mission" && missionId ? { scope: "mission" as const, missionId } : { scope: "personal" as const };
    void rpc.call("listInputs", input).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, scope, missionId, revision, refreshRevision]);
  const data = result?.state === "available" && result.data.scope === scope && result.data.mission_id === (scope === "mission" ? missionId : null) ? result.data : null;
  const matches = data && data.items.every(note => scope === "mission" ? note.mission_id === missionId && note.mission_link_state === "linked" : note.mission_id === null && note.mission_link_state === "unlinked" && note.project_id === null);
  const items = data && matches ? data.items : null;
  return <section className="mx-auto w-full max-w-5xl space-y-3 p-4" aria-label="Мои поручения">
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="sr-only">Мои поручения</h2><div className="flex flex-wrap gap-1"><Button type="button" variant={scope === "personal" ? "secondary" : "ghost"} size="sm" aria-pressed={scope === "personal"} onClick={() => setScope("personal")}>Личные</Button>{missionId && <Button type="button" variant={scope === "mission" ? "secondary" : "ghost"} size="sm" aria-pressed={scope === "mission"} onClick={() => setScope("mission")}>Эта цель</Button>}<Button type="button" variant="ghost" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></div></header>
    {result === null && !failed && <p className="text-xs text-muted-foreground" role="status">Читаем поручения…</p>}
    {failed || result?.state === "unavailable" || result?.state === "available" && !items ? <p className="text-sm text-muted-foreground" role="status">Поручения прочитать не удалось. Их количество и состояние неизвестны.</p> : null}
    {items && data && <><div className="grid gap-2 md:grid-cols-3">{(expanded ? items : items.slice(0, 3)).map(note => <button type="button" key={note.id} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "input/" + note.id })} className="flex min-w-0 cursor-pointer flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="line-clamp-2 break-words text-sm font-medium">{inputTitle(note)}</span><span className="mt-auto text-xs text-muted-foreground">{inputStateLabels[note.state]}{partialStatus(note) ? " · " + partialStatus(note) : ""}</span></button>)}</div>{items.length === 0 && <p className="text-sm text-muted-foreground">{scope === "mission" ? "Поручений этой цели нет." : "Личных поручений нет."}</p>}{(items.length > 3 || data.truncated) && <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? "Свернуть" : "Все поручения · " + data.total_count}</Button>}{data.truncated && <p className="text-xs text-muted-foreground">Показаны последние {expanded ? items.length : Math.min(3, items.length)} из {data.total_count}. Список неполон.</p>}</>}
  </section>;
}

function SavedPlan({ note }: { note: InputDetail }) {
  const triage = note.triage;
  const plan = triage.state === "available" ? triage.plan : null;
  return <section className="space-y-3" aria-label="Сохранённый план"><h2 className="text-base font-semibold">План директора</h2>{plan ? <>
    {triage.note_current !== true && <p className="text-xs text-muted-foreground">{triage.note_current === false ? "План относится к прежнему поручению." : "Связь плана с текущим поручением не подтверждена."}</p>}
    <PlainText text={plan.summary} />
    {plan.next_actions.length > 0 && <ol className="list-decimal space-y-3 pl-5 text-sm">{plan.next_actions.map((action, index) => <li key={index}><p className="break-words font-medium">{action.title}</p>{action.reason.trim() !== action.title.trim() && <p className="break-words text-muted-foreground">{action.reason}</p>}</li>)}</ol>}
    {plan.required_outcomes.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Нужный результат · {plan.required_outcomes.length}</summary><ul className="list-disc space-y-2 pl-5 pt-3">{plan.required_outcomes.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words">{text}</li>)}</ul></details>}
    {plan.findings.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Замечания · {plan.findings.length}</summary><ul className="list-disc space-y-2 pl-5 pt-3">{plan.findings.map((finding, index) => <li key={index} className="whitespace-pre-wrap break-words">{finding.description}</li>)}</ul></details>}
    {plan.questions.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Вопросы · {plan.questions.length}</summary><ul className="list-disc space-y-2 pl-5 pt-3">{plan.questions.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words">{text}</li>)}</ul></details>}
    <p className="text-xs text-muted-foreground">Это план. Его запись не подтверждает выполнение.</p>
    {triage.mission_version_current !== true && note.mission_id && <p className="text-xs text-muted-foreground">{triage.mission_version_current === false ? "Версия цели после записи плана изменилась." : "Совпадение с текущей версией цели не подтверждено."}</p>}
  </> : <p className="text-sm text-muted-foreground">{triage.state === "empty" ? "План пока не сохранён." : "Сохранённый план прочитать не удалось."}</p>}</section>;
}

function fileReviewText(review: PartialResult["review"], current: boolean): string {
  if (!current) return "Актуальная проверка этим результатом не подтверждена.";
  if (review.state === "empty") return "Ограниченная проверка пока не сохранена.";
  if (review.state !== "available" || review.applicable !== true) return "Сведения об актуальной проверке недоступны.";
  return review.outcome === "no_blocking_findings" ? "По выбранным требованиям блокирующих замечаний не найдено." : review.outcome === "changes_required" ? "По выбранным требованиям нужны исправления." : review.outcome === "inconclusive" ? "Вывода по выбранным требованиям недостаточно." : "Итог ограниченной проверки неизвестен.";
}

function PartialResultBlock({ item, noteId }: { item: PartialResult; noteId: string }) {
  const navigate = useBbNavigate();
  const current = currentPartial(item);
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4"><h2 className="text-base font-semibold">Частичный результат</h2>{!current && <p className="text-xs text-muted-foreground">{item.note_current === false || item.candidate_current === false ? "Исторический результат по прежним условиям." : "Связь с текущими условиями не подтверждена."}</p>}<div className="space-y-1"><p className="text-xs text-muted-foreground">Выводы по переданным материалам</p><PlainText text={item.summary} /><p className="text-xs text-muted-foreground">Это выводы исследования, а не текущий статус системы.</p></div><Button type="button" variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "input/" + noteId + "/result/" + item.id })}>Прочитать полученный файл →</Button>{item.next_action && <div className="space-y-1"><h3 className="text-sm font-medium">Предложенный следующий шаг</h3><PlainText text={item.next_action} /></div>}<p className="text-xs text-muted-foreground">Проверка файла: {fileReviewText(item.review, current)}</p></section>;
}

function InputPage({ noteId }: { noteId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<InputDetailResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getInput", { noteId }).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, noteId, revision]);
  const note = result?.state === "available" && result.data.item.id === noteId ? result.data.item : null;
  const partials = note?.results.state === "available" && note.results.items.every(item => item.note_id === noteId) && (note.results.items.length > 0 || note.results.total_count === 0 && !note.results.truncated) ? note.results.items : null;
  const latest = partials?.[0] ?? null;
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8"><header className="flex items-center justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>← Мои поручения</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header>
    {result === null && !failed && <p className="text-sm text-muted-foreground" role="status">Читаем поручение…</p>}{failed || result !== null && !note ? <p className="text-sm text-muted-foreground" role="status">Поручение прочитать не удалось. Его состояние неизвестно.</p> : null}
    {note && <><header className="space-y-2"><p className="text-xs text-muted-foreground">{inputStateLabels[note.state]}</p><h1 className="text-xl font-semibold tracking-tight">{note.mission_id ? "Поручение цели" : "Личное поручение"}</h1>{note.mission_id && <Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + note.mission_id })}>К задачам цели →</Button>}</header>
      <section className="space-y-2"><h2 className="text-base font-semibold">Исходное поручение</h2><PlainText text={note.text} /></section>
      {latest ? <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm text-muted-foreground">Сохранённый план</summary><div className="pt-4"><SavedPlan note={note} /></div></details> : <SavedPlan note={note} />}
      {partials === null && <p className="text-sm text-muted-foreground" role="status">Сведения о частичном результате недоступны. Его наличие и актуальность неизвестны.</p>}
      {latest && <PartialResultBlock item={latest} noteId={noteId} />}
      {partials && partials.length > 1 && <details className="space-y-3"><summary className="cursor-pointer text-sm text-muted-foreground">Предыдущие результаты · {partials.length - 1}</summary><div className="space-y-3 pt-3">{partials.slice(1).map(item => <PartialResultBlock key={item.id} item={item} noteId={noteId} />)}</div></details>}
      {note.results.truncated && <p className="text-xs text-muted-foreground">История результатов показана не полностью.</p>}
      <p className="border-t border-border pt-4 text-xs text-muted-foreground">Частичный результат и проверка файла не подтверждают приёмку всей цели.</p>
    </>}
  </main>;
}

function InputArtifactPage({ noteId, resultId }: { noteId: string; resultId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<InputArtifactResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getInputArtifact", { noteId, resultId }).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, noteId, resultId, revision]);
  const artifact = result?.state === "available" && result.data.noteId === noteId && result.data.resultId === resultId ? result.data : null;
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8"><header className="flex flex-wrap justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "input/" + noteId })}>← К поручению</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header><h1 className="text-xl font-semibold">Полученное исследование</h1>{result === null && !failed && <p className="text-sm text-muted-foreground" role="status">Читаем сохранённый файл…</p>}{failed || result !== null && !artifact ? <p className="text-sm text-muted-foreground" role="status">Полученный файл прочитать не удалось. Его содержание не подтверждено этим чтением.</p> : null}{artifact && <>
    {(artifact.noteCurrent !== true || artifact.candidateCurrent !== true) && <p className="text-sm text-muted-foreground">{artifact.noteCurrent === false || artifact.candidateCurrent === false ? "Исторический файл по прежним условиям." : "Связь файла с текущими условиями не подтверждена."}</p>}
    <section className="space-y-2"><h2 className="text-base font-semibold">Итог по переданным материалам</h2><ReportBody text={artifact.content.summary} /><p className="text-xs text-muted-foreground">Итог относится к переданному пакету материалов. Это выводы исследования, а не текущий статус системы.</p></section>
    <section className="space-y-3"><h2 className="text-base font-semibold">Выводы</h2><ol className="list-decimal space-y-3 pl-5">{artifact.content.findings.map((finding, index) => <li key={index}><ReportBody text={finding.claim} /></li>)}</ol></section>
    {artifact.content.recommendations.length > 0 && <section className="space-y-3"><h2 className="text-base font-semibold">Предложенные действия</h2><ol className="list-decimal space-y-3 pl-5">{artifact.content.recommendations.map((text, index) => <li key={index}><ReportBody text={text} /></li>)}</ol></section>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Ограничения · {artifact.content.limitations.length}</summary><ul className="list-disc space-y-3 pl-5 pt-3">{artifact.content.limitations.map((text, index) => <li key={index}><ReportBody text={text} /></li>)}</ul></details>
    <footer className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground"><p>Проверка файла: {fileReviewText(artifact.review, artifact.noteCurrent === true && artifact.candidateCurrent === true)}</p><p>Контрольная сумма файла сверена. Достоверность выводов и приёмка всей цели остаются отдельными.</p></footer>
  </>}</main>;
}

function TaskChatAction({ task }: { task: Task }) {
  const taskId = task.id;
  const rpc = useRpc<PersonalOsContract>();
  const [result, setResult] = useState<TaskChatResult | null>(null);
  const [outcome, setOutcome] = useState<OpenTaskChatResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [bindingRevision, setBindingRevision] = useState(0);
  const openingRef = useRef(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getTaskChat", { taskId }).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, taskId, bindingRevision]);
  const data = result?.state === "available" && result.data.task_id === taskId ? result.data : null;
  const taskMatches = data !== null && data.mission_id === task.mission_id && data.task_version === task.version;
  const linkVersion = taskMatches && data?.can_open && data.link ? data.link.version : null;
  const sourceNote = data && linkVersion !== null ? [data.target.freshness === "stale" ? "Связь найдена в прежнем снимке." : data.target.freshness === "unknown" ? "Свежесть источника связи неизвестна." : "", data.target.in_current_scope === false ? "Чат не входит в текущий снимок." : data.target.in_current_scope === null ? "Наличие чата в текущем снимке не подтверждено." : ""].filter(Boolean).join(" ") : "";
  const open = async () => {
    if (openingRef.current || linkVersion === null) return;
    openingRef.current = true;
    setOpening(true);
    setFailed(false);
    setOutcome(null);
    try {
      const next = await rpc.call("openTaskChat", { taskId, expectedLinkVersion: linkVersion });
      setOutcome(next);
      if (next.state === "unavailable" && ["link_unavailable", "link_changed", "task_not_current", "context_not_current", "target_unavailable"].includes(next.reason)) {
        setResult(null);
        setBindingRevision(value => value + 1);
      }
    }
    catch { setOutcome({ state: "unavailable", observedAt: new Date().toISOString(), reason: "open_outcome_unknown" }); }
    finally { openingRef.current = false; setOpening(false); }
  };
  return <section className="space-y-2" aria-label="Связанный чат">{linkVersion !== null ? <Button type="button" variant="outline" size="sm" disabled={opening} onClick={() => void open()}>{opening ? "Запрашиваем открытие…" : "Открыть исходный чат в Codex ↗"}</Button> : <p className="text-xs text-muted-foreground">{result === null && !failed ? "Проверяем связь с чатом…" : data && !taskMatches ? "Обновите данные задачи." : data?.state === "unlinked" ? "Связанный чат не указан." : "Связь с исходным чатом не подтверждена."}</p>}{sourceNote && <p className="text-xs text-muted-foreground">{sourceNote}</p>}{outcome && <p className="text-xs text-muted-foreground" role="status">{outcome.state === "open_requested" ? "Запрошено открытие исходного чата. Переход в нужное окно ещё не подтверждён." : outcome.reason === "host_changed" ? "Настроены разные Mac для цели и исходного чата. Открытие заблокировано." : outcome.reason === "open_outcome_unknown" ? "Исход запроса открытия неизвестен. Проверьте Codex перед повтором." : "Исходный чат открыть не удалось. Связь или доступ изменились."}</p>}{failed && <p className="text-xs text-muted-foreground" role="status">Связь с исходным чатом прочитать не удалось.</p>}</section>;
}

const activityMatchesTask = (activity: TaskActivityItem, task: Task) => activity.task.id === task.id && activity.task.mission_id === task.mission_id && activity.task.version === task.version && activity.task.context_current === task.context_current;
const currentExecution = (binding: TaskExecutionBinding) => binding.currentness === "current" && binding.task_version_current === true && binding.task_context_current === true;
const executionPhaseLabels: Record<string, string> = {
  prepared: "Попытка подготовлена", submission_pending: "Передача ожидается", launch_intent: "Запрос запуска сохранён", observing: "Ожидается результат", reconciling: "Нужна сверка",
  control_requested: "Запрос управления сохранён", artifact_received: "Получение файла записано", verification_pending: "Файл передан к проверке", failed: "Попытка завершилась ошибкой", fenced: "Продолжение заблокировано", stopped: "Остановка записана",
};
function taskReviewLabel(review: TaskExecutionBinding["review"], current: boolean, short = false): string {
  if (review.state === "not_registered") return "Проверка не зарегистрирована";
  if (review.state === "unavailable" || review.state === "error") return "Сведения о проверке недоступны";
  if (review.state === "available" && review.review_id !== null && review.outcome !== null) {
    if (!current || review.candidate_current !== true || review.applicable !== true) return "Актуальность проверки не подтверждена";
    if (review.outcome === "no_blocking_findings") return short ? "Проверка файла сохранена" : "По выбранным требованиям блокирующих замечаний не найдено";
    if (review.outcome === "changes_required") return short ? "Нужны исправления" : "По выбранным требованиям нужны исправления";
    if (review.outcome === "inconclusive") return short ? "Проверка без вывода" : "Для вывода по выбранным требованиям недостаточно данных";
    return "Итог проверки неизвестен";
  }
  if (review.run_phase === "recorded") return "Сохранённый итог проверки не подтверждён";
  if (["failed", "uncertain", "blocked", "stale"].includes(review.run_phase ?? "")) return "Проверка не получена";
  return review.state === "enabled" && review.run_phase === null ? "Проверка включена" : "Ожидается результат проверки";
}

function taskActivityLabel(activity: TaskActivityItem | null, task: Task, hideEmpty = false): string | null {
  if (!activity) return "Нет данных об исполнении";
  if (!activityMatchesTask(activity, task)) return "Обновите данные задачи";
  if (activity.bindings.state !== "available" && !(activity.bindings.state === "not_registered" && activity.bindings.items.length === 0 && activity.bindings.total_count === 0 && !activity.bindings.truncated)) return "Нет данных об исполнении";
  const policies = activity.dispatchers.state === "available" ? activity.dispatchers.items.filter(item => item.task_id === task.id && item.bound_task_version === task.version && item.task_version_current) : [];
  const current = activity.bindings.items.find(currentExecution);
  if (current) {
    if (current.binding_state === "fenced") return "Продолжение заблокировано";
    if (current.review.state === "available" && current.review.review_id !== null && current.review.outcome !== null && current.review.candidate_current === true && current.review.applicable === true) return taskReviewLabel(current.review, true, true);
    if (current.artifact.state === "received" && current.artifact.receipt) return "Получение файла записано";
    if (current.artifact.state === "error") return "Файл не подтверждён";
    return executionPhaseLabels[current.continuation.phase] ?? "Фаза исполнения неизвестна";
  }
  if (policies.some(item => item.current_error_code !== null)) return "Автозапуск требует внимания";
  if (policies.length) return "Настройка автозапуска сохранена";
  if (activity.bindings.items.length > 0) return activity.bindings.items.some(binding => binding.currentness === "historical") ? "Есть прежняя попытка" : "Актуальность попытки неизвестна";
  if (activity.bindings.total_count !== 0 || activity.bindings.truncated) return "Нет данных об исполнении";
  return ["available", "not_registered"].includes(activity.dispatchers.state) && activity.dispatchers.total_count === 0 && !activity.dispatchers.truncated ? hideEmpty ? null : "Запуск не зарегистрирован" : "Нет данных об исполнении";
}

function TaskActivityBadge({ activity, task }: { activity: TaskActivityItem | null; task: Task }) {
  const label = taskActivityLabel(activity, task, true);
  return label ? <span className="text-xs text-muted-foreground">{label}</span> : null;
}

function ExecutionStages({ binding, task }: { binding: TaskExecutionBinding; task: Task }) {
  const navigate = useBbNavigate();
  const hasReceipt = binding.artifact.state === "received" && binding.artifact.receipt !== null;
  const fileLabel = hasReceipt ? "Получение записано; файл ещё не перечитан" : binding.artifact.state === "not_received" ? "Файл не получен" : "Сведения о файле недоступны";
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4"><div className="grid gap-4 sm:grid-cols-3"><div className="space-y-1"><h3 className="text-xs text-muted-foreground">Исполнение</h3><p className="text-sm">{executionPhaseLabels[binding.continuation.phase] ?? "Фаза неизвестна"}</p></div><div className="space-y-2"><h3 className="text-xs text-muted-foreground">Файл</h3><p className="text-sm">{fileLabel}</p>{hasReceipt && <Button type="button" variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + task.mission_id + "/task/" + task.id + "/result/" + binding.id })}>Проверить и прочитать →</Button>}</div><div className="space-y-1"><h3 className="text-xs text-muted-foreground">Проверка файла</h3><p className="text-sm">{taskReviewLabel(binding.review, currentExecution(binding))}</p></div></div>{binding.input_result.state === "attached" && binding.input_result.note_id && <Button type="button" variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "input/" + binding.input_result.note_id })}>Результат добавлен в поручение →</Button>}<p className="text-xs text-muted-foreground">Сохранённые этапы попытки. Они не подтверждают работу процесса сейчас или приёмку цели.</p></section>;
}

type CompletionItem = TaskActivityItem["completion"]["items"][number];
function CompletionEvidence({ items, missionId, taskId, contextCurrent, showFiles = true }: { items: CompletionItem[]; missionId: string; taskId: string; contextCurrent: boolean | null; showFiles?: boolean }) {
  const navigate = useBbNavigate();
  const files = new Map<string, NonNullable<CompletionItem["artifact"]>>();
  const reviews = new Map<string, NonNullable<CompletionItem["review"]>>();
  let recordedOnly = 0;
  let unavailable = 0;
  for (const item of items) {
    if (item.state === "recorded_only") { recordedOnly += 1; continue; }
    if (item.state !== "resolved") { unavailable += 1; continue; }
    if (item.artifact) files.set(item.artifact.binding_id, item.artifact);
    if (item.kind === "consumer_review" && item.review) reviews.set(item.review.id, item.review);
    if (item.kind === "recorded_source") recordedOnly += 1;
    if (item.kind === "artifact" && !item.artifact || item.kind === "consumer_review" && !item.review) unavailable += 1;
  }
  const outcomes = { no_blocking_findings: "По выбранным требованиям блокирующих замечаний не найдено", changes_required: "По выбранным требованиям нужны исправления", inconclusive: "Для вывода по выбранным требованиям недостаточно данных" };
  return <div className="space-y-3">
    {showFiles && [...files.values()].map(file => <div key={file.binding_id} className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-1"><p className="text-sm font-medium">Полученный файл исследования</p><p className="text-xs text-muted-foreground">{file.currentness === "historical" ? "Из прежней попытки" : file.currentness === "current" ? "Из попытки по текущим условиям" : "Актуальность попытки неизвестна"}</p></div><Button type="button" variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + missionId + "/task/" + taskId + "/result/" + file.binding_id })}>Проверить и прочитать →</Button></div>)}
    {[...reviews.values()].map(review => {
      const applicable = contextCurrent === true && review.candidate_current === true && review.applicable === true;
      return <section key={review.id} className="space-y-1"><h4 className="text-sm font-medium">Проверка, указанная при завершении</h4><p className="text-sm">{applicable ? outcomes[review.outcome] : "Записанный вывод: " + outcomes[review.outcome]}</p>{!applicable && <p className="text-xs text-muted-foreground">{review.applicable_at_recording ? "Когда проверку сохранили, она была применима. Текущая применимость не подтверждена." : "Применимость проверки к текущим условиям не подтверждена."}</p>}</section>;
    })}
    {recordedOnly > 0 && <p className="text-xs text-muted-foreground">Сохранено источников без проверки содержимого в этой проекции: {recordedOnly}.</p>}
    {unavailable > 0 && <p className="text-xs text-muted-foreground" role="status">Часть записанных оснований прочитать не удалось.</p>}
  </div>;
}

function CompletionGrounds({ completion, task }: { completion: TaskActivityItem["completion"]; task: Task }) {
  if (task.state !== "done") return null;
  const matches = completion.task_version === task.version && completion.context_current === task.context_current;
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Основания завершения"><h3 className="text-base font-semibold">Основания отметки «Готово»</h3>{!matches ? <p className="text-sm text-muted-foreground">Обновите данные задачи.</p> : completion.state !== "recorded" ? <p className="text-sm text-muted-foreground">Сведения об основаниях прочитать не удалось.</p> : <>
    {task.completion_current !== true && <p className="text-xs text-muted-foreground">Актуальность отметки завершения при текущих условиях не подтверждена.</p>}
    {completion.items.length > 0 ? <CompletionEvidence items={completion.items} missionId={task.mission_id} taskId={task.id} contextCurrent={completion.context_current} /> : <p className="text-sm text-muted-foreground">В проекции нет читаемых оснований этой отметки.</p>}
    <p className="text-xs text-muted-foreground">Это сохранённые основания отметки. Приёмка всей цели остаётся отдельной.</p>
  </>}</section>;
}

function TaskActivity({ task, refreshNonce }: { task: Task; refreshNonce: number }) {
  const rpc = useRpc<PersonalOsContract>();
  const [result, setResult] = useState<TaskActivityResult | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getTaskActivity", { taskId: task.id }).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, task.id, task.version, refreshNonce]);
  const response = result?.state === "available" && result.data.state === "available" ? result.data : null;
  const scopeMatches = response !== null && response.scope === "task" && response.task_id === task.id && response.mission_id === task.mission_id;
  const activity = response && scopeMatches && response.items.length === 1 ? response.items[0] : null;
  const mismatch = response && (!scopeMatches || !activity || !activityMatchesTask(activity, task));
  const current = activity?.bindings.state === "available" ? activity.bindings.items.find(currentExecution) : null;
  const history = activity?.bindings.state === "available" ? activity.bindings.items.filter(binding => binding !== current) : [];
  return <section className="space-y-3" aria-label="Исполнение задачи"><h3 className="text-base font-semibold">Исполнение задачи</h3>{result === null && !failed ? <p className="text-sm text-muted-foreground" role="status">Читаем сохранённые этапы…</p> : mismatch ? <p className="text-sm text-muted-foreground" role="status">Обновите данные задачи.</p> : !activity ? <p className="text-sm text-muted-foreground" role="status">Нет данных об исполнении.</p> : <>
    <CompletionGrounds completion={activity.completion} task={task} />
    {current ? <ExecutionStages binding={current} task={task} /> : <p className="text-sm text-muted-foreground">{taskActivityLabel(activity, task)}</p>}
    {activity.dispatchers.state === "available" && activity.dispatchers.items.some(item => item.task_id === task.id && item.bound_task_version === task.version && item.task_version_current && item.current_error_code !== null) && <p className="text-xs text-muted-foreground">В текущей настройке автозапуска есть ошибка. Сохранённые этапы попытки показаны отдельно.</p>}
    {history.length > 0 && <details><summary className="cursor-pointer text-sm text-muted-foreground">Другие попытки · {history.length}</summary><div className="space-y-3 pt-3">{history.map((binding, index) => <div key={binding.id} className="space-y-2"><p className="text-xs text-muted-foreground">Попытка {index + 1} · {currentExecution(binding) ? "По текущим условиям" : binding.task_context_current === false ? "По прежним условиям" : binding.task_version_current === false ? "Из прежней версии задачи" : binding.currentness === "historical" ? "Прежняя попытка" : "Актуальность неизвестна"}</p><ExecutionStages binding={binding} task={task} /></div>)}</div></details>}
    {activity.bindings.truncated && <p className="text-xs text-muted-foreground">История попыток показана не полностью.</p>}
    {activity.dispatchers.state === "available" && activity.dispatchers.items.some(item => item.last_error !== null) && <details><summary className="cursor-pointer text-xs text-muted-foreground">Прежние ошибки автозапуска</summary><p className="pt-2 text-xs text-muted-foreground">В истории сохранены ошибки. Они не подменяют текущую фазу попытки.</p></details>}
  </>}</section>;
}

function TaskResultPage({ missionId, taskId, bindingId }: { missionId: string; taskId: string; bindingId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<TaskResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getTaskResult", { taskId, bindingId }).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, taskId, bindingId, revision]);
  const artifact = result?.state === "available" && result.data.taskId === taskId && result.data.bindingId === bindingId && result.data.missionId === missionId ? result.data : null;
  const current = artifact?.currentness === "current" && artifact.taskVersionCurrent === true && artifact.taskContextCurrent === true;
  const historicalReview = artifact?.currentness === "historical" && artifact.completionEvidence?.contextCurrent === true && artifact.completionEvidence.items.some(item => item.state === "resolved" && item.kind === "consumer_review" && item.artifact?.binding_id === bindingId && item.review?.candidate_current === true && item.review.applicable === true);
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8"><header className="flex flex-wrap justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => artifact ? navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + missionId + "/task/" + taskId }) : navigate.toPluginPanel(PANEL_PATH)}>{artifact ? "← К задаче" : "← Все цели"}</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header><h1 className="text-xl font-semibold">Полученное исследование задачи</h1>{result === null && !failed && <p className="text-sm text-muted-foreground" role="status">Проверяем и читаем сохранённый файл…</p>}{failed || result !== null && !artifact ? <p className="text-sm text-muted-foreground" role="status">Файл прочитать не удалось. Его содержание не подтверждено этим чтением.</p> : null}{artifact && <>
    {!current && <p className="text-sm text-muted-foreground">{artifact.taskContextCurrent === false ? "Результат попытки по прежним условиям." : artifact.taskVersionCurrent === false ? "Результат из прежней версии задачи." : artifact.currentness === "historical" ? "Результат прежней попытки." : "Связь результата с текущими условиями не подтверждена."}</p>}
    {artifact.completionEvidence && <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Основания завершения"><h2 className="text-base font-semibold">Основания отметки «Готово»</h2><p className="text-sm">Этот файл указан среди сохранённых оснований завершения задачи.</p><CompletionEvidence items={artifact.completionEvidence.items} missionId={missionId} taskId={taskId} contextCurrent={artifact.completionEvidence.contextCurrent} showFiles={false} /><p className="text-xs text-muted-foreground">Приёмка всей цели остаётся отдельной.</p></section>}
    <section className="space-y-2"><h2 className="text-base font-semibold">Итог по переданным материалам</h2><ReportBody text={artifact.content.summary} /><p className="text-xs text-muted-foreground">Выводы относятся к переданному пакету материалов, а не текущему статусу системы.</p></section>
    <section className="space-y-3"><h2 className="text-base font-semibold">Выводы</h2><ol className="list-decimal space-y-3 pl-5">{artifact.content.findings.map((finding, index) => <li key={index}><ReportBody text={finding.claim} /></li>)}</ol></section>
    {artifact.content.recommendations.length > 0 && <section className="space-y-3"><h2 className="text-base font-semibold">Предложенные действия</h2><ol className="list-decimal space-y-3 pl-5">{artifact.content.recommendations.map((text, index) => <li key={index}><ReportBody text={text} /></li>)}</ol></section>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Ограничения · {artifact.content.limitations.length}</summary><ul className="list-disc space-y-3 pl-5 pt-3">{artifact.content.limitations.map((text, index) => <li key={index}><ReportBody text={text} /></li>)}</ul></details>
    <footer className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">{historicalReview ? <details><summary className="cursor-pointer">История попытки</summary><p className="pt-2">Проверка, связанная с попыткой: {taskReviewLabel(artifact.review, current)}.</p></details> : <p>Проверка, связанная с попыткой: {taskReviewLabel(artifact.review, current)}.</p>}<p>Контрольная сумма файла сверена. Это не подтверждает приёмку задачи или всей цели.</p></footer>
  </>}</main>;
}

function taskCardBody(task: Task) {
  if (task.state === "done") return task.expected_result;
  if (task.state === "blocked") return task.blocker;
  return task.next_action;
}

function MissionList({ onCompose, composeLabel, composerId }: { onCompose: () => void; composeLabel: string; composerId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<MissionsResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("listMissions", null).then(value => { if (active) setResult(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, revision]);
  const missions = result?.state === "available" ? [...result.data.missions].sort((a, b) => Number(b.state === "active") - Number(a.state === "active")) : null;
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs text-muted-foreground">Личное управление</p><h1 className="text-2xl font-semibold tracking-tight">Цели</h1></div><div className="flex flex-wrap gap-2"><Button size="sm" aria-controls={composerId} onClick={onCompose}>{composeLabel}</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></div></header>
    {result === null && !failed ? <p className="text-sm text-muted-foreground" role="status">Читаем Personal OS…</p> : failed || result?.state === "unavailable" ? <Unavailable result={result?.state === "unavailable" ? result : null} /> : null}
    {missions && <section className="grid gap-3 md:grid-cols-2" aria-label="Цели Personal OS">{missions.map(mission => <button type="button" key={mission.id} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + mission.id })} className="flex cursor-pointer flex-col items-start gap-3 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="text-xs text-muted-foreground">{missionLabels[mission.state] ?? "Статус: " + mission.state}</span><h2 className="text-lg font-medium">{mission.title}</h2><span className="line-clamp-2 text-sm text-muted-foreground">{mission.next_action?.text ?? "Следующий шаг не указан"}</span><span className="mt-auto text-xs font-medium">Открыть задачи →</span>
    </button>)}{missions.length === 0 && <p className="text-sm text-muted-foreground">Сохранённых целей нет.</p>}</section>}
    <footer className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>Цели и их приёмка — в Personal OS</span>{result?.state === "available" && <ReadTime value={result.observedAt} />}</footer>
  </main>;
}

function TaskDetail({ task, refreshNonce }: { task: Task; refreshNonce: number }) {
  return <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-lg border border-border bg-card p-5 md:p-7">
    <header className="space-y-2"><p className="text-xs text-muted-foreground">{task.state === "done" && task.completion_current !== true ? "Завершена по прежним условиям" : columns.find(column => column.state === task.state)?.title}{task.owner_label ? " · " + task.owner_label : task.state === "doing" ? " · Исполнитель не указан" : ""}</p><h2 className="text-xl font-semibold tracking-tight">{task.title}</h2></header>
    {task.context_current !== true && <p className="rounded-md border border-border p-3 text-sm">Актуальность задачи при текущих условиях не подтверждена.</p>}
    <TaskActivity key={"task-activity:" + task.id} task={task} refreshNonce={refreshNonce} />
    {task.expected_result && <section className="space-y-2"><h3 className="text-sm font-medium">Нужный результат</h3><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{task.expected_result}</p></section>}
    {task.blocker && <section className="space-y-2"><h3 className="text-sm font-medium">Что мешает</h3><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{task.blocker}</p></section>}
    {task.next_action && <section className="space-y-2"><h3 className="text-sm font-medium">{task.state === "done" ? "Сохранённый следующий шаг" : "Следующий шаг"}</h3><p className="whitespace-pre-wrap break-words text-sm">{task.next_action}</p></section>}
    <TaskChatAction key={"task-chat:" + task.id} task={task} />
    <div className="border-t border-border pt-4 text-xs text-muted-foreground">{task.state === "done" && task.completion_current === true ? "Завершена эта задача. Приёмка всей цели остаётся отдельной." : "Статус задачи не подтверждает работу агента или приёмку цели."} Записано оснований: {task.evidenceCount}.</div>
    {(task.applied_skills.length > 0 || task.recommended_skills.length > 0) && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Скиллы</summary><div className="space-y-3 pt-3">{task.applied_skills.length > 0 && <p>Применены по отчёту: {task.applied_skills.join(", ")}</p>}{task.recommended_skills.length > 0 && <p>Рекомендуются: {task.recommended_skills.join(", ")}</p>}</div></details>}
  </article>;
}

function MissionBoard({ missionId, taskId, onCompose, composeLabel, composerId }: { missionId: string; taskId: string | null; onCompose: () => void; composeLabel: string; composerId: string }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [mission, setMission] = useState<MissionResult | null>(null);
  const [tasks, setTasks] = useState<TasksResult | null>(null);
  const [activity, setActivity] = useState<MissionActivityResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [doneExpanded, setDoneExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    setMission(null);
    setTasks(null);
    setFailed(false);
    void Promise.all([rpc.call("getMission", { missionId }), rpc.call("listTasks", { missionId })]).then(([nextMission, nextTasks]) => {
      if (active) { setMission(nextMission); setTasks(nextTasks); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, missionId, revision]);
  useEffect(() => {
    let active = true;
    setActivity(null);
    if (!taskId) void rpc.call("getMissionActivity", { missionId }).then(value => { if (active) setActivity(value); }).catch(() => { if (active) setActivity(null); });
    return () => { active = false; };
  }, [rpc, missionId, revision, !!taskId]);
  const go = (id: string | null) => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + missionId + (id ? "/task/" + id : "") });
  const board = tasks?.state === "available" && tasks.data.state === "available" ? tasks.data : null;
  const activityData = activity?.state === "available" && activity.data.state === "available" && activity.data.scope === "mission" && activity.data.mission_id === missionId && activity.data.task_id === null ? activity.data : null;
  const historicalTasks = board?.items.filter(task => task.state === "done" && task.completion_current !== true) ?? [];
  const selectedTask = taskId && board ? board.items.find(task => task.id === taskId) : null;
  return <main className="flex shrink-0 flex-col gap-4 p-4 md:p-6">
    {taskId ? <>
      <header className="flex flex-wrap items-center justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => go(null)}>← К задачам</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header>
      {mission?.state === "available" && <section className="space-y-2"><p className="text-xs text-muted-foreground">{missionLabels[mission.data.state] ?? "Статус: " + mission.data.state}</p><h1 className="text-2xl font-semibold tracking-tight">{mission.data.title}</h1></section>}
    </> : <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1 space-y-1">{mission?.state === "available" ? <><p className="text-xs text-muted-foreground">{missionLabels[mission.data.state] ?? "Статус: " + mission.data.state}</p><h1 className="text-xl font-semibold tracking-tight">{mission.data.title}</h1>{mission.data.next_action?.text && <p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground"><span className="font-medium text-foreground">Дальше: </span>{mission.data.next_action.text}</p>}</> : <h1 className="text-xl font-semibold tracking-tight">Задачи цели</h1>}</div><div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>Все цели</Button><Button size="sm" aria-controls={composerId} onClick={onCompose}>{composeLabel}</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></div></header>}
    {mission === null && !failed && <p className="text-sm text-muted-foreground" role="status">Читаем цель и задачи…</p>}
    {failed && <Unavailable result={null} />}
    {mission?.state === "unavailable" && <Unavailable result={mission} />}
    {tasks?.state === "unavailable" && <Unavailable result={tasks} />}
    {tasks?.state === "available" && tasks.data.state !== "available" && <p className="rounded-lg border border-border p-5 text-sm text-muted-foreground" role="status">Список задач недоступен. Количество и состояние неизвестны.</p>}
    {board && taskId && (selectedTask ? <TaskDetail task={selectedTask} refreshNonce={revision} /> : <p className="text-sm text-muted-foreground">Задачи нет в полученном списке.{board.truncated ? " Список неполный." : ""}</p>)}
    {board && !taskId && <><div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">{columns.map(column => {
      const items = board.items.filter(task => task.state === column.state && (task.state !== "done" || task.completion_current === true));
      const count = column.state === "done" ? board.current_done_count : board.counts?.[column.state];
      const compact = column.state === "done" && !doneExpanded && items.length > 3;
      const visibleItems = compact ? items.slice(-3) : items;
      const completeDoneList = !board.truncated && count !== null && count === items.length;
      return <section key={column.state} className="min-w-0 rounded-lg bg-secondary/40 p-3" aria-label={column.title}><header className="mb-3 flex items-center justify-between gap-2 px-1"><h2 className="text-sm font-medium">{column.title}</h2><span className="text-xs tabular-nums text-muted-foreground">{count ?? "?"}</span></header><div className="space-y-2">{visibleItems.map(task => <button type="button" key={task.id} onClick={() => go(task.id)} className="flex w-full cursor-pointer flex-col gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="line-clamp-2 text-sm font-medium">{task.title}</span>{taskCardBody(task) && <span className="line-clamp-2 text-xs text-muted-foreground">{taskCardBody(task)}</span>}{(task.owner_label || task.state === "doing") && <span className="text-xs text-muted-foreground">{task.owner_label ?? "Исполнитель не указан"}</span>}{task.context_current !== true && <span className="text-xs text-muted-foreground">Актуальность не подтверждена</span>}<TaskActivityBadge activity={activityData?.items.find(item => item.task.id === task.id) ?? null} task={task} /></button>)}{items.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground">{board.truncated ? "Нет в полученной части" : "Нет задач"}</p>}</div>{column.state === "done" && items.length > 3 && <div className="space-y-1 pt-3"><p className="px-1 text-xs text-muted-foreground">{visibleItems.length} из {count ?? "неизвестного количества"}{!completeDoneList ? " · полученная часть" : ""}</p><Button type="button" variant="ghost" size="sm" aria-expanded={doneExpanded} onClick={() => setDoneExpanded(value => !value)}>{doneExpanded ? "Свернуть" : (completeDoneList ? "Показать все · " : "Показать полученные · ") + items.length}</Button></div>}</section>;
    })}</div>{board.truncated && <p className="text-xs text-muted-foreground">Показана ограниченная часть списка. Счётчики относятся ко всей цели.</p>}{(historicalTasks.length > 0 || (board.historical_done_count !== null && board.historical_done_count > 0)) && <details className="rounded-lg border border-border p-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Завершено по прежним условиям · {board.historical_done_count ?? "Количество неизвестно"}</summary><div className="flex flex-col items-start gap-2 pt-3"><p className="text-xs text-muted-foreground">Эти результаты не входят в текущее «Готово».</p>{historicalTasks.map(task => <Button key={task.id} variant="ghost" className="h-auto max-w-full whitespace-normal text-left" onClick={() => go(task.id)}>{task.title} →</Button>)}{board.truncated && <p className="text-xs text-muted-foreground">В истории показаны только задачи из полученной части списка.</p>}</div></details>}</>}
    {mission?.state === "available" && !taskId && <details className="max-w-3xl text-sm"><summary className="cursor-pointer text-muted-foreground">Исходная цель</summary><p className="whitespace-pre-wrap break-words pt-3 text-muted-foreground">{mission.data.objective}</p></details>}
    <footer className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>Сохранённые статусы задач, не работа процессов</span>{tasks?.state === "available" && <ReadTime value={tasks.observedAt} />}</footer>
  </main>;
}

function PersonalOsPanel({ subPath }: { subPath: string }) {
  const [inputRevision, setInputRevision] = useState(0);
  const [composeLabel, setComposeLabel] = useState("+ Поручение");
  const [openRequest, setOpenRequest] = useState(0);
  const composerId = useId();
  const onCompose = () => setOpenRequest(value => value + 1);
  const match = /^mission\/(mission_[a-f0-9]{32})(?:\/task\/(task_[a-f0-9]{32})(?:\/result\/(task_execution_[a-f0-9]{32}))?)?$/.exec(subPath);
  const inputMatch = /^input\/(note_[a-f0-9]{32})(?:\/result\/(input_result_[a-f0-9]{32}))?$/.exec(subPath);
  const overview = !subPath || !!match && !match[2];
  return <div className="min-h-0 flex-1 overflow-y-auto">
    {!subPath ? <MissionList key="mission-list" onCompose={onCompose} composeLabel={composeLabel} composerId={composerId} /> : match ? match[2] && match[3] ? <TaskResultPage key={"task-artifact:" + match[1] + ":" + match[2] + ":" + match[3]} missionId={match[1]} taskId={match[2]} bindingId={match[3]} /> : <MissionBoard key={"mission-board:" + match[1]} missionId={match[1]} taskId={match[2] ?? null} onCompose={onCompose} composeLabel={composeLabel} composerId={composerId} /> : inputMatch ? inputMatch[2] ? <InputArtifactPage key={"input-artifact:" + inputMatch[1] + ":" + inputMatch[2]} noteId={inputMatch[1]} resultId={inputMatch[2]} /> : <InputPage key={"input-detail:" + inputMatch[1]} noteId={inputMatch[1]} /> : <div key="unsupported-route" className="p-6 text-sm">Этот адрес Personal OS не поддерживается.</div>}
    <div key="owner-composer" hidden={!overview} className="px-4 pb-4 md:px-6"><InputComposer missionId={match?.[1] ?? null} onSaved={() => setInputRevision(value => value + 1)} onStatus={setComposeLabel} openRequest={openRequest} composerId={composerId} /></div>
    {overview && <div key={"recent-inputs:" + (match?.[1] ?? "personal")} className="px-4 pb-6 md:px-6"><details className="mx-auto w-full max-w-5xl rounded-lg border border-border"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">Мои поручения и результаты</summary><InputList key={"input-list:" + (match?.[1] ?? "personal")} missionId={match?.[1] ?? null} refreshRevision={inputRevision} /></details></div>}
  </div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "personal-os", title: "Personal OS", icon: "LayoutDashboard", path: PANEL_PATH, component: PersonalOsPanel });
});
