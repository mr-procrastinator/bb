import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { definePluginApp, experimental_usePluginId, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { z } from "zod";
import { submitInputSchema, type Mission, type MissionResult, type MissionsResult, type PersonalOsContract, type SubmitInput, type SubmissionLookupResult, type Task, type TasksResult } from "./contract.js";

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

function InputComposer({ missionId }: { missionId: string | null }) {
  const rpc = useRpc<PersonalOsContract>();
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
  const availableMission = mission && mission.id === missionId && !["completed", "cancelled"].includes(mission.state) ? mission : null;
  const selectedMission = draft.target.scope === "mission";
  const sameMission = draft.target.scope === "mission" && availableMission?.id === draft.target.missionId;
  const staleTarget = sameMission && draft.target.scope === "mission" && availableMission?.version !== draft.target.expectedMissionVersion;
  return <section className="mx-auto w-full max-w-5xl px-4 pt-4 md:px-8 md:pt-8" aria-label="Новое поручение">
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-card p-4">
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
    </form>
  </section>;
}

function Unavailable({ result }: { result: { reason: keyof typeof unavailableLabels } | null }) {
  return <div className="rounded-lg border border-border p-5 text-sm text-muted-foreground" role="status">{result ? unavailableLabels[result.reason] : "Не удалось прочитать данные. Статусы неизвестны."}</div>;
}

function ReadTime({ value }: { value: string }) {
  return <span className="text-xs text-muted-foreground">Прочитано {new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

function taskCardBody(task: Task) {
  if (task.state === "done") return task.expected_result;
  if (task.state === "blocked") return task.blocker;
  return task.next_action;
}

function MissionList() {
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
    <header className="flex items-center justify-between gap-4"><div><p className="text-xs text-muted-foreground">Личное управление</p><h1 className="text-2xl font-semibold tracking-tight">Цели</h1></div><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header>
    {result === null && !failed ? <p className="text-sm text-muted-foreground" role="status">Читаем Personal OS…</p> : failed || result?.state === "unavailable" ? <Unavailable result={result?.state === "unavailable" ? result : null} /> : null}
    {missions && <section className="grid gap-3 md:grid-cols-2" aria-label="Цели Personal OS">{missions.map(mission => <button type="button" key={mission.id} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + mission.id })} className="flex cursor-pointer flex-col items-start gap-3 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="text-xs text-muted-foreground">{missionLabels[mission.state] ?? "Статус: " + mission.state}</span><h2 className="text-lg font-medium">{mission.title}</h2><span className="line-clamp-2 text-sm text-muted-foreground">{mission.next_action?.text ?? "Следующий шаг не указан"}</span><span className="mt-auto text-xs font-medium">Открыть задачи →</span>
    </button>)}{missions.length === 0 && <p className="text-sm text-muted-foreground">Сохранённых целей нет.</p>}</section>}
    <footer className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>Цели и их приёмка — в Personal OS</span>{result?.state === "available" && <ReadTime value={result.observedAt} />}</footer>
  </main>;
}

function TaskDetail({ task }: { task: Task }) {
  return <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-lg border border-border bg-card p-5 md:p-7">
    <header className="space-y-2"><p className="text-xs text-muted-foreground">{task.state === "done" && task.completion_current !== true ? "Завершена по прежним условиям" : columns.find(column => column.state === task.state)?.title}{task.owner_label ? " · " + task.owner_label : task.state === "doing" ? " · Исполнитель не указан" : ""}</p><h2 className="text-xl font-semibold tracking-tight">{task.title}</h2></header>
    {task.context_current !== true && <p className="rounded-md border border-border p-3 text-sm">Актуальность задачи при текущих условиях не подтверждена.</p>}
    {task.expected_result && <section className="space-y-2"><h3 className="text-sm font-medium">Нужный результат</h3><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{task.expected_result}</p></section>}
    {task.blocker && <section className="space-y-2"><h3 className="text-sm font-medium">Что мешает</h3><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{task.blocker}</p></section>}
    {task.next_action && <section className="space-y-2"><h3 className="text-sm font-medium">{task.state === "done" ? "Сохранённый следующий шаг" : "Следующий шаг"}</h3><p className="whitespace-pre-wrap break-words text-sm">{task.next_action}</p></section>}
    <div className="border-t border-border pt-4 text-xs text-muted-foreground">{task.state === "done" && task.completion_current === true ? "Завершена эта задача. Приёмка всей цели остаётся отдельной." : "Статус задачи не подтверждает работу агента или приёмку цели."} Записано оснований: {task.evidenceCount}.</div>
    {(task.applied_skills.length > 0 || task.recommended_skills.length > 0) && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Скиллы</summary><div className="space-y-3 pt-3">{task.applied_skills.length > 0 && <p>Применены по отчёту: {task.applied_skills.join(", ")}</p>}{task.recommended_skills.length > 0 && <p>Рекомендуются: {task.recommended_skills.join(", ")}</p>}</div></details>}
  </article>;
}

