import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type QualityReferenceSelection = {
  mission_id: string;
  profile_id: string;
  version: number;
  profile_hash: string;
  dimension_id: "accuracy" | "ux" | "visual" | "resilience" | "delivery";
  kind: "example" | "counterexample";
  sample_id: string;
};

export type QualityReferenceAsset = {
  schema_version: 1;
  scope: "quality_reference_asset";
  state: "available" | "unavailable" | "error";
  selection: QualityReferenceSelection;
  sample_definition_hash: string | null;
  declared_sha256: string | null;
  observed_sha256: string | null;
  size: number | null;
  media_type: "image/jpeg" | "image/png" | "text/plain; charset=utf-8" | null;
  content: { encoding: "base64"; data: string } | null;
  context_current: boolean | null;
  profile_current: boolean | null;
  error_code: string | null;
  owner_confirmation: "not_assessed";
  calibration: "not_assessed";
};

export type QualityReferenceViewerProps = {
  selection: QualityReferenceSelection;
  read: (selection: QualityReferenceSelection) => Promise<QualityReferenceAsset>;
  label: string;
  onExpandedChange?: (expanded: boolean) => void;
};

type Preview = {
  key: string;
  phase: "idle" | "loading" | "available" | "unavailable";
  asset: QualityReferenceAsset | null;
  text: string | null;
  imageUrl: string | null;
  message: string;
};

function selectionKey(value: QualityReferenceSelection): string {
  return JSON.stringify([value.mission_id, value.profile_id, value.version, value.profile_hash, value.dimension_id, value.kind, value.sample_id]);
}

function unavailableMessage(code: string | null): string {
  switch (code) {
    case "reference_hash_mismatch": return "Файл изменился. Он не совпадает с закреплённым образцом.";
    case "reference_hash_not_pinned": return "У образца нет закреплённого SHA-256. Просмотр недоступен.";
    case "reference_size_limit": return "Материал превышает предел просмотра.";
    case "reference_source_not_allowed": return "Этот источник пока не поддерживает безопасный просмотр.";
    case "reference_image_unsupported":
    case "reference_text_unsupported": return "Формат материала не поддерживается.";
    case "reference_changed_during_read": return "Материал изменился во время чтения. Повторите запрос.";
    case "reference_profile_unavailable":
    case "reference_not_registered": return "Закреплённый образец недоступен.";
    case "reference_identity_mismatch": return "Ответ относится к другому образцу. Материал скрыт.";
    default: return "Материал не удалось прочитать. Его содержимое не подтверждено.";
  }
}

async function verifiedBytes(asset: QualityReferenceAsset, selected: QualityReferenceSelection): Promise<Uint8Array<ArrayBuffer>> {
  const sha = /^[a-f0-9]{64}$/;
  if (asset.schema_version !== 1 || asset.scope !== "quality_reference_asset" || selectionKey(asset.selection) !== selectionKey(selected)
    || asset.state !== "available" || asset.owner_confirmation !== "not_assessed" || asset.calibration !== "not_assessed"
    || !asset.sample_definition_hash || !sha.test(asset.sample_definition_hash)
    || !asset.declared_sha256 || !sha.test(asset.declared_sha256) || asset.observed_sha256 !== asset.declared_sha256
    || asset.error_code !== null || asset.content?.encoding !== "base64" || typeof asset.content.data !== "string"
    || !(asset.context_current === null || typeof asset.context_current === "boolean")
    || !(asset.profile_current === null || typeof asset.profile_current === "boolean")) throw new Error("invalid_reference");
  const limit = asset.media_type === "text/plain; charset=utf-8" ? 256 * 1024
    : asset.media_type === "image/jpeg" || asset.media_type === "image/png" ? 2 * 1024 * 1024 : 0;
  if (!Number.isSafeInteger(asset.size) || asset.size === null || asset.size < 1 || asset.size > limit
    || asset.content.data.length > 4 * Math.ceil(limit / 3)) throw new Error("invalid_reference");
  const decoded = atob(asset.content.data);
  if (decoded.length !== asset.size || btoa(decoded) !== asset.content.data) throw new Error("invalid_reference");
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const observed = Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
  if (observed !== asset.declared_sha256) throw new Error("invalid_reference");
  if (asset.media_type === "image/jpeg" && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217)) throw new Error("invalid_reference");
  if (asset.media_type === "image/png" && ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error("invalid_reference");
  return bytes;
}

