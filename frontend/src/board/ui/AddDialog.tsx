import { FileUp, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { BoardEngine, PdfPlacement } from "../engine/BoardEngine";
import { MAX_PDF_BYTES, openPdf, renderPdfPageToBlob, renderPdfThumbnail } from "../pdf/rasterizePdf";
import { UploadError, type AssetService } from "../sync/assetService";

type AddDialogProps = {
  engine: BoardEngine;
  assets: AssetService;
  canAddPdf: boolean;
  canAddImage: boolean;
  /** May add tabs: offers "each page on its own tab". */
  canUseTabs: boolean;
  /** A file dropped on the board, to start with. */
  initialFile: File | null;
  onClose(): void;
  onNotice(message: string): void;
};

type Step =
  | { kind: "choose" }
  | { kind: "opening" }
  | { kind: "pages" }
  | { kind: "working"; done: number; total: number; fraction: number; label: string }
  | { kind: "finished"; message: string }
  | { kind: "error"; message: string };

const THUMB_WIDTH = 150;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A page preview, drawn only when it scrolls into view. */
function PageThumb({
  pdf,
  pageNumber,
  checked,
  disabled,
  onToggle,
  enqueue,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  checked: boolean;
  disabled: boolean;
  onToggle(): void;
  enqueue(task: () => Promise<void>): void;
}) {
  const tileRef = useRef<HTMLLabelElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const tile = tileRef.current;
    if (!tile || drawn) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        enqueue(async () => {
          const canvas = canvasRef.current;
          if (cancelled || !canvas) return;
          await renderPdfThumbnail(pdf, pageNumber, canvas, THUMB_WIDTH);
          if (!cancelled) setDrawn(true);
        });
      },
      { rootMargin: "200px" },
    );
    observer.observe(tile);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [drawn, enqueue, pageNumber, pdf]);

  return (
    <label className={`tb-thumb${checked ? "" : " is-off"}`} ref={tileRef}>
      <input checked={checked} disabled={disabled} onChange={onToggle} type="checkbox" />
      <span className="tb-thumb-page">
        <canvas className={drawn ? "is-drawn" : ""} ref={canvasRef} />
      </span>
      <span className="tb-thumb-label">Page {pageNumber}</span>
    </label>
  );
}

/**
 * "Add to board": an image goes straight on the board; a PDF shows its
 * pages to pick from and where to put them, then uploads page by page.
 */
