import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, File, X } from "lucide-react";
import { canStreamToDisk, zipSizeBound } from "./lib/download";
import { formatBytes, MEMORY_LIMIT, ZIP_LIMIT, type Entry } from "./lib/model";

type DownloadKind = "zip" | "separate";

export function DownloadPrompt({
  entries,
  onBrowse,
  onDownload,
}: {
  entries: Entry[];
  onBrowse: () => void;
  onDownload: (kind: DownloadKind) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const submitted = useRef(false);
  const files = entries.filter((entry) => entry.kind === "file");
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  const zipBytes = zipSizeBound(entries);
  const disk = canStreamToDisk();
  const zipAvailable =
    zipBytes <= ZIP_LIMIT && (disk || zipBytes <= MEMORY_LIMIT);
  const separateAvailable =
    total <= MEMORY_LIMIT ||
    (disk &&
      (files.length === 1 || typeof window.showDirectoryPicker === "function"));
  const [kind, setKind] = useState<DownloadKind>(
    files.length > 1 && zipAvailable ? "zip" : "separate",
  );
  const available = kind === "zip" ? zipAvailable : separateAvailable;

  useEffect(() => {
    const element = dialog.current!;
    // Native modal semantics keep keyboard focus inside the confirmation.
    element.showModal();
    heading.current?.focus();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="download-prompt"
      aria-labelledby="download-prompt-title"
      aria-describedby="download-prompt-summary"
      onCancel={(event) => {
        event.preventDefault();
        onBrowse();
      }}
    >
      <div className="download-prompt-heading">
        <h2 id="download-prompt-title" tabIndex={-1} ref={heading}>
          {files.length ? "Download this share?" : "This share has no files."}
        </h2>
        <button
          className="icon-button"
          aria-label="Close download prompt"
          onClick={onBrowse}
        >
          <X size={20} />
        </button>
      </div>
      <p id="download-prompt-summary">
        {files.length
          ? `Your sender shared ${files.length} ${files.length === 1 ? "file" : "files"} (${formatBytes(total)}). Confirm to start downloading everything below.`
          : "Only empty folders are included. You can browse the share instead."}
      </p>
      {files.length > 0 && (
        <>
          <ul
            className="download-prompt-files"
            aria-label="Files to download"
            tabIndex={0}
          >
            {files.map((entry) => (
              <li key={entry.id}>
                <File size={17} aria-hidden="true" />
                <span>{entry.path}</span>
                <span className="download-prompt-size">
                  {formatBytes(entry.size)}
                </span>
              </li>
            ))}
          </ul>
          {files.length > 1 && (
            <label className="download-prompt-format">
              Save files as
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as DownloadKind)
                }
              >
                <option value="zip" disabled={!zipAvailable}>
                  One ZIP · TailShare.zip
                </option>
                <option value="separate" disabled={!separateAvailable}>
                  Separate files
                </option>
              </select>
            </label>
          )}
          <p className="download-prompt-help">
            {!available
              ? "This share exceeds this browser’s download limit. Browse to select fewer files, or open the link in desktop Chrome or Edge."
              : kind === "zip"
                ? "Folder paths are preserved in TailShare.zip. Your browser may ask where to save it."
                : files.length === 1
                  ? "The file keeps its original name. Your browser may ask where to save it."
                  : disk && window.showDirectoryPicker
                    ? "Choose a destination; the files will be saved in a new TailShare folder."
                    : "Your browser may ask you to allow multiple downloads."}
          </p>
        </>
      )}
      <div className="download-prompt-actions">
        <button className="button secondary" onClick={onBrowse}>
          Browse first
        </button>
        {files.length > 0 && (
          <button
            className="button primary"
            disabled={!available}
            onClick={() => {
              if (submitted.current) return;
              submitted.current = true;
              // Stay in the click's user activation for native destination pickers.
              onDownload(kind);
            }}
          >
            <ArrowDownToLine size={18} />
            {files.length === 1 ? "Download file" : "Download all files"}
          </button>
        )}
      </div>
    </dialog>
  );
}
