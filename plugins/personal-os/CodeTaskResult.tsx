import { useEffect, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { DomainDeliveryRead, PersonalOsContract, TaskCodeResult } from "./contract.js";

type CodeData = Extract<TaskCodeResult, { state: "available" }>["data"];
const checkLabels = { passed: "Успех в отчёте", failed: "Ошибка в отчёте", timeout: "Время истекло", not_run: "Не выполнена" };

export function CodeTaskResult({ missionId, taskId, bindingId, renderDelivery }: {
  missionId: string; taskId: string; bindingId: string;
  renderDelivery: (delivery: DomainDeliveryRead, artifact: CodeData["artifact"], artifacts: CodeData["artifacts"]) => ReactNode;
}) {
  const rpc = useRpc<PersonalOsContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<TaskCodeResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setFailed(false);
    void rpc.call("getTaskCodeResult", { taskId, bindingId }).then(value => {
      if (active) setResult(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [rpc, missionId, taskId, bindingId, revision]);
  const data = result?.state === "available" && result.data.missionId === missionId && result.data.taskId === taskId && result.data.bindingId === bindingId ? result.data : null;
  const produced = data?.verification.state === "reconstructed";
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
    <header className="flex flex-wrap justify-between gap-3">
      <Button type="button" variant="ghost" size="sm" onClick={() => navigate.toPluginPanel("personal-os", { subPath: "mission/" + missionId + "/task/" + taskId })}>← К задаче</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Обновить</Button>
    </header>
    <h1 className="text-xl font-semibold tracking-tight">{data ? produced ? "Полученный код задачи" : "Отчёт code-попытки" : "Результат code-попытки"}</h1>
    {result === null && !failed && <p role="status" className="text-sm text-muted-foreground">Проверяем сохранённые файлы и читаем отчёт…</p>}
    {(failed || result !== null && !data) && <p role="status" className="text-sm text-muted-foreground">Пакет прочитать не удалось. Его содержимое и сохранность не подтверждены этим чтением.</p>}
    {data && <>
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium">{produced ? "Комплект сохранён: отчёт, patch и bundle" : "Полный комплект кода не получен"}</p>
        <p className="text-xs text-muted-foreground">Сообщение исполнителя</p>
        <p className="whitespace-pre-wrap break-words text-sm">{data.content.summary || "Итог в отчёте не указан."}</p>
        <p className="text-xs text-muted-foreground">{data.currentness === "current" && data.taskVersionCurrent === true && data.taskContextCurrent === true ? "Попытка соответствует текущей версии задачи и её условиям." : data.taskContextCurrent === false ? "Результат по прежним условиям задачи." : data.taskVersionCurrent === false ? "Результат прежней версии задачи." : data.currentness === "historical" ? "Результат прежней попытки." : "Актуальность попытки не подтверждена."}</p>
        {!produced && <p className="text-xs text-muted-foreground">Сохранён отчёт о неудаче{data.content.error_code ? " · " + data.content.error_code : ""}. Доступные файлы показаны ниже.</p>}
      </section>
      <section className="space-y-3" aria-label="Сохранённые файлы code-попытки">
        <h2 className="text-base font-semibold">Файлы пакета · {data.artifacts.length}</h2>
        <div className="divide-y divide-border rounded-lg border border-border">{data.artifacts.map(file => <details key={file.name} className="p-3">
          <summary className="flex cursor-pointer flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{file.name}</span><span className="text-muted-foreground">{file.size.toLocaleString("ru-RU")} байт</span></summary>
          <p className="break-all pt-3 font-mono text-xs text-muted-foreground">SHA-256 · {file.sha256}</p>
        </details>)}</div>
        <p className="text-xs text-muted-foreground">Personal OS перечитала сохранённые файлы и проверила их SHA-256. BB отдельно проверил hash отчёта. Просмотр только читает сохранённый пакет.</p>
      </section>
      {renderDelivery(data.domainDelivery, data.artifact, data.artifacts)}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="text-base font-semibold">Проверки в отчёте исполнителя</h2>
        {data.content.checks.length ? <ul className="space-y-3">{data.content.checks.map(check => <li key={check.id} className="flex flex-wrap justify-between gap-2 text-sm"><span className="break-words">{check.id}</span><span className="text-muted-foreground">{checkLabels[check.status]} · {(check.duration_ms / 1000).toLocaleString("ru-RU")} с{check.exit_code !== null ? " · код " + check.exit_code : ""}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">Проверки не указаны.</p>}
        <p className="text-xs text-muted-foreground">Это сохранённые сведения исполнителя. Во время просмотра проверки не запускаются. Они не подтверждают приёмку продукта.</p>
      </section>
      <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Изменённые файлы · {data.content.changed_files.length}</summary>
        {data.content.changed_files.length ? <ul className="space-y-1 pt-3 text-xs">{data.content.changed_files.map(path => <li key={path} className="break-all font-mono">{path}</li>)}</ul> : <p className="pt-3 text-xs text-muted-foreground">Не указаны.</p>}
      </details>
      {data.verification.state === "reconstructed" && <details className="space-y-3 rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Сохранённое восстановление Git</summary><dl className="space-y-2 pt-3 text-xs">{[["Исходный commit", data.verification.base_sha], ["Результат", data.verification.result_sha], ["Дерево файлов", data.verification.result_tree]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl><p className="text-xs text-muted-foreground">Сохранено доказательство восстановления patch и bundle. Просмотр не запускает Git и не проверяет работу приложения.</p></details>}
      <p className="text-xs text-muted-foreground">Полученный пакет, проверка исходников и приёмка всей цели — разные этапы. Задача не завершается от чтения файла.</p>
    </>}
  </main>;
}
