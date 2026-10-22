import { useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { MissionResult, MissionsResult, PersonalOsContract, Task, TasksResult } from "./contract.js";

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
    <footer className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>Только чтение · Personal OS хранит цели и приёмку</span>{result?.state === "available" && <ReadTime value={result.observedAt} />}</footer>
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
    <footer className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>Только чтение · статусы задач, не работа процессов</span>{tasks?.state === "available" && <ReadTime value={tasks.observedAt} />}</footer>
  </main>;
}

function PersonalOsPanel({ subPath }: { subPath: string }) {
  if (!subPath) return <MissionList />;
  const match = /^mission\/(mission_[a-f0-9]{32})(?:\/task\/(task_[a-f0-9]{32}))?$/.exec(subPath);
  return match ? <MissionBoard key={match[1]} missionId={match[1]} taskId={match[2] ?? null} /> : <div className="p-6 text-sm">Этот адрес Personal OS не поддерживается.</div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "personal-os", title: "Personal OS", icon: "LayoutDashboard", path: PANEL_PATH, component: PersonalOsPanel });
});