export function AddDialog({
  engine,
  assets,
  canAddPdf,
  canAddImage,
  canUseTabs,
  initialFile,
  onClose,
  onNotice,
}: AddDialogProps) {
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState("");
  const [selected, setSelected] = useState<boolean[]>([]);
  const [placement, setPlacement] = useState<PdfPlacement>("stack");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const startedRef = useRef(false);
  const working = step.kind === "working" || step.kind === "opening";

  // Thumbnails are drawn one at a time so a long PDF doesn't freeze the page.
  const enqueueRef = useRef((task: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(task).catch(() => undefined);
  });

  useEffect(() => {
    panelRef.current?.focus();
    return () => {
      abortRef.current?.abort();
      void pdfRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, working]);

  useEffect(() => {
    if (initialFile && !startedRef.current) {
      startedRef.current = true;
      void handleFile(initialFile);
    }
    // handleFile only needs to run once for the dropped file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  async function handleFile(file: File) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      if (!canAddPdf) {
        setStep({ kind: "error", message: "Only tutors can add PDFs." });
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setStep({ kind: "error", message: "That PDF is larger than 50 MB. Try a smaller file, or split it into parts." });
        return;
      }
      setStep({ kind: "opening" });
      try {
        const opened = await openPdf(file);
        void pdfRef.current?.destroy();
        pdfRef.current = opened;
        setPdf(opened);
        setFileName(file.name);
        setSelected(Array.from({ length: opened.numPages }, () => true));
        setStep({ kind: "pages" });
      } catch {
        setStep({
          kind: "error",
          message: "That PDF couldn't be opened. It may be damaged or protected with a password.",
        });
      }
      return;
    }
    if (IMAGE_TYPES.includes(file.type)) {
      if (!canAddImage) {
        setStep({ kind: "error", message: "Your tutor hasn't allowed file uploads." });
        return;
      }
      setStep({ kind: "working", done: 0, total: 1, fraction: 0, label: "Adding image…" });
      try {
        await engine.insertImage(file, undefined, (fraction) =>
          setStep({ kind: "working", done: 0, total: 1, fraction, label: "Adding image…" }),
        );
        onNotice("Image added.");
        onClose();
      } catch (error) {
        setStep({ kind: "error", message: messageOf(error, "Could not add that image.") });
      }
      return;
    }
    setStep({
      kind: "error",
      message: canAddPdf ? "Choose a PDF or an image (JPG, PNG or WebP)." : "Choose an image (JPG, PNG or WebP).",
    });
  }

  async function addPages() {
    const source = pdf;
    if (!source) return;
    const pages = selected.flatMap((on, index) => (on ? [index + 1] : []));
    if (pages.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const placer = engine.beginPdfImport(placement);
    const pdfId = crypto.randomUUID();
    const total = pages.length;
    let done = 0;
    const show = (fraction: number) =>
      setStep({ kind: "working", done, total, fraction, label: `Adding page ${done + 1} of ${total}…` });
    try {
      for (const pageNumber of pages) {
        if (controller.signal.aborted) break;
        show(0);
        const page = await renderPdfPageToBlob(source, pageNumber);
        if (controller.signal.aborted) break;
        const uploaded = await assets.upload(page.blob, "pdf-page", show, controller.signal);
        const placed = engine.addPdfPage(
          { ...uploaded, mime: "image/jpeg", width: page.width, height: page.height, bytes: page.blob.size },
          placer.next(page.height / page.width),
          { pdfId, pdfName: fileName, pageNumber, locked: placement !== "view", ownTab: placement === "tabs" },
        );
        if (!placed) throw new UploadError("Editing was turned off, so the PDF couldn't be finished.");
        done += 1;
      }
      if (controller.signal.aborted) {
        setStep({ kind: "finished", message: `Stopped. ${done} of ${total} pages were added.` });
      } else {
        onNotice(`Added ${done} page${done === 1 ? "" : "s"} from ${fileName}.`);
        onClose();
      }
    } catch (error) {
      if (isAbort(error)) {
        setStep({ kind: "finished", message: `Stopped. ${done} of ${total} pages were added.` });
      } else {
        const added = done > 0 ? ` ${done} of ${total} pages were added before the problem.` : "";
        setStep({ kind: "error", message: `${messageOf(error, "Something went wrong.")}${added}` });
      }
    } finally {
      engine.endPdfImport();
      abortRef.current = null;
    }
  }

  function onDrop(event: ReactDragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  const count = selected.filter(Boolean).length;
  const accept = [canAddPdf ? "application/pdf" : "", canAddImage ? IMAGE_TYPES.join(",") : ""]
    .filter(Boolean)
    .join(",");

  return (
    <div
      className="tb-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={`tb-dialog${step.kind === "pages" ? " is-wide" : ""}`}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="tb-dialog-header">
          <h2 id={titleId}>{step.kind === "pages" ? fileName : "Add to board"}</h2>
          {!working && (
            <button aria-label="Close" className="tb-dialog-close" onClick={onClose} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          )}
        </header>

        {step.kind === "choose" && (
          <div className="tb-dialog-body">
            <button
              className={`tb-dropzone${dragging ? " is-over" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDrop={onDrop}
              type="button"
            >
              <FileUp aria-hidden="true" size={30} />
              <strong>{canAddPdf ? "Choose a PDF or an image" : "Choose an image"}</strong>
              <span>
                {canAddPdf ? "PDF up to 50 MB, or JPG, PNG or WebP. " : "JPG, PNG or WebP. "}
                You can also drop a file here.
              </span>
            </button>
            <input
              accept={accept}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleFile(file);
              }}
              ref={inputRef}
              tabIndex={-1}
              type="file"
            />
          </div>
        )}

        {step.kind === "opening" && (
          <div className="tb-dialog-body tb-dialog-status" role="status">
            Opening the PDF…
          </div>
        )}

        {step.kind === "pages" && pdf && (
          <>
            <div className="tb-dialog-toolbar">
              <span>
                {count} of {selected.length} pages selected
              </span>
              <button onClick={() => setSelected(selected.map(() => true))} type="button">
                Select all
              </button>
              <button onClick={() => setSelected(selected.map(() => false))} type="button">
                Select none
              </button>
            </div>
            <div className="tb-thumbs">
              {selected.map((checked, index) => (
                <PageThumb
                  checked={checked}
                  disabled={false}
                  enqueue={enqueueRef.current}
                  key={index}
                  onToggle={() =>
                    setSelected((current) => current.map((value, i) => (i === index ? !value : value)))
                  }
                  pageNumber={index + 1}
                  pdf={pdf}
                />
              ))}
            </div>
            <fieldset className="tb-placement">
              <legend>Where should the pages go?</legend>
              <label>
                <input
                  checked={placement === "stack"}
                  name="placement"
                  onChange={() => setPlacement("stack")}
                  type="radio"
                />
                <span>
                  <strong>Below the board, locked</strong>
                  <small>One under another. Students can write on them but can't move or erase them.</small>
                </span>
              </label>
              <label className={canUseTabs ? undefined : "is-disabled"}>
                <input
                  checked={placement === "tabs"}
                  disabled={!canUseTabs}
                  name="placement"
                  onChange={() => setPlacement("tabs")}
                  type="radio"
                />
                <span>
                  <strong>Each page on its own tab</strong>
                  <small>A new tab for every page, locked. The x on a tab can remove the whole PDF.</small>
                </span>
              </label>
              <label>
                <input
                  checked={placement === "view"}
                  name="placement"
                  onChange={() => setPlacement("view")}
                  type="radio"
                />
                <span>
                  <strong>Where I'm looking, movable</strong>
                  <small>Placed in view now. You can move and resize them.</small>
                </span>
              </label>
            </fieldset>
            <footer className="tb-dialog-footer">
              <button className="tb-dialog-secondary" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="tb-dialog-primary" disabled={count === 0} onClick={() => void addPages()} type="button">
                Add {count} page{count === 1 ? "" : "s"}
              </button>
            </footer>
          </>
        )}

        {step.kind === "working" && (
          <div className="tb-dialog-body">
            <p className="tb-dialog-status" role="status">
              {step.label}
            </p>
            <div
              aria-label="Progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(((step.done + step.fraction) / step.total) * 100)}
              className="tb-progress"
              role="progressbar"
            >
              <span style={{ width: `${((step.done + step.fraction) / step.total) * 100}%` }} />
            </div>
            {step.total > 1 && (
              <footer className="tb-dialog-footer">
                <button className="tb-dialog-secondary" onClick={() => abortRef.current?.abort()} type="button">
                  Cancel
                </button>
              </footer>
            )}
          </div>
        )}

        {(step.kind === "finished" || step.kind === "error") && (
          <div className="tb-dialog-body">
            <p className={step.kind === "error" ? "tb-dialog-error" : "tb-dialog-status"} role="alert">
              {step.message}
            </p>
            <footer className="tb-dialog-footer">
              {step.kind === "error" && (
                <button
                  className="tb-dialog-secondary"
                  onClick={() => setStep(pdf ? { kind: "pages" } : { kind: "choose" })}
                  type="button"
                >
                  Try again
                </button>
              )}
              <button className="tb-dialog-primary" onClick={onClose} type="button">
                Close
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
