import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type SpeechResult = { isFinal: boolean; [index: number]: { transcript: string } };
type SpeechResultEvent = { results: { length: number; [index: number]: SpeechResult } };
type SpeechSession = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechConstructor = new () => SpeechSession;
type SpeechWindow = Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };
type ActiveSpeech = { recognition: SpeechSession; contextKey: string; seen: Set<number>; writes: Promise<void>[]; ended: boolean; finishing: boolean; stopping: boolean; hadError: boolean; timer: ReturnType<typeof setTimeout> | null };

const speechErrors: Record<string, string> = {
  "not-allowed": "Доступ к микрофону не разрешён. Можно ввести текст или использовать системную диктовку.",
  "service-not-allowed": "Сервис диктовки недоступен. Можно использовать системную диктовку.",
  "audio-capture": "Микрофон недоступен на устройстве браузера.",
  "no-speech": "Речь не распознана. Попробуйте ещё раз или введите текст.",
  network: "Сервис распознавания недоступен по сети. Уже добавленный текст остаётся в черновике.",
  "language-not-supported": "Браузер не поддерживает распознавание русского языка.",
  aborted: "Диктовка остановлена. Проверьте текст в черновике.",
};

export function VoiceInput({ disabled, contextKey, onFinal, onActiveChange }: { disabled: boolean; contextKey: string; onFinal: (text: string) => Promise<boolean>; onActiveChange: (active: boolean) => void }) {
  const [constructor] = useState(() => {
    const speechWindow = window as SpeechWindow;
    return window.isSecureContext ? speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null : null;
  });
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "stopping">("idle");
  const [status, setStatus] = useState("");
  const [interim, setInterim] = useState("");
  const [recovery, setRecovery] = useState("");
  const active = useRef<ActiveSpeech | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ disabled, contextKey, onFinal, onActiveChange });
  latest.current = { disabled, contextKey, onFinal, onActiveChange };
  const detach = (run: ActiveSpeech) => {
    if (run.timer !== null) clearTimeout(run.timer);
    run.recognition.onstart = null;
    run.recognition.onresult = null;
    run.recognition.onerror = null;
    run.recognition.onend = null;
  };
  const cancel = () => {
    const run = active.current;
    if (!run) return;
    active.current = null;
    detach(run);
    try { run.recognition.abort(); } catch { }
    if (mounted.current) {
      setPhase("idle");
      setInterim("");
      setStatus("Диктовка остановлена: условия ввода изменились. Проверьте текст в черновике.");
      latest.current.onActiveChange(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, []);
  useEffect(() => {
    if (active.current && (disabled || active.current.contextKey !== contextKey)) cancel();
  }, [disabled, contextKey]);
  const finish = (run: ActiveSpeech) => {
    if (run.finishing) return;
    run.finishing = true;
    run.ended = true;
    if (run.timer !== null) clearTimeout(run.timer);
    if (mounted.current) setPhase("stopping");
    void Promise.allSettled(run.writes).then(() => {
      if (active.current !== run) return;
      active.current = null;
      detach(run);
      if (mounted.current) {
        setPhase("idle");
        setInterim("");
        if (!run.hadError) setStatus("Диктовка завершена. Проверьте текст перед добавлением поручения.");
        latest.current.onActiveChange(false);
      }
    });
  };
  const stop = () => {
    const run = active.current;
    if (!run || run.finishing || run.stopping) return;
    run.stopping = true;
    setPhase("stopping");
    try {
      run.recognition.stop();
      run.timer = setTimeout(() => {
        if (active.current !== run) return;
        run.ended = true;
        try { run.recognition.abort(); } catch { }
        run.hadError = true;
        setStatus("Диктовка остановлена. Последние слова могли не распознаться; проверьте текст.");
        finish(run);
      }, 5000);
    } catch {
      try { run.recognition.abort(); } catch { }
      run.hadError = true;
      setStatus("Диктовка остановлена. Проверьте текст в черновике.");
      finish(run);
    }
  };
  const start = () => {
    if (!constructor || latest.current.disabled || active.current) return;
    let recognition: SpeechSession;
    try { recognition = new constructor(); } catch { setStatus("Диктовка недоступна. Введите текст или используйте системную диктовку."); return; }
    const run: ActiveSpeech = { recognition, contextKey: latest.current.contextKey, seen: new Set(), writes: [], ended: false, finishing: false, stopping: false, hadError: false, timer: null };
    active.current = run;
    setStatus("Подключаем микрофон…");
    setPhase("starting");
    latest.current.onActiveChange(true);
    try {
      recognition.lang = "ru-RU";
      recognition.continuous = true;
      recognition.interimResults = true;
    } catch {
      run.hadError = true;
      setStatus("Настроить диктовку не удалось. Введите текст или используйте системную диктовку.");
      finish(run);
      return;
    }
    recognition.onstart = () => {
      if (active.current !== run) return;
      if (latest.current.disabled || latest.current.contextKey !== run.contextKey) { cancel(); return; }
      if (run.stopping) return;
      setPhase("listening");
      setStatus("Слушаем. Текст добавляется в черновик; отправьте его отдельной кнопкой после проверки.");
    };
    recognition.onresult = event => {
      if (active.current !== run || run.ended || latest.current.disabled || latest.current.contextKey !== run.contextKey) return;
      const final: string[] = [];
      const pending: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript?.trim();
        if (!text) continue;
        if (!result.isFinal) pending.push(text);
        else if (!run.seen.has(index)) { run.seen.add(index); final.push(text); }
      }
      setInterim(pending.join(" ").slice(0, 20000));
      const text = final.join(" ");
      if (!text) return;
      let write: Promise<boolean>;
      try { write = latest.current.onFinal(text); } catch { write = Promise.resolve(false); }
      run.writes.push(write.catch(() => false).then(saved => {
        if (!saved && mounted.current) {
          run.hadError = true;
          setRecovery(previous => [previous, text].filter(Boolean).join("\n"));
          setStatus("Сохранение фрагмента не подтверждено. Не закрывайте вкладку; сверьте текст ниже с черновиком.");
          if (active.current === run) { try { recognition.abort(); } catch { } finish(run); }
        }
      }));
    };
    recognition.onerror = event => {
      if (active.current !== run || run.ended) return;
      run.hadError = true;
      setStatus(speechErrors[event.error] ?? "Диктовка прервана. Проверьте текст в черновике.");
      run.ended = true;
      try { recognition.abort(); } catch { }
      finish(run);
    };
    recognition.onend = () => { if (active.current === run) finish(run); };
    try { recognition.start(); } catch {
      run.hadError = true;
      setStatus("Запустить диктовку не удалось. Введите текст или используйте системную диктовку.");
      finish(run);
    }
  };
  if (!constructor) return <p className="text-xs text-muted-foreground">Диктовка в этом браузере недоступна. Введите текст или используйте системную диктовку.</p>;
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={phase === "idle" ? disabled : phase === "stopping"} aria-pressed={phase !== "idle"} onClick={phase === "idle" ? start : stop}>{phase === "idle" ? "Диктовать" : phase === "stopping" ? "Завершаем диктовку…" : "Остановить диктовку"}</Button><span className="text-xs text-muted-foreground">Микрофон устройства браузера. Аудио может обрабатывать сервис браузера.</span></div>
    {status && <p className="text-xs text-muted-foreground" role="status">{status}</p>}
    {interim && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">Распознаётся, ещё не сохранено: {interim}</p>}
    {recovery && <section className="space-y-1 rounded-md border border-border p-3"><h3 className="text-xs font-medium">Фрагменты для сверки, сохранение не подтверждено</h3><p className="whitespace-pre-wrap break-words text-sm select-text">{recovery}</p></section>}
  </div>;
}
