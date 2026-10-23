import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ownerActionsResultSchema, ownerAnswerRequestSchema, ownerAnswerResultSchema, type OwnerActionsData, type OwnerActionsResult, type OwnerAnswerRequest, type OwnerAnswerResult, type OwnerQuestion } from "./owner-actions-contract.js";

type Answer = (request: OwnerAnswerRequest) => Promise<OwnerAnswerResult>;
export type OwnerActionsProps = {
  missionId: string;
  read: (input: { mission_id: string }) => Promise<OwnerActionsResult>;
  onAnswer?: Answer;
  onSaved?: () => void;
  refreshNonce?: number;
};
const draftSchema = z.object({ option_id: z.string().max(200).nullable(), comment: z.string().max(8000), pending: ownerAnswerRequestSchema.nullable(), question_label: z.string().max(8000).optional() }).strict()
  .refine(value => value.pending === null || value.pending.response.option_id === value.option_id && value.pending.response.comment === value.comment);
type Draft = z.infer<typeof draftSchema>;
const emptyDraft = (): Draft => ({ option_id: null, comment: "", pending: null });

function draftLockAvailable() {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

async function withDraftLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  if (!draftLockAvailable()) throw new Error("draft_lock_unavailable");
  return navigator.locks.request(key, operation);
}

async function verifiedAnswer(answer: Answer, request: OwnerAnswerRequest) {
  const result = ownerAnswerResultSchema.parse(await answer(request));
  if (result.request_id !== request.request_id || result.mission_id !== request.selection.mission_id || result.decision_id !== request.selection.decision_id
    || result.state === "saved" && result.decision_version !== request.selection.decision_version + 1) throw new Error("wrong_receipt");
  return result;
}

type PendingEntry = { key: string; raw: string; draft: Draft; request: OwnerAnswerRequest };
function PendingAnswers({ missionId, excludeIds, answer, refreshNonce, onRecovered }: { missionId: string; excludeIds: Set<string>; answer?: Answer; refreshNonce: number; onRecovered: () => void }) {
  const lockAvailable = draftLockAvailable();
  const [entries, setEntries] = useState<PendingEntry[]>([]);
  const [incomplete, setIncomplete] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const busy = useRef(false);
  const currentMission = useRef(missionId);
  currentMission.current = missionId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const found: PendingEntry[] = [];
    let partial = false;
    try {
      const count = localStorage.length;
      partial = count > 2000;
      for (let index = 0; index < Math.min(count, 2000); index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith("bb-personal-os:owner-answer:" + missionId + ":")) continue;
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        if (raw.length > 65536) { partial = true; continue; }
        let parsed: ReturnType<typeof draftSchema.safeParse>;
        try { parsed = draftSchema.safeParse(JSON.parse(raw)); }
        catch { partial = true; continue; }
        if (!parsed.success) { partial = true; continue; }
        const request = parsed.data.pending;
        if (request === null) continue;
        if (request.selection.mission_id !== missionId || key !== "bb-personal-os:owner-answer:" + missionId + ":" + request.selection.decision_id) { partial = true; continue; }
        if (found.length === 20) { partial = true; break; }
        found.push({ key, raw, draft: parsed.data, request });
      }
    } catch { partial = true; }
    setEntries(found);
    setIncomplete(partial);
    return () => { mounted.current = false; };
  }, [missionId, refreshNonce]);
  async function retry(entry: PendingEntry) {
    if (!answer || busy.current || !lockAvailable) return;
    busy.current = true;
    setSending(entry.key);
    setMessage("");
    try {
      await withDraftLock(entry.key, () => {
        if (localStorage.getItem(entry.key) !== entry.raw) throw new Error("pending_changed");
      });
      const result = await verifiedAnswer(answer, entry.request);
      if (!mounted.current || currentMission.current !== entry.request.selection.mission_id) return;
      if (result.state === "outcome_unknown") setMessage("Исход по-прежнему неизвестен. Сохранённый запрос не изменён.");
      else {
        await withDraftLock(entry.key, () => {
          if (localStorage.getItem(entry.key) !== entry.raw) throw new Error("pending_changed");
          localStorage.setItem(entry.key, JSON.stringify({ ...entry.draft, pending: null }));
        });
        if (!mounted.current || currentMission.current !== entry.request.selection.mission_id) return;
        setEntries(previous => previous.filter(item => item.key !== entry.key));
        setMessage(result.state === "saved" ? "Сохранение ответа подтверждено. Это не разрешение на действие." : "Запрос отклонён. Перед новым ответом перечитайте актуальный вопрос.");
        onRecovered();
      }
    } catch { if (mounted.current) setMessage("Исход не подтверждён. Сохранённый запрос не изменён."); }
    finally { busy.current = false; if (mounted.current) setSending(null); }
  }
  const visible = entries.filter(entry => entry.request.selection.mission_id === missionId && !excludeIds.has(entry.request.selection.decision_id));
  if (!visible.length && !incomplete && !message) return null;
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Неподтверждённые ответы">
    <h2 className="text-sm font-semibold">Проверить отправку ответа</h2>
    <p className="text-xs text-muted-foreground">Эти запросы сохранены в этом браузере. Повтор использует исходные условия, даже если вопрос уже в истории.</p>
    {visible.map(entry => <article key={entry.key} className="space-y-2"><p className="whitespace-pre-wrap break-words text-sm">{entry.draft.question_label ?? "Сохранённый ответ владельца"}</p><p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.request.response.comment || "Выбранный вариант записан в исходном запросе."}</p><Button type="button" variant="outline" size="sm" disabled={!answer || sending !== null || !lockAvailable} onClick={() => void retry(entry)}>{sending === entry.key ? "Проверяем…" : "Повторить тот же ответ"}</Button></article>)}
    {!lockAvailable && <p className="text-xs text-muted-foreground">Браузер не поддерживает безопасную запись ответов. Повтор отключён; сохранённые запросы не удалены.</p>}
    {incomplete && <p className="text-xs text-muted-foreground">Часть сохранённых запросов недоступна или не поместилась в просмотр. Они не удалены.</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
  </section>;
}