export function QualityReferenceViewer({ selection, read, label, onExpandedChange }: QualityReferenceViewerProps) {
  const key = selectionKey(selection);
  const regionId = useId();
  const requestId = useRef(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const expandedCallback = useRef(onExpandedChange);
  expandedCallback.current = onExpandedChange;
  const selectedKey = useRef(key);
  selectedKey.current = key;
  const [preview, setPreview] = useState<Preview>({ key, phase: "idle", asset: null, text: null, imageUrl: null, message: "" });
  const visible = preview.key === key ? preview : null;
  const [imageView, setImageView] = useState<{ key: string; url: string | null; expanded: boolean; scale: "fit" | "actual" }>({ key, url: null, expanded: false, scale: "fit" });
  const expanded = visible?.phase === "available" && visible.imageUrl !== null && imageView.key === key && imageView.url === visible.imageUrl && imageView.expanded;
  const actualSize = expanded && imageView.scale === "actual";
  const imageRegionId = useId();

  useEffect(() => { expandedCallback.current?.(expanded); }, [expanded]);
  useEffect(() => () => { expandedCallback.current?.(false); }, []);

  function collapseImage() {
    setImageView(previous => ({ ...previous, expanded: false }));
    expandButtonRef.current?.focus();
  }

  useEffect(() => {
    requestId.current += 1;
    setPreview({ key, phase: "idle", asset: null, text: null, imageUrl: null, message: "" });
    return () => { requestId.current += 1; };
  }, [key]);

  useEffect(() => {
    const url = preview.imageUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [preview.imageUrl]);

  async function load() {
    const generation = ++requestId.current;
    const snapshot = { ...selection };
    setPreview({ key, phase: "loading", asset: null, text: null, imageUrl: null, message: "" });
    try {
      const asset = await read(snapshot);
      if (generation !== requestId.current || selectedKey.current !== key) return;
      if (asset.schema_version !== 1 || asset.scope !== "quality_reference_asset" || selectionKey(asset.selection) !== key) throw new Error("invalid_reference");
      if (asset.state !== "available") {
        setPreview({ key, phase: "unavailable", asset: null, text: null, imageUrl: null, message: unavailableMessage(asset.error_code) });
        return;
      }
      const bytes = await verifiedBytes(asset, snapshot);
      if (generation !== requestId.current || selectedKey.current !== key) return;
      if (asset.media_type === "text/plain; charset=utf-8") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error("invalid_reference");
        setPreview({ key, phase: "available", asset, text, imageUrl: null, message: "" });
      } else {
        const imageUrl = URL.createObjectURL(new Blob([bytes], { type: asset.media_type ?? "application/octet-stream" }));
        setPreview({ key, phase: "available", asset, text: null, imageUrl, message: "" });
      }
    } catch {
      if (generation !== requestId.current || selectedKey.current !== key) return;
      setPreview({ key, phase: "unavailable", asset: null, text: null, imageUrl: null, message: "Материал не прошёл проверку или связь недоступна. Содержимое скрыто." });
    }
  }

  return <div className="mt-3 min-w-0 space-y-3">
    <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={visible?.phase === "loading"} aria-controls={regionId}>
      {visible?.phase === "loading" ? "Читаем материал…" : visible?.phase === "available" ? "Перечитать материал" : "Просмотреть материал"}
    </Button>
    <div id={regionId} aria-busy={visible?.phase === "loading"} className="min-w-0 space-y-3">
      {visible?.phase === "loading" && <p role="status" className="text-sm text-muted-foreground">Проверяем закреплённый файл.</p>}
      {visible?.phase === "unavailable" && <p role="status" className="text-sm text-muted-foreground">{visible.message}</p>}
      {visible?.phase === "available" && visible.asset && <>
        <p className="text-sm text-muted-foreground">Байты совпадают с закреплённым SHA-256. Просмотр не означает согласование или калибровку.</p>
        {(visible.asset.context_current !== true || visible.asset.profile_current !== true) && <p className="text-sm text-muted-foreground">
          {visible.asset.context_current === false || visible.asset.profile_current === false ? "Материал относится к прежнему профилю или условиям." : "Актуальность профиля неизвестна."}
        </p>}
        {visible.imageUrl && <section className="min-w-0 space-y-2" onKeyDown={event => {
          if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); collapseImage(); }
        }}>
          <div className="flex flex-wrap items-center gap-2">
            <Button ref={expandButtonRef} type="button" variant="outline" size="sm" aria-expanded={expanded} aria-controls={imageRegionId} onClick={() => {
              if (expanded) collapseImage();
              else setImageView({ key, url: visible.imageUrl, expanded: true, scale: "actual" });
            }}>{expanded ? "Свернуть" : "Во весь размер"}</Button>
            {expanded && <div className="flex flex-wrap gap-1" role="group" aria-label="Масштаб образца">
              <Button type="button" variant={!actualSize ? "secondary" : "ghost"} size="sm" aria-pressed={!actualSize} onClick={() => setImageView(previous => ({ ...previous, scale: "fit" }))}>По ширине</Button>
              <Button type="button" variant={actualSize ? "secondary" : "ghost"} size="sm" aria-pressed={actualSize} onClick={() => setImageView(previous => ({ ...previous, scale: "actual" }))}>100%</Button>
            </div>}
          </div>
          {expanded && <p className="text-xs text-muted-foreground">Тот же проверенный файл. В масштабе 100% используйте прокрутку. Escape — свернуть.</p>}
          <figure className="min-w-0 overflow-hidden rounded-lg border bg-muted/20">
            <div id={imageRegionId} role={expanded ? "region" : undefined} aria-label={expanded ? label + (actualSize ? ", масштаб 100%, прокрутка изображения" : ", по ширине") : undefined} tabIndex={expanded ? 0 : undefined} className={expanded ? "max-h-[70vh] overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" : undefined}>
              <img ref={imageRef} src={visible.imageUrl} alt={label} className={actualSize ? "block h-auto max-h-none w-auto max-w-none" : "block h-auto max-h-none w-full object-contain"} onError={(event) => {
                if (imageRef.current !== event.currentTarget || selectedKey.current !== key) return;
                requestId.current += 1;
                setPreview({ key, phase: "unavailable", asset: null, text: null, imageUrl: null, message: "Байты проверены, но браузер не смог показать изображение." });
              }} />
            </div>
            <figcaption className="border-t px-3 py-2 text-sm text-muted-foreground">{label}</figcaption>
          </figure>
        </section>}
        {visible.text !== null && <details className="min-w-0 rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-sm">Открыть текст материала · {Math.ceil((visible.asset.size ?? 0) / 1024)} КиБ</summary>
          <pre className="whitespace-pre-wrap break-words border-t p-3 font-mono text-xs">{visible.text}</pre>
        </details>}
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Данные файла</summary>
          <dl className="mt-2 space-y-1 break-all">
            <div><dt className="inline">Размер: </dt><dd className="inline">{visible.asset.size} байт</dd></div>
            <div><dt className="inline">Формат: </dt><dd className="inline">{visible.asset.media_type}</dd></div>
            <div><dt className="inline">SHA-256: </dt><dd className="inline font-mono text-xs">{visible.asset.observed_sha256}</dd></div>
          </dl>
        </details>
      </>}
    </div>
  </div>;
}