function MissionBoard({ missionId, taskId }: { missionId: string; taskId: string | null }) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [mission, setMission] = useState<MissionResult | null>(null);
  const [tasks, setTasks] = useState<TasksResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
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
  const go = (id: string | null) => navigate.toPluginPanel(PANEL_PATH, { subPath: "mission/" + missionId + (id ? "/task/" + id : "") });
  const board = tasks?.state === "available" && tasks.data.state === "available" ? tasks.data : null;
  const historicalTasks = board?.items.filter(task => task.state === "done" && task.completion_current !== true) ?? [];
  const selectedTask = taskId && board ? board.items.find(task => task.id === taskId) : null;
  return <main className="flex min-h-0 flex-col gap-5 p-4 md:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><Button variant="ghost" size="sm" onClick={() => taskId ? go(null) : navigate.toPluginPanel(PANEL_PATH)}>← {taskId ? "К задачам" : "Все цели"}</Button><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button></header>
    {mission?.state === "available" && <section className="space-y-2"><p className="text-xs text-muted-foreground">{missionLabels[mission.data.state] ?? "Статус: " + mission.data.state}</p><h1 className="text-2xl font-semibold tracking-tight">{mission.data.title}</h1>{!taskId && mission.data.next_action?.text && <p className="line-clamp-3 max-w-3xl text-sm text-muted-foreground"><span className="font-medium text-foreground">Следующий шаг: </span>{mission.data.next_action.text}</p>}</section>}
    {mission === null && !failed && <p className="text-sm text-muted-foreground" role="status">Читаем цель и задачи…</p>}
    {failed && <Unavailable result={null} />}
    {mission?.state === "unavailable" && <Unavailable result={mission} />}
    {tasks?.state === "unavailable" && <Unavailable result={tasks} />}
    {tasks?.state === "available" && tasks.data.state !== "available" && <p className="rounded-lg border border-border p-5 text-sm text-muted-foreground" role="status">Список задач недоступен. Количество и состояние неизвестны.</p>}
    {board && taskId && (selectedTask ? <TaskDetail task={selectedTask} /> : <p className="text-sm text-muted-foreground">Задачи нет в полученном списке.{board.truncated ? " Список неполный." : ""}</p>)}
    {board && !taskId && <><div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">{columns.map(column => {
      const items = board.items.filter(task => task.state === column.state && (task.state !== "done" || task.completion_current === true));
      const count = column.state === "done" ? board.current_done_count : board.counts?.[column.state];
      return <section key={column.state} className="min-w-0 rounded-lg bg-secondary/40 p-3" aria-label={column.title}><header className="mb-3 flex items-center justify-between gap-2 px-1"><h2 className="text-sm font-medium">{column.title}</h2><span className="text-xs tabular-nums text-muted-foreground">{count ?? "?"}</span></header><div className="space-y-2">{items.map(task => <button type="button" key={task.id} onClick={() => go(task.id)} className="flex w-full cursor-pointer flex-col gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="text-sm font-medium">{task.title}</span>{taskCardBody(task) && <span className="line-clamp-2 text-xs text-muted-foreground">{taskCardBody(task)}</span>}{(task.owner_label || task.state === "doing") && <span className="text-xs text-muted-foreground">{task.owner_label ?? "Исполнитель не указан"}</span>}{task.context_current !== true && <span className="text-xs text-muted-foreground">Актуальность не подтверждена</span>}</button>)}{items.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground">{board.truncated ? "Нет в полученной части" : "Нет задач"}</p>}</div></section>;
    })}</div>{board.truncated && <p className="text-xs text-muted-foreground">Показана ограниченная часть списка. Счётчики относятся ко всей цели.</p>}{(historicalTasks.length > 0 || (board.historical_done_count !== null && board.historical_done_count > 0)) && <details className="rounded-lg border border-border p-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Завершено по прежним условиям · {board.historical_done_count ?? "Количество неизвестно"}</summary><div className="flex flex-col items-start gap-2 pt-3"><p className="text-xs text-muted-foreground">Эти результаты не входят в текущее «Готово».</p>{historicalTasks.map(task => <Button key={task.id} variant="ghost" className="h-auto max-w-full whitespace-normal text-left" onClick={() => go(task.id)}>{task.title} →</Button>)}{board.truncated && <p className="text-xs text-muted-foreground">В истории показаны только задачи из полученной части списка.</p>}</div></details>}</>}
    {mission?.state === "available" && !taskId && <details className="max-w-3xl text-sm"><summary className="cursor-pointer text-muted-foreground">Исходная цель</summary><p className="whitespace-pre-wrap break-words pt-3 text-muted-foreground">{mission.data.objective}</p></details>}
    <footer className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>Сохранённые статусы задач, не работа процессов</span>{tasks?.state === "available" && <ReadTime value={tasks.observedAt} />}</footer>
  </main>;
}

function PersonalOsPanel({ subPath }: { subPath: string }) {
  const match = /^mission\/(mission_[a-f0-9]{32})(?:\/task\/(task_[a-f0-9]{32}))?$/.exec(subPath);
  return <><InputComposer missionId={match?.[1] ?? null} />{!subPath ? <MissionList /> : match ? <MissionBoard key={match[1]} missionId={match[1]} taskId={match[2] ?? null} /> : <div className="p-6 text-sm">Этот адрес Personal OS не поддерживается.</div>}</>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "personal-os", title: "Personal OS", icon: "LayoutDashboard", path: PANEL_PATH, component: PersonalOsPanel });
});
