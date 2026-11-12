import { TransferTools } from "./TransferTools";
import { progressReporter } from "./lib/progress";
import { engineStatus, loadTransport, subscribeEngine } from "./lib/transport";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Copy,
  File,
  FileArchive,
  Folder,
  FolderOpen,
  HardDrive,
  Link,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Plus,
  Radio,
  Search,
  ShieldCheck,
  Square,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import {
  childrenOf,
  createShare,
  fileName,
  formatBytes,
  inviteKey,
  inviteLink,
  MEMORY_LIMIT,
  MAX_SHARE_USES,
  parseInvite,
  parseReceiveKey,
  ZIP_LIMIT,
  type Entry,
  type Invite,
  type LocalShare,
  type Manifest,
} from "./lib/model";
import { ShareClient, ShareHost, type Progress } from "./lib/session";
import {
  CLIClient,
  CLI_ROOT,
  type CLIPage,
  type FileReceiver,
} from "./lib/cli";
import { downloadCLI } from "./lib/cli-download";
import { CLISender, type UploadMode } from "./lib/cli-send";
import {
  canStreamToDisk,
  chooseSink,
  downloadSeparate,
  downloadZip,
  zipSizeBound,
} from "./lib/download";
import { droppedFiles, pickDirectory } from "./lib/picker";
import { DownloadPrompt } from "./DownloadPrompt";