function AnswerForm({ question, missionId, missionVersion, hostBinding, answer, onSaved }: { question: OwnerQuestion; missionId: string; missionVersion: number; hostBinding: string; answer?: Answer; onSaved?: () => void }) {
  const key = "bb-personal-os:owner-answer:" + missionId + ":" + question.id;
  const groupId = useId();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const raw = useRef<string | null>(null);
  const writeQueue = useRef(Promise.resolve());
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    try {
      const stored = localStorage.getItem(key);
      raw.current = stored;
      const value = stored === null ? emptyDraft() : draftSchema.parse(JSON.parse(stored));
      if (value.pending && (value.pending.selection.mission_id !== missionId || value.pending.selection.decision_id !== question.id)) throw new Error("wrong_selection");
      setDraft(value);
      if (draftLockAvailable()) setReady(true);
      else setMessage("Браузер не поддерживает безопасную запись ответов. Отправка отключена; сохранённые данные не изменены.");
    } catch {
      setMessage("Сохранённый ответ прочитать не удалось. Старые данные не изменены.");
    }
    return () => { mounted.current = false; };
  }, [key, missionId, question.id]);

  function persist(value: Draft) {
    const stored = { ...value, question_label: question.question };
    const encoded = JSON.stringify(stored);
    const operation = writeQueue.current.then(() => withDraftLock(key, () => {
      if (localStorage.getItem(key) !== raw.current) throw new Error("draft_changed");
      localStorage.setItem(key, encoded);
      raw.current = encoded;
    }));
    writeQueue.current = operation.catch(() => undefined);
    return operation;
  }
  function edit(next: Draft) {
    if (!ready || busy.current || draft.pending || saved) return;
    setDraft(next);
    setMessage("");
    void persist(next).catch(() => {
      if (mounted.current) { setReady(false); setMessage("Ответ изменён в другом окне или хранилище недоступно. Перечитайте вопросы."); }
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || !answer || busy.current || saved) return;
    if (!draft.pending && typeof globalThis.crypto?.randomUUID !== "function") {
      setMessage("Безопасное сохранение недоступно в этом браузере. Ответ не отправлен.");
      return;
    }
    const request = draft.pending ?? { request_id: crypto.randomUUID(), host_binding: hostBinding, selection: { mission_id: missionId, mission_version: missionVersion,
      decision_id: question.id, decision_version: question.version, context_hash: question.context_hash }, response: { option_id: draft.option_id, comment: draft.comment } };
    if (!ownerAnswerRequestSchema.safeParse(request).success || request.response.option_id !== null && !question.options.some(option => option.id === request.response.option_id)) {
      setMessage("Выберите вариант или напишите свой ответ.");
      return;
    }
    busy.current = true;
    setSending(true);
    setMessage("");
    try {
      await persist({ ...draft, pending: request });
      if (mounted.current) setDraft({ ...draft, pending: request });
    } catch {
      busy.current = false;
      setSending(false);
      setReady(false);
      setMessage("Не удалось сохранить запрос до отправки. Ответ не отправлен.");
      return;
    }
    try {
      const result = await verifiedAnswer(answer, request);
      if (!mounted.current) return;
      if (result.state === "saved") {
        await persist({ ...draft, pending: null });
        if (!mounted.current) return;
        setDraft({ ...draft, pending: null });
        setSaved(true);
        setMessage("Ответ сохранён. Он не выдаёт разрешений и не запускает работу.");
        onSaved?.();
      } else if (result.state === "rejected") {
        await persist({ ...draft, pending: null });
        if (!mounted.current) return;
        setDraft({ ...draft, pending: null });
        setReady(false);
        setMessage("Ответ отклонён. Перечитайте вопрос и его условия перед новым ответом.");
      } else setMessage("Исход отправки неизвестен. Повтор отправит тот же сохранённый ответ.");
    } catch {
      if (mounted.current) setMessage("Исход отправки неизвестен. Точный запрос сохранён для повтора.");
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }
  const locked = !ready || sending || draft.pending !== null || saved;
  return <details className="mt-3 text-sm">
    <summary className="cursor-pointer font-medium">{saved ? "Ответ сохранён" : draft.pending ? "Проверить отправку ответа" : "Выбрать ответ"}</summary>
    <form className="space-y-3 pt-3" onSubmit={event => void submit(event)}>
      <fieldset className="space-y-2" disabled={locked || !answer}>
        <legend className="sr-only">{question.question}</legend>
        {question.options.map(option => <label key={option.id} className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
          <input type="radio" name={groupId} value={option.id} checked={draft.option_id === option.id} onChange={() => edit({ ...draft, option_id: option.id })} className="mt-1" />
          <span><span className="font-medium">{option.label}</span>{question.recommended_option_id === option.id && <span className="ml-2 text-xs text-muted-foreground">Предложение агента</span>}<span className="block whitespace-pre-wrap break-words text-xs text-muted-foreground">{option.description}</span></span>
        </label>)}
        <label className="flex items-center gap-2"><input type="radio" name={groupId} checked={draft.option_id === null} onChange={() => edit({ ...draft, option_id: null })} />Свой ответ</label>
        <label className="block space-y-1"><span>Комментарий{draft.option_id === null ? " или свой ответ" : " (необязательно)"}</span><Textarea value={draft.comment} maxLength={4000} onChange={event => edit({ ...draft, comment: event.target.value })} /></label>
      </fieldset>
      {!answer && <p className="text-xs text-muted-foreground">Сохранение ответов в этом интерфейсе пока не подключено.</p>}
      {draft.pending && <p className="text-xs text-muted-foreground">Текст и условия запроса закреплены до подтверждения исхода.</p>}
      <p className="text-xs text-muted-foreground">Ответ сохраняет выбор. Он не подтверждает качество и не выдаёт права на действие.</p>
      <Button type="submit" size="sm" disabled={!ready || !answer || sending || saved}>{sending ? "Сохраняем…" : draft.pending ? "Повторить тот же ответ" : "Сохранить ответ"}</Button>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    </form>
  </details>;
}

function historyLabel(item: OwnerQuestion) {
  if (item.status === "resolved") return item.context_current ? "Ответ сохранён" : "Ответ по прежним условиям";
  if (!item.context_current) return "Вопрос по прежним условиям";
  return item.answer_unavailable_reason === "mission_cancelled" || item.answer_unavailable_reason === "mission_completed" ? "Цель закрыта" : "Ответ недоступен";
}

export function OwnerActions({ missionId, read, onAnswer, onSaved, refreshNonce = 0 }: OwnerActionsProps) {
  const reader = useRef(read);
  reader.current = read;
  const [result, setResult] = useState<{ missionId: string; data: OwnerActionsData | null; hostBinding: string | null; failed: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    void reader.current({ mission_id: missionId }).then(value => {
      const response = ownerActionsResultSchema.parse(value);
      if (response.state === "available" && response.data.mission_id !== missionId) throw new Error("wrong_mission");
      if (active) setResult({ missionId, data: response.state === "available" ? response.data : null, hostBinding: response.state === "available" ? response.host_binding : null, failed: response.state !== "available" });
    }).catch(() => { if (active) setResult({ missionId, data: null, hostBinding: null, failed: true }); });
    return () => { active = false; };
  }, [missionId, refreshNonce, revision]);
  const visible = result?.missionId === missionId ? result : null;
  const recovery = <PendingAnswers missionId={missionId} excludeIds={new Set(visible?.data?.questions.items.map(item => item.id) ?? [])} answer={onAnswer} refreshNonce={refreshNonce + revision} onRecovered={() => { setRevision(value => value + 1); onSaved?.(); }} />;
  if (!visible) return <>{recovery}<p role="status" className="text-xs text-muted-foreground">Читаем вопросы владельцу…</p></>;
  const data = visible.data;
  if (!data || visible.failed) return <>{recovery}<p role="status" className="text-sm text-muted-foreground">Вопросы владельцу недоступны. Нужные решения неизвестны.</p></>;
  const completeEmpty = data.state === "available" && data.questions.loaded_count === 0 && !data.questions.truncated && !data.source_truncated;
  if (completeEmpty && data.history.items.length === 0 && !data.history.truncated && data.legacy.total_count === 0 && !data.legacy.truncated) return recovery;
  return <>{recovery}<section aria-label="Вопросы владельцу" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h2 className="text-base font-semibold">{data.questions.items.length ? "Нужно ваше решение" : "Вопросы по цели"}</h2>
    {data.state !== "available" ? <p className="text-sm text-muted-foreground">Текущие вопросы недоступны. Прежние записи показаны отдельно.</p>
      : data.questions.items.length === 0 && <p className="text-sm text-muted-foreground">{completeEmpty ? "Актуальных локальных вопросов не найдено. Остальные препятствия здесь не оценивались." : "В полученной части актуальных вопросов нет. Полнота неизвестна."}</p>}
    {data.questions.items.map(question => <article key={question.id + ":" + question.version + ":" + question.context_hash} className="rounded-md border border-border p-3">
      <h3 className="whitespace-pre-wrap break-words text-sm font-medium">{question.question}</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{question.reason}</p>
      <AnswerForm question={question} missionId={missionId} missionVersion={data.mission_version!} hostBinding={visible.hostBinding!} answer={onAnswer} onSaved={() => { setRevision(value => value + 1); onSaved?.(); }} />
    </article>)}
    {data.questions.truncated && <p className="text-xs text-muted-foreground">Показана часть локальных вопросов. Полный список препятствий здесь не оценивается.</p>}
    {(data.history.items.length > 0 || data.history.truncated) && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Сохранённые и прежние вопросы</summary><div className="space-y-3 pt-3">{data.history.items.map(item => <article key={item.id} className="space-y-1"><p className="text-xs text-muted-foreground">{historyLabel(item)}</p><p className="whitespace-pre-wrap break-words">{item.question}</p>{item.resolution && <p className="whitespace-pre-wrap break-words text-muted-foreground">{item.options.find(option => option.id === item.resolution?.option_id)?.label ?? "Свой ответ"}{item.resolution.comment ? ": " + item.resolution.comment : ""}</p>}</article>)}{data.history.truncated && <p className="text-xs text-muted-foreground">История показана не полностью.</p>}</div></details>}
    {(data.legacy.items.length > 0 || data.legacy.truncated) && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Вопросы без привязки к условиям</summary><div className="space-y-3 pt-3"><p className="text-xs text-muted-foreground">Это прежние записи. Ответ здесь недоступен.</p>{data.legacy.items.map(item => <article key={item.id}><p className="whitespace-pre-wrap break-words">{item.question}</p>{item.answer && <p className="whitespace-pre-wrap break-words text-muted-foreground">Сохранено: {item.answer}</p>}</article>)}</div></details>}
  </section></>;
}
