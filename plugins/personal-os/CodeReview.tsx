import type { CodeReviewRead } from "./contract.js";

const phaseLabels: Record<string, string> = {
  waiting_artifact: "Ждём code-пакет", enabled: "Проверка включена", native_prepared: "Проверка подготовлена",
  launch_intent: "Запуск проверки зарегистрирован", observing: "Ждём итог проверки", historical: "Проверка прежней попытки", fenced: "Проверка заблокирована",
  prepared: "Проверка подготовлена", launching: "Проверка запущена, ждём итог",
  running: "Проверка запущена, ждём итог", native_running: "Проверка запущена, ждём итог",
  reconciling: "Уточняется исход проверки", finished: "Итог проверки получен", recorded: "Итог проверки сохранён",
  commit_pending: "Итог ожидает сохранения", failed: "Проверка остановлена с ошибкой", cancelled: "Проверка отменена", blocked: "Проверка заблокирована",
};
const resultLabels = { pass: "Положительный вывод", fail: "Указана проблема", unknown: "Неизвестно", not_run: "Не проверено" };
const gateLabels: Record<string, string> = {
  calibration_not_pinned: "Образцы не закреплены в этой проверке",
  review_not_passed: "Проверка не дала полного положительного вывода",
  binding_changed: "Условия привязки проверки изменились",
  evidence_changed: "Основания проверки изменились",
  review_failed: "Проверка завершилась ошибкой",
  gate_conditions_unconfirmed: "Условия приёмки не подтверждены",
};

export function codeReviewLabel(review?: CodeReviewRead) {
  if (!review || review.state === "unavailable" || review.state === "error") return "Статус проверки неизвестен";
  if (review.state === "not_registered") return "Запуск проверки не зарегистрирован";
  if (review.binding_current === false) return "Проверка по прежним условиям";
  if (review.binding_current !== true) return "Актуальность проверки неизвестна";
  if (review.run && ["fenced", "failed", "cancelled"].includes(review.run.phase)) return phaseLabels[review.run.phase];
  if (review.run?.error_code && !["recorded", "historical"].includes(review.run.phase)) return "Проверка требует внимания";
  if (review.consumer_review?.outcome === "changes_required" && review.consumer_review.finding_ids.length > 0) return "Нужны исправления · " + new Set(review.consumer_review.finding_ids).size + " замечаний";
  if (review.consumer_review?.outcome === "inconclusive") return "Вывода проверки недостаточно";
  if (review.outcome === "fail") return "Проверяющий указал на проблемы";
  if (review.outcome === "unknown" || review.outcome === "not_run") return "Не все условия проверены";
  if (review.consumer_review?.outcome === "no_blocking_findings") return "Проверка исходников сохранена";
  if (review.outcome === "pass") return "Положительный вывод по исходникам получен";
  return phaseLabels[review.run?.phase ?? ""] ?? phaseLabels[review.run?.native_state ?? ""] ?? "Статус проверки неизвестен";
}

export function CodeReview({ review }: { review?: CodeReviewRead }) {
  if (!review || review.state === "not_registered") return null;
  const available = review?.state === "available";
  const report = available ? review.report : null;
  const priority = { fail: 0, unknown: 1, not_run: 1, pass: 2 };
  const entries = report ? [...report.entries].sort((left, right) => priority[left.result] - priority[right.result]) : [];
  const concerns = entries.filter(entry => entry.result !== "pass");
  const shown = concerns.slice(0, 2);
  const blockers = available ? review.gate_blockers : null;
  const stage = review.run ? phaseLabels[review.run.phase] ?? phaseLabels[review.run.native_state ?? ""] ?? "Этап неизвестен" : null;
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Проверка исходников code-попытки">
    <div className="space-y-1"><h2 className="text-base font-semibold">Проверка исходников</h2><p className="text-sm font-medium">{codeReviewLabel(review)}</p></div>
    {stage && <p className="text-xs text-muted-foreground">{stage} · сохранённый этап; работа процесса сейчас не подтверждена.</p>}
    {review?.binding_current !== true && <p className="text-xs text-muted-foreground">{review?.binding_current === false ? "Проверка относится к прежним условиям задачи." : "Актуальность привязки проверки неизвестна."}</p>}
    {shown.length > 0 && <ul className="space-y-3">{shown.map(entry => <li key={entry.kind + ":" + entry.id} className="space-y-1"><p className="break-words text-sm font-medium">{entry.kind === "criterion" ? "Критерий" : "Требуемый результат"} · {resultLabels[entry.result]}</p><p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.reason || "Причина в отчёте не указана."}</p></li>)}</ul>}
    {report && <details className="space-y-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Вывод проверяющего · исходники{report.total_count ? " · " + report.total_count + " пунктов" : ""}</summary>
      <p className="whitespace-pre-wrap break-words pt-3">{report.summary || "Общий вывод не указан."}</p>
      <ul className="space-y-3 pt-3">{entries.map(entry => <li key={entry.kind + ":" + entry.id} className="space-y-1"><p className="break-words font-medium">{entry.label || (entry.kind === "criterion" ? "Критерий" : "Требуемый результат")} · {resultLabels[entry.result]}</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{entry.reason || "Причина в отчёте не указана."}</p></li>)}</ul>
      {report.truncated && <p className="text-xs text-muted-foreground">Показано {entries.length} из {report.total_count} пунктов. Первыми идут проблемы и неизвестные состояния.</p>}
    </details>}
    {blockers && blockers.length > 0 && <ul className="space-y-1 text-xs text-muted-foreground">{[...new Set(blockers)].slice(0, 2).map(code => <li key={code}>{gateLabels[code] ?? "Есть препятствие для проверки; причина не распознана."}</li>)}</ul>}
    <p className="text-xs text-muted-foreground">Неизвестные или невыполненные проверки не считаются дефектами. Проверка исходников не принимает продукт или всю цель.</p>
  </section>;
}