// Remove credentials from the current history entry, including same-page navigation.
function consumeInviteHash() {
  const hash = /(?:^#|&)share=/.test(window.location.hash)
    ? window.location.hash
    : "";
  if (hash)
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  return hash;
}
const initialHash = consumeInviteHash();
const emptyShare = (): LocalShare => ({ entries: [], files: new Map() });
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";
export function App() {
  const [mode, setMode] = useState<"send" | "receive">(
    initialHash ? "receive" : "send",
  );
  const [share, setShare] = useState<LocalShare>(emptyShare);
  const [remote, setRemote] = useState<Entry[]>([]);
  const [path, setPath] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [key, setKey] = useState("");
  const [destination, setDestination] = useState<"browser" | "cli">("browser");
  const [receiverKey, setReceiverKey] = useState("");
  const [uploadMode, setUploadMode] = useState<UploadMode>("flat");
  const [invite, setInvite] = useState<Invite>();
  const [expires, setExpires] = useState("60");
  const [maxUses, setMaxUses] = useState(1);
  const [connectionCap, setConnectionCap] = useState<number | null>(null);
  const [uses, setUses] = useState(0);
  const [activeUntil, setActiveUntil] = useState<number | null>(0);
  const [peers, setPeers] = useState(0);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [cliSource, setCliSource] = useState(false);
  const [cliPage, setCliPage] = useState<CLIPage>();
  const [cliPageNumber, setCliPageNumber] = useState(0);
  const [cliTrail, setCliTrail] = useState<Entry[]>([]);
  const cliFolder = cliTrail.at(-1) ?? CLI_ROOT;
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [progress, commitProgress] = useState<Progress>();
  const progressUpdates = useMemo(() => progressReporter(commitProgress), []);
  const setProgress = progressUpdates.report;
  useEffect(() => () => progressUpdates.dispose(), [progressUpdates]);
  const engine = useSyncExternalStore(subscribeEngine, engineStatus);
  const [drag, setDrag] = useState(false);
  const [copied, setCopied] = useState("");
  const host = useRef<ShareHost | undefined>(undefined);
  const client = useRef<FileReceiver | undefined>(undefined);
  const uploader = useRef<CLISender | undefined>(undefined);
  const generation = useRef(0);
  const filesInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const fileRows = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (cliPage && fileRows.current) fileRows.current.scrollTop = 0;
  }, [cliPage]);
  const entries = mode === "send" ? share.entries : remote;
  const files = entries.filter((e) => e.kind === "file");
  const total = files.reduce((n, e) => n + e.size, 0);
  const rows = childrenOf(entries, path).filter((e) =>
    fileName(e.path).toLowerCase().includes(search.toLowerCase()),
  );
  const chosen = (cliSource ? entries : files).filter((e) =>
    selected.has(e.id),
  );
  const active = !!invite || connected;
  useEffect(() => {
    if (engine.phase === "error" && (active || progress)) {
      stop();
      setError(engine.message);
    }
  }, [engine, active, !!progress]);
  const locked = !!invite || !!busy;
  const sendingToCLI = mode === "send" && destination === "cli";
  const directDisk = canStreamToDisk();
  const exhausted = !!invite && connectionCap !== null && uses >= connectionCap;
  const invalidUses =
    expires === "uses" &&
    (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > MAX_SHARE_USES);
  function clearFeedback() {
    setError("");
    setNotice("");
  }
  function switchMode(next: "send" | "receive") {
    if (next !== mode && client.current) stop();
    setMode(next);
    setPath("");
    setSearch("");
    setSelected(new Set());
    setReceiverKey("");
    clearFeedback();
  }
  function stop() {
    const wasSender = !!host.current;
    const wasUpload = !!uploader.current;
    generation.current++;
    host.current?.stop();
    host.current = undefined;
    void client.current?.disconnect();
    client.current = undefined;
    uploader.current?.close();
    uploader.current = undefined;
    setReceiverKey("");
    setInvite(undefined);
    setConnected(false);
    setCliSource(false);
    setCliPage(undefined);
    setCliPageNumber(0);
    setCliTrail([]);
    setConfirmDownload(false);
    setRemote([]);
    setPeers(0);
    setUses(0);
    setConnectionCap(null);
    setBusy("");
    setProgress(undefined);
    setActiveUntil(0);
    setPath("");
    setSelected(new Set());
    setKey("");
    setNotice(
      wasUpload
        ? "Transfer stopped. Completed and partial files may remain in the CLI inbox. Paste the receiver’s key again to start a new transfer."
        : wasSender
          ? "Session closed. Its link no longer gives access to your files."
          : "Disconnected. Paste the sender’s link or key again to reconnect.",
    );
  }
  async function connect(
    value = key,
    fromLink = /^https?:\/\//i.test(value.trim()),
  ) {
    clearFeedback();
    setConfirmDownload(false);
    const current = ++generation.current;
    try {
      const parsed = parseReceiveKey(value);
      setKey("");
      setBusy(
        parsed.kind === "cli" ? "Reading CLI share" : "Connecting to sender",
      );
      client.current?.close();
      uploader.current?.close();
      let next: FileReceiver;
      let manifest: Manifest;
      let skipped = 0;
      if (parsed.kind === "cli") {
        const receiver = new CLIClient();
        next = receiver;
        client.current = receiver;
        manifest = await receiver.connect(parsed.address);
        skipped = receiver.skipped;
        if (generation.current === current) {
          setCliPage(receiver.page);
          setCliPageNumber(0);
          setCliTrail([]);
        }
      } else {
        const receiver = new ShareClient();
        next = receiver;
        client.current = receiver;
        manifest = await receiver.connect(parsed.invite);
      }
      if (generation.current !== current) {
        next.close();
        return;
      }
      setRemote(manifest.entries);
      setActiveUntil(manifest.expiresAt);
      setConnected(true);
      setCliSource(parsed.kind === "cli");
      setPath("");
      setSearch("");
      setSelected(new Set());
      setConfirmDownload(fromLink && parsed.kind === "browser");
      setNotice(
        parsed.kind === "cli"
          ? `Connected to CLI share. Choose what you want to download.${skipped ? ` Symbolic links and special files skipped: ${skipped}.` : ""}`
          : "Connected. Choose what you want to download.",
      );
    } catch (err) {
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setBusy("");
    }
  }
  useEffect(() => {
    if (initialHash) void connect(initialHash, true);
    const openLink = () => {
      const value = consumeInviteHash();
      if (!value) return;
      try {
        parseInvite(value);
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
      // Following another invitation replaces this tab's previous session,
      // just as opening a new page would, including any in-flight transfer.
      stop();
      setMode("receive");
      void connect(value, true);
    };
    window.addEventListener("hashchange", openLink);
    return () => {
      window.removeEventListener("hashchange", openLink);
      host.current?.stop();
      client.current?.close();
      uploader.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!active && !busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, busy]);
  async function addSelection(next: Promise<LocalShare> | LocalShare) {
    clearFeedback();
    setBusy("Reading your selection");
    try {
      const selection = await next;
      if (!selection.entries.length)
        throw new Error("No readable files were selected.");
      setShare(selection);
      // Warm only static transport assets; no relay or peer connection is opened.
      void loadTransport().catch(() => {});
      setPath("");
      setSent(0);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }
  async function startShare() {
    clearFeedback();
    setBusy("Opening encrypted connection");
    const current = ++generation.current;
    let next: ShareHost | undefined;
    try {
      const policy = {
        minutes:
          expires === "never" || expires === "uses" ? null : Number(expires),
        maxUses: expires === "uses" ? maxUses : null,
      };
      next = new ShareHost(share, policy, (event) => {
        if (generation.current !== current) return;
        if (event.type === "peers") setPeers(event.count);
        if (event.type === "sent") setSent((n) => n + event.bytes);
        if (event.type === "uses") {
          setUses(event.count);
          if (event.limit !== null && event.count >= event.limit)
            setNotice(
              "Link and key expired. Current recipients can finish; new connections are blocked.",
            );
        }
        if (event.type === "expired") {
          host.current = undefined;
          setInvite(undefined);
          setPeers(0);
          setActiveUntil(0);
          setNotice(
            event.reason === "time"
              ? "The time limit expired. Link, key, and active connections are now closed."
              : "All uses were consumed and the last recipient disconnected. Create a new link to share again.",
          );
        }
      });
      host.current = next;
      setUses(0);
      setSent(0);
      setConnectionCap(policy.maxUses);
      const result = await next.start();
      if (generation.current !== current) {
        next.stop();
        return;
      }
      setInvite(result);
      setActiveUntil(next.expiresAt);
      setNotice("Share is open. Send the link through a trusted channel.");
    } catch (err) {
      next?.stop();
      if (generation.current === current) setError(errorMessage(err));
    } finally {
      if (generation.current === current) setBusy("");
    }
  }
  async function sendToCLI() {
    if (busy || invite || connected) return;
    clearFeedback();
    const current = ++generation.current;
    const next = new CLISender();
    uploader.current = next;
    const address = receiverKey;
    setReceiverKey("");
    setBusy("Sending to CLI");
    try {
      const result = await next.send(address, share, uploadMode, (p) => {
        if (generation.current === current) setProgress(p);
      });
      if (generation.current === current)
        setNotice(
          uploadMode === "tree"
            ? `Transfer complete. Files and folders were sent into ${result.root}.`
            : uploadMode === "zip"
              ? "ZIP sent. The CLI confirms its size; check the recipient’s inbox."
              : `${result.files} ${result.files === 1 ? "file sent" : "files sent"}. The default CLI inbox assigns unique names.`,
        );
    } catch (err) {
      if (generation.current === current)
        setError(
          `${errorMessage(err)} Completed or partial files may remain in the CLI inbox. Check it before retrying; a new transfer can create duplicates.`,
        );
    } finally {
      next.close();
      if (generation.current === current) {
        uploader.current = undefined;
        setBusy("");
        setProgress(undefined);
      }
    }
  }
  async function copy(kind: "link" | "key") {
    if (!invite || exhausted) return;
    try {
      await navigator.clipboard.writeText(
        kind === "link" ? inviteLink(invite) : inviteKey(invite),
      );
      setCopied(kind);
      setTimeout(() => setCopied(""), 2500);
    } catch {
      setError(
        "Clipboard access is unavailable. Select and copy the link below.",
      );
    }
  }
  function remove(entry: Entry) {
    setShare((previous) => ({
      entries: previous.entries.filter(
        (e) => e.id !== entry.id && !e.path.startsWith(entry.path + "/"),
      ),
      files: new Map(
        [...previous.files].filter(([id]) =>
          previous.entries.some(
            (e) =>
              e.id === id &&
              e.id !== entry.id &&
              !e.path.startsWith(entry.path + "/"),
          ),
        ),
      ),
    }));
  }
  async function browseCLI(folder = cliFolder, index = 0, refresh = false) {
    const receiver = client.current;
    if (!(receiver instanceof CLIClient) || busy) return;
    const current = generation.current;
    clearFeedback();
    setBusy("Reading folder");
    try {
      const page = await receiver.browse(folder, index, refresh);
      if (current !== generation.current) return;
      setRemote(page.entries);
      setCliPage(page);
      setCliPageNumber(receiver.pageNumber);
      setPath(folder.path);
      setSearch("");
      setSelected(new Set());
      setCliTrail((previous) =>
        folder.path
          ? [
              ...previous.filter((e) => folder.path.startsWith(e.path + "/")),
              folder,
            ]
          : [],
      );
      if (page.skipped)
        setNotice(
          `Symbolic links and special files skipped on this page: ${page.skipped}.`,
        );
    } catch (error) {
      if (current === generation.current) {
        setError(errorMessage(error));
        if (receiver.closed) {
          setConnected(false);
          setRemote([]);
          setActiveUntil(0);
        }
      }
    } finally {
      if (current === generation.current) setBusy("");
    }
  }
  function navigate(path: string, entry?: Entry) {
    if (cliSource) {
      const folder = entry ?? cliTrail.find((e) => e.path === path) ?? CLI_ROOT;
      void browseCLI(folder);
    } else {
      setPath(path);
      setSearch("");
    }
  }
  function toggle(entry: Entry) {
    const targets =
      cliSource || entry.kind === "file"
        ? [entry]
        : files.filter((e) => e.path.startsWith(entry.path + "/"));
    setSelected((previous) => {
      const next = new Set(previous);
      const all = targets.every((e) => next.has(e.id));
      targets.forEach((e) => (all ? next.delete(e.id) : next.add(e.id)));
      return next;
    });
  }
  async function download(
    kind: "zip" | "separate",
    selection = chosen.length ? chosen : cliSource ? [cliFolder] : entries,
  ) {
    const receiver = client.current;
    if (!receiver || busy) return;
    clearFeedback();
    const current = generation.current;
    const markProgress = (p: Progress) => {
      if (current === generation.current) setProgress(p);
    };
    const targets = selection.filter((entry) => entry.kind === "file");
    if (!targets.length && !cliSource) return;
    setBusy(kind === "zip" ? "Building your ZIP" : "Downloading files");
    try {
      if (receiver instanceof CLIClient) {
        const count = await downloadCLI(
          receiver,
          selection,
          kind,
          markProgress,
          (files) => {
            if (current === generation.current)
              setBusy(
                `${kind === "zip" ? "Building ZIP" : "Downloading"} · ${files.toLocaleString()} files found`,
              );
          },
        );
        if (current === generation.current)
          setNotice(
            count
              ? `${count === 1 ? "File" : "Files"} downloaded. Check your downloads. Keep the connection open to download more.`
              : "No files in this selection. Empty folders are preserved in ZIP or supported folder saves.",
          );
        return;
      }
      if (kind === "zip") {
        const zipEntries = selection;
        const bound = zipSizeBound(zipEntries);
        if (bound > ZIP_LIMIT)
          throw new Error(
            "ZIP downloads are limited to 4 GB. Download these files separately.",
          );
        const output = await chooseSink("TailShare.zip", bound);
        await downloadZip(receiver, zipEntries, output, markProgress);
      } else {
        await downloadSeparate(receiver, targets, markProgress);
      }
      if (current === generation.current)
        setNotice(
          `${targets.length === 1 ? "File" : "Files"} ${cliSource ? "downloaded" : "verified"}. Check your downloads. Keep the connection open to download more.`,
        );
    } catch (err) {
      if (
        current === generation.current &&
        !(err instanceof DOMException && err.name === "AbortError")
      ) {
        setError(
          errorMessage(err) +
            (cliSource && kind === "separate"
              ? " Earlier files may already be saved."
              : ""),
        );
        if (client.current?.closed) {
          setConnected(false);
          setRemote([]);
          setActiveUntil(0);
        }
      }
    } finally {
      if (current === generation.current) {
        setBusy("");
        setProgress(undefined);
      }
    }
  }
  return (
    <div className="app-shell">
      {confirmDownload && connected && (
        <DownloadPrompt
          entries={remote}
          onBrowse={() => setConfirmDownload(false)}
          onDownload={(kind) => {
            setConfirmDownload(false);
            // Pass the full manifest explicitly: a link always offers the whole share.
            void download(kind, remote);
          }}
        />
      )}
      <header className="site-header">
        <a
          className="brand"
          href={window.location.pathname}
          aria-label="TailShare home"
        >
          <span className="brand-symbol">
            <ArrowUpRight />
            <ArrowUpRight />
          </span>
          <span>
            Tail<span>Share</span>
          </span>
          <span className="brand-version">beta</span>
        </a>
        <div className="header-note">
          <span className="status-dot" /> Browser &amp; CLI sharing
        </div>
        <a className="about-link" href="#how-it-works">
          How it works <ArrowUpRight size={15} />
        </a>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <div>
            <h1 id="page-title">
              Your files.
              <br />
              {sendingToCLI ? "Their inbox" : "Their browser"}
              <span className="title-dot">.</span>
            </h1>
            <p>
              A private line between your devices.
              <br className="mobile-break" /> Pick your files.{" "}
              {sendingToCLI ? "Use their key." : "Pass the link."} Stay
              connected.
            </p>
          </div>
          <div
            className="route"
            aria-label="Files travel through an encrypted Tailcat connection"
          >
            <div className="endpoint">
              <div className="device">
                <Monitor size={30} />
                <span className="device-light" />
              </div>
              <span>Your device</span>
            </div>
            <div className="route-line">
              <span />
              <LockKeyhole size={19} />
              <span />
              <small>Encrypted with Tailcat</small>
            </div>
            <div className="endpoint receiver">
              <div className="device">
                <Monitor size={30} />
                <span className="device-light" />
              </div>
              <span>Their device</span>
            </div>
          </div>
        </section>
        <div className="workspace">
          <section className="console" aria-label="File transfer">
            <div className="console-bar">
              <span className="console-mark">
                <span />
                <span />
                <span />
              </span>
              <span>
                {mode === "send"
                  ? invite
                    ? "Share is live"
                    : "New transmission"
                  : connected
                    ? "Incoming share"
                    : "Receive a transmission"}
              </span>
              <span className="console-tag">TAILSHARE / 01</span>
            </div>
            <div className="tabs" role="group" aria-label="Transfer mode">
              <button
                aria-pressed={mode === "send"}
                disabled={!!busy || connected}
                onClick={() => switchMode("send")}
              >
                <ArrowUpFromLine size={18} /> Send files{" "}
                {invite && <span className="live-label">Live</span>}
              </button>
              <button
                aria-pressed={mode === "receive"}
                disabled={!!busy || !!invite}
                onClick={() => switchMode("receive")}
              >
                <ArrowDownToLine size={18} /> Receive files
              </button>
            </div>
            {mode === "send" && !invite && (
              <label className="send-destination">
                Send to
                <select
                  value={destination}
                  disabled={locked}
                  onChange={(e) => {
                    setDestination(e.target.value as "browser" | "cli");
                    setReceiverKey("");
                    clearFeedback();
                  }}
                >
                  <option value="browser">Browser · share link</option>
                  <option value="cli">Tailcat CLI · receiver key</option>
                </select>
              </label>
            )}
            {mode === "receive" && !connected ? (
              <div className="receive-bay">
                <div className="bay-icon">
                  <Link size={30} />
                </div>
                <h2>Connect to your sender.</h2>
                <p>
                  Paste a TailShare link, share key, or Tailcat CLI key.
                  <br />
                  The sender keeps their browser or CLI running.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect();
                  }}
                >
                  <label htmlFor="share-key">Share link or key</label>
                  <textarea
                    id="share-key"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste a TailShare link/key or a tc… CLI key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    disabled={!!busy}
                  />
                  <button
                    className="button primary"
                    disabled={!key.trim() || !!busy}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Link size={18} />
                    )}{" "}
                    {busy || "Connect to sender"}
                  </button>
                </form>
              </div>
            ) : (
              <>
                {entries.length === 0 && mode === "send" ? (
                  <div
                    className={`drop-bay ${drag ? "dragging" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!locked) setDrag(true);
                    }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDrag(false);
                      if (!locked)
                        void addSelection(droppedFiles(e.dataTransfer));
                    }}
                  >
                    <div className="bay-icon">
                      <FolderOpen size={39} />
                      <span>
                        <Plus size={13} />
                      </span>
                    </div>
                    <h2>Drop something good.</h2>
                    <p>
                      One file, a few favorites, or an entire folder.
                      <br />
                      {sendingToCLI
                        ? "Choose what to send to the receiver’s inbox."
                        : "It all stays on your device until they download."}
                    </p>
                    <div className="picker-buttons">
                      <button
                        className="button primary"
                        disabled={locked}
                        onClick={() => filesInput.current?.click()}
                      >
                        <Plus size={18} /> Choose files
                      </button>
                      <button
                        className="button secondary"
                        disabled={locked}
                        onClick={() =>
                          window.showDirectoryPicker
                            ? void addSelection(pickDirectory())
                            : directoryInput.current?.click()
                        }
                      >
                        <Folder size={18} /> Choose folder
                      </button>
                    </div>
                    <span className="drop-caption">
                      Or drag files and folders here
                    </span>
                  </div>
                ) : (
                  <div className="file-browser">
                    <div className="browser-toolbar">
                      <nav className="breadcrumbs" aria-label="Folder path">
                        <button
                          disabled={cliSource && !!busy}
                          onClick={() => navigate("")}
                        >
                          <HardDrive size={16} />
                          <span>Shared files</span>
                        </button>
                        {path
                          .split("/")
                          .filter(Boolean)
                          .map((part, i) => (
                            <span key={i}>
                              <ChevronRight size={13} />
                              <button
                                disabled={cliSource && !!busy}
                                onClick={() =>
                                  navigate(
                                    path
                                      .split("/")
                                      .slice(0, i + 1)
                                      .join("/"),
                                  )
                                }
                              >
                                {part}
                              </button>
                            </span>
                          ))}
                      </nav>
                      <label className="search">
                        <Search size={16} />
                        <input
                          aria-label={
                            cliSource
                              ? "Filter this page"
                              : "Search this folder"
                          }
                          value={search}
                          placeholder={
                            cliSource ? "Filter this page" : "Find a file"
                          }
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                    </div>
                    <div
                      className="file-table"
                      role="table"
                      aria-label="Shared files"
                      aria-busy={cliSource && !!busy}
                    >
                      <div className="file-row table-heading" role="row">
                        <span role="columnheader">Name</span>
                        <span role="columnheader">Size</span>
                        <span role="columnheader" className="file-action-label">
                          {mode === "send" ? "Selected" : "Download"}
                        </span>
                      </div>
                      <div className="file-rows" ref={fileRows}>
                        {rows.map((entry) => (
                          <div className="file-row" role="row" key={entry.id}>
                            <div className="file-name" role="cell">
                              {mode === "receive" && (
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${fileName(entry.path)}`}
                                  checked={
                                    cliSource || entry.kind === "file"
                                      ? selected.has(entry.id)
                                      : files.some((e) =>
                                          e.path.startsWith(entry.path + "/"),
                                        ) &&
                                        files
                                          .filter((e) =>
                                            e.path.startsWith(entry.path + "/"),
                                          )
                                          .every((e) => selected.has(e.id))
                                  }
                                  onChange={() => toggle(entry)}
                                  disabled={!!busy}
                                />
                              )}
                              {entry.kind === "directory" ? (
                                <Folder className="folder-icon" size={20} />
                              ) : (
                                <File className="file-icon" size={19} />
                              )}
                              {entry.kind === "directory" ? (
                                <button
                                  className="folder-name"
                                  disabled={cliSource && !!busy}
                                  onClick={() => navigate(entry.path, entry)}
                                >
                                  {fileName(entry.path)}
                                  <ChevronRight size={14} />
                                </button>
                              ) : (
                                <span title={entry.path}>
                                  {fileName(entry.path)}
                                </span>
                              )}
                            </div>
                            <span className="file-size" role="cell">
                              {entry.kind === "directory"
                                ? "Folder"
                                : formatBytes(entry.size)}
                            </span>
                            <span className="file-action" role="cell">
                              {mode === "send" ? (
                                invite ? (
                                  <ShieldCheck size={16} />
                                ) : (
                                  <button
                                    className="icon-button"
                                    disabled={locked}
                                    aria-label={`Remove ${fileName(entry.path)}`}
                                    onClick={() => remove(entry)}
                                  >
                                    <X size={16} />
                                  </button>
                                )
                              ) : entry.kind === "file" ? (
                                <button
                                  className="icon-button"
                                  disabled={!!busy}
                                  aria-label={`Download ${fileName(entry.path)}`}
                                  onClick={() =>
                                    void download("separate", [entry])
                                  }
                                >
                                  <ArrowDownToLine size={17} />
                                </button>
                              ) : (
                                <ChevronRight size={16} />
                              )}
                            </span>
                          </div>
                        ))}
                        {!rows.length && (
                          <p className="empty-folder">
                            {search
                              ? "No files match your search."
                              : cliSource && !cliPage?.done
                                ? "No downloadable entries on this page. Try the next page."
                                : cliSource && cliPageNumber > 0
                                  ? "End of this folder."
                                  : "This folder is empty."}
                          </p>
                        )}
                      </div>
                    </div>
                    {cliSource && (
                      <div className="cli-pagination">
                        <div
                          className="cli-page-controls"
                          aria-label="Directory pages"
                        >
                          <button
                            className="button secondary"
                            disabled={!!busy || cliPageNumber === 0}
                            onClick={() =>
                              void browseCLI(cliFolder, cliPageNumber - 1)
                            }
                          >
                            Previous page
                          </button>
                          <span>
                            Page {(cliPageNumber + 1).toLocaleString()}
                          </span>
                          <button
                            className="button secondary"
                            disabled={!!busy || !!cliPage?.done}
                            onClick={() =>
                              void browseCLI(cliFolder, cliPageNumber + 1)
                            }
                          >
                            Next page
                          </button>
                          <button
                            className="button secondary"
                            disabled={!!busy}
                            onClick={() => void browseCLI(cliFolder, 0, true)}
                          >
                            Refresh folder
                          </button>
                        </div>
                        <p>
                          Folders load when opened. Filtering and selections
                          apply to this page. Folder downloads include unopened
                          subfolders.
                        </p>
                      </div>
                    )}
                    <div className="file-summary">
                      <span>
                        {cliSource
                          ? `${entries.length.toLocaleString()} items on this page`
                          : `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}`}{" "}
                        <span className="separator">/</span>{" "}
                        {formatBytes(total)}
                        {cliSource && " in files"}
                        {chosen.length > 0 && ` / ${chosen.length} selected`}
                      </span>
                      {mode === "send" && !invite && (
                        <button
                          disabled={locked}
                          onClick={() => {
                            setShare(emptyShare());
                            setPath("");
                          }}
                        >
                          Clear selection
                        </button>
                      )}
                      {mode === "receive" && (
                        <button
                          disabled={!!busy}
                          onClick={() =>
                            setSelected(
                              selected.size
                                ? new Set()
                                : new Set(
                                    (cliSource ? rows : files).map((f) => f.id),
                                  ),
                            )
                          }
                        >
                          {selected.size
                            ? "Clear selection"
                            : cliSource
                              ? "Select visible items"
                              : "Select all"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {sendingToCLI && (
                  <div className="cli-send-options">
                    <label htmlFor="receiver-key">
                      CLI receiver key
                      <textarea
                        id="receiver-key"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Paste the tc… key from tailcat recv"
                        value={receiverKey}
                        disabled={!!busy}
                        onChange={(e) => setReceiverKey(e.target.value)}
                      />
                    </label>
                    <label htmlFor="upload-format">
                      Send as
                      <select
                        id="upload-format"
                        value={uploadMode}
                        disabled={!!busy}
                        aria-describedby="upload-format-help"
                        onChange={(e) =>
                          setUploadMode(e.target.value as UploadMode)
                        }
                      >
                        <option value="flat">Separate files</option>
                        <option value="zip">ZIP archive</option>
                        <option value="tree">
                          Folder tree (--accept-dirs)
                        </option>
                      </select>
                    </label>
                    <p id="upload-format-help">
                      {uploadMode === "flat"
                        ? "Sends every selected file into the inbox, without folder paths or empty folders. The default CLI assigns unique names. Choose ZIP to keep names and paths together."
                        : uploadMode === "zip"
                          ? "Keeps file names, folder paths, and empty folders in one ZIP. Streams from your device; up to 4 GB, without compression."
                          : "Keeps files and empty folders in a new TailShare folder. The recipient must use tailcat recv --accept-dirs."}
                    </p>
                  </div>
                )}
                <div className="action-rail">
                  {mode === "send" ? (
                    <>
                      <div className="action-hint">
                        <ShieldCheck size={17} />
                        <span>
                          {sendingToCLI
                            ? "Only the files shown here will be sent."
                            : exhausted
                              ? "New connections are blocked. Current recipients can finish."
                              : invite
                                ? "Only people with your link have access."
                                : "Nothing is shared until you create a link."}
                        </span>
                      </div>
                      {invite ? (
                        <button
                          className="button primary"
                          disabled={exhausted}
                          onClick={() => void copy("link")}
                        >
                          {copied === "link" ? (
                            <Check size={17} />
                          ) : (
                            <Copy size={17} />
                          )}{" "}
                          {copied === "link"
                            ? "Link copied"
                            : exhausted
                              ? "Link expired"
                              : "Copy share link"}
                        </button>
                      ) : (
                        <button
                          className="button primary"
                          disabled={
                            !entries.length ||
                            !!busy ||
                            (sendingToCLI ? !receiverKey.trim() : invalidUses)
                          }
                          onClick={() =>
                            void (sendingToCLI ? sendToCLI() : startShare())
                          }
                        >
                          {busy ? (
                            <LoaderCircle className="spin" size={17} />
                          ) : sendingToCLI ? (
                            <Upload size={17} />
                          ) : (
                            <Link size={17} />
                          )}{" "}
                          {busy ||
                            (sendingToCLI
                              ? "Send to CLI"
                              : "Create share link")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        className="button secondary"
                        disabled={(!cliSource && !files.length) || !!busy}
                        onClick={() => void download("separate")}
                      >
                        <ArrowDownToLine size={17} />{" "}
                        {cliSource && chosen.length
                          ? "Download selected"
                          : "Download separately"}
                      </button>
                      <button
                        className="button primary"
                        disabled={(!cliSource && !files.length) || !!busy}
                        onClick={() => void download("zip")}
                      >
                        <FileArchive size={17} />{" "}
                        {chosen.length
                          ? cliSource
                            ? "ZIP selected items"
                            : "ZIP selected files"
                          : cliSource && path
                            ? "Download folder as ZIP"
                            : "Download all as ZIP"}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
            {progress && (
              <div className="transfer-progress">
                <div>
                  <span>{fileName(progress.entry.path)}</span>
                  <span>
                    {formatBytes(progress.bytes)} /{" "}
                    {formatBytes(progress.total)}
                  </span>
                </div>
                <progress
                  value={progress.bytes}
                  max={Math.max(1, progress.total)}
                  aria-label={
                    sendingToCLI ? "Upload progress" : "Download progress"
                  }
                />
              </div>
            )}
            <div className="feedback" aria-live="polite">
              {error && (
                <div className="error" role="alert">
                  <span>{error}</span>
                  <button
                    className="icon-button"
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={17} />
                  </button>
                </div>
              )}
              {notice && !error && (
                <div className="notice">
                  <CheckCheck size={17} />
                  <span>{notice}</span>
                </div>
              )}
              {busy && (
                <div className="working">
                  <LoaderCircle className="spin" size={16} />
                  <span>{busy}…</span>
                  {(host.current || client.current || uploader.current) && (
                    <button onClick={stop}>Cancel</button>
                  )}
                </div>
              )}
            </div>
          </section>
          <aside className="session-rail" aria-label="Session details">
            <TransferTools
              active={!!invite || !!progress || !!uploader.current}
            />
            <div className="session-heading">
              <Radio size={20} />
              <h2>
                {sendingToCLI && busy
                  ? "Sending to CLI"
                  : active
                    ? "Your connection"
                    : "Ready when you are"}
              </h2>
              <span
                className={`status-dot ${active || (sendingToCLI && busy) ? "is-live" : ""}`}
              />
            </div>
            {sendingToCLI ? (
              <>
                <p className="session-description">
                  Ask the recipient to create an inbox folder, start the CLI,
                  and send you its key privately.
                </p>
                <pre className="cli-command">
                  <code>
                    {uploadMode === "tree"
                      ? "tailcat recv --key=new --accept-dirs ./inbox"
                      : "tailcat recv --key=new ./inbox"}
                  </code>
                </pre>
                <p className="session-description">
                  Select your files, paste their key, and choose Send to CLI. No
                  link is created for this transfer.
                </p>
                <p className="session-description">
                  The CLI confirms writes and file size over encrypted SFTP. Its
                  write-only inbox cannot provide a read-back checksum.
                </p>
                <p className="session-description">
                  Cancellation can leave partial files. Check the inbox before
                  retrying.
                </p>
              </>
            ) : invite ? (
              <>
                <p className="session-description">
                  {exhausted
                    ? "All uses consumed. Your link and key no longer accept connections. Keep this tab open for current recipients."
                    : "Your share is live. Send this link through a trusted conversation."}
                </p>
                {!exhausted && (
                  <>
                    <label className="link-label" htmlFor="invite-link">
                      Private share link
                    </label>
                    <div className="link-box">
                      <input
                        id="invite-link"
                        readOnly
                        value={inviteLink(invite)}
                        onFocus={(e) => e.target.select()}
                      />
                      <button
                        className="icon-button"
                        aria-label="Copy private share link"
                        onClick={() => void copy("link")}
                      >
                        {copied === "link" ? (
                          <Check size={17} />
                        ) : (
                          <Copy size={17} />
                        )}
                      </button>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => void copy("key")}
                    >
                      {copied === "key"
                        ? "Key copied"
                        : "Copy share key instead"}{" "}
                      <Copy size={13} />
                    </button>
                  </>
                )}
                <div className="session-stats">
                  {connectionCap !== null && (
                    <div>
                      <span>Recipient connections used</span>
                      <strong>
                        {uses} / {connectionCap}
                      </strong>
                    </div>
                  )}
                  <div>
                    <span>Recipients connected</span>
                    <strong>{peers}</strong>
                  </div>
                  <div>
                    <span>Data sent</span>
                    <strong>{formatBytes(sent)}</strong>
                  </div>
                </div>
              </>
            ) : connected ? (
              <>
                <p className="session-description">
                  {cliSource
                    ? "You’re browsing a Tailcat CLI share. Downloads are read-only; keep the sender’s CLI running."
                    : "You’re connected to the sender. Browse their selection and take what you need."}
                </p>
                <div className="connection-badge">
                  <LockKeyhole size={18} /> Encrypted connection
                </div>
                {cliSource && (
                  <p className="session-description">
                    File contents travel over authenticated SFTP. Open folders
                    as needed and use Next page for more entries. Refresh folder
                    reloads its listing. Symbolic links and special files are
                    skipped.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="session-description">
                  No account. No upload queue.
                  <br /> Just your files and a private link.
                </p>
                <ol className="steps">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>
                        {mode === "receive"
                          ? "Get a link or key"
                          : "Pick your files"}
                      </strong>
                      <p>
                        {mode === "receive"
                          ? "Ask your sender to share it privately."
                          : "Share only what you choose."}
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>
                        {mode === "receive"
                          ? "Connect to sender"
                          : "Pass the link"}
                      </strong>
                      <p>
                        {mode === "receive"
                          ? "Paste the link or key in the field."
                          : "Send it somewhere you trust."}
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>
                        {mode === "receive"
                          ? "Choose your downloads"
                          : "Keep this tab open"}
                      </strong>
                      <p>
                        {mode === "receive"
                          ? "Browse files or save a ZIP."
                          : "Your browser is the source."}
                      </p>
                    </div>
                  </li>
                </ol>
              </>
            )}
            {mode === "send" && !invite && !sendingToCLI && (
              <div className="expiry-settings">
                <label className="expiry-label">
                  Link &amp; key expiry
                  <select
                    value={expires}
                    disabled={!!busy}
                    aria-describedby="expiry-help"
                    onChange={(e) => setExpires(e.target.value)}
                  >
                    <option value={15}>15 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value="never">Never (while tab is open)</option>
                    <option value="uses">After a number of uses</option>
                  </select>
                </label>
                {expires === "uses" && (
                  <label className="expiry-label">
                    Recipient connections
                    <input
                      type="number"
                      min={1}
                      max={MAX_SHARE_USES}
                      step={1}
                      inputMode="numeric"
                      value={Number.isNaN(maxUses) ? "" : maxUses}
                      disabled={!!busy}
                      aria-invalid={invalidUses}
                      aria-describedby="expiry-help"
                      onChange={(event) =>
                        setMaxUses(event.target.valueAsNumber)
                      }
                    />
                  </label>
                )}
                <p id="expiry-help">
                  {expires === "uses"
                    ? invalidUses
                      ? `Enter a whole number from 1 to ${MAX_SHARE_USES}.`
                      : "One use is one recipient connection. Reconnecting counts again. Current recipients can finish after the last use."
                    : expires === "never"
                      ? "No time limit. Closing this tab or stopping sharing revokes the link and key."
                      : "The link, key, and active transfers close when the time runs out."}
                </p>
              </div>
            )}
            {activeUntil !== null && activeUntil > 0 && (
              <div className="expires-at">
                Expires at{" "}
                <time dateTime={new Date(activeUntil).toISOString()}>
                  {new Date(activeUntil).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            )}
            {active && activeUntil === null && (
              <div className="expires-at">
                {cliSource
                  ? "Available while the sender’s CLI is running."
                  : "No time limit · Keep the sender’s tab open."}
              </div>
            )}
            {active && (
              <button className="button danger" onClick={stop}>
                <Unplug size={17} /> {invite ? "Stop sharing" : "Disconnect"}
              </button>
            )}
            <div className="stay-open">
              <Monitor size={19} />
              <p>
                {sendingToCLI
                  ? "Keep this browser in the foreground and the recipient’s CLI running until the upload finishes."
                  : cliSource
                    ? "Keep this browser open and the sender’s CLI online until the download finishes."
                    : mode === "receive" && !connected
                      ? "Keep this browser open and the sender’s browser or CLI online until the download finishes."
                      : "Keep both browsers open and awake until the download finishes."}
              </p>
            </div>
          </aside>
        </div>
        {mode === "receive" && (
          <div className="compatibility">
            <HardDrive size={17} />
            <p>
              {directDisk
                ? "This browser can stream downloads straight to disk. ZIP archives are limited to 4 GB."
                : "This browser saves in memory: up to 256 MB per download, including ZIP overhead. Use desktop Chrome or Edge for larger files."}{" "}
              For separate files, Chrome/Edge saves a batch into a new folder;
              other browsers may ask to allow multiple downloads. On mobile,
              keep TailShare in the foreground.
            </p>
          </div>
        )}
        <section className="trust-strip" id="how-it-works">
          <div>
            <ShieldCheck />
            <span>End-to-end encrypted</span>
          </div>
          <div>
            <HardDrive />
            <span>No hosted file storage</span>
          </div>
          <div>
            <Square />
            <span>
              {sendingToCLI
                ? "Only selected files are sent"
                : "Your link stops when sharing ends"}
            </span>
          </div>
        </section>
        <details className="security-notes">
          <summary>How your files travel</summary>
          <div>
            <p>
              TailShare uses Tailcat WASM and WireGuard encryption. Browsers
              connect through Tailscale’s DERP relays, which carry encrypted
              traffic and can observe connection timing and traffic volume.
              There is no TailShare application server or file store.
            </p>
            <p>
              The link grants access to the selected files. Share it privately.
              Credentials stay in the URL fragment and are removed from the
              recipient’s address bar after opening; extensions and anyone with
              the link may still see them. Stopping a share revokes future
              access, but cannot remove files already downloaded.
            </p>
            <p>
              Browser shares are checked with SHA-256. CLI shares use
              authenticated SFTP and check file size and modification time; they
              do not provide a separate sender checksum. Downloads are saved as
              files, never previewed or executed here. Neither check guarantees
              the sender’s files are safe. ZIP preserves folder paths.
              Directory-picker fallbacks may omit empty folders. Background tabs
              and locked phones may pause or disconnect a transfer.
            </p>
            <p>
              CLI uploads confirm writes and the receiver’s reported file size,
              without a read-back checksum. Cancelled or interrupted uploads can
              leave partial files in the inbox. Check it before retrying.
            </p>
            <p>
              This is experimental software built on{" "}
              <a
                href="https://github.com/tailscale/tailcat"
                target="_blank"
                rel="noreferrer"
              >
                Tailcat
              </a>
              . For failed or interrupted downloads, reconnect with the sender’s
              link or key and start again.
            </p>
          </div>
        </details>
      </main>
      <footer>
        <span>Small link. Big connection.</span>
        <span>
          Powered by{" "}
          <a
            href="https://github.com/tailscale/tailcat"
            target="_blank"
            rel="noreferrer"
          >
            Tailcat <ArrowUpRight size={13} />
          </a>
        </span>
      </footer>
      <input
        ref={filesInput}
        className="hidden-input"
        type="file"
        multiple
        aria-label="Choose files to share"
        onChange={(e) => {
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files);
            e.target.value = "";
            void addSelection(
              Promise.resolve().then(() => createShare(picked)),
            );
          }
        }}
      />
      <input
        ref={directoryInput}
        className="hidden-input"
        type="file"
        multiple
        {...{ webkitdirectory: "", directory: "" }}
        aria-label="Choose folder to share"
        onChange={(e) => {
          if (e.target.files?.length) {
            const picked = Array.from(e.target.files);
            e.target.value = "";
            void addSelection(
              Promise.resolve().then(() => createShare(picked)),
            );
          }
        }}
      />
    </div>
  );
}
