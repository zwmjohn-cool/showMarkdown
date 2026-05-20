type PaneWithSelection = {
  getSelectedItems?: () => Zotero.Item[];
};

type QuickLookHandle = {
  listeners: Array<{
    target: EventTarget;
    listener: (event: KeyboardEvent) => void;
  }>;
};

type FileConstructor = {
  new (path?: string): nsIFile;
};

const QUICK_LOOK_EXECUTABLE = "/usr/bin/qlmanage";
const QUICK_LOOK_KILL_EXECUTABLE = "/usr/bin/pkill";
const MARKDOWN_FILE_EXTENSION_RE = /\.(?:md|markdown)$/i;
const quickLookListeners = new WeakMap<Window, QuickLookHandle>();
const quickLookWindows = new Set<Window>();
const handledSpaceEvents = new WeakSet<KeyboardEvent>();
let quickLookProcess: nsIProcess | null = null;
let quickLookFilePath: string | null = null;
let openingFilePath: string | null = null;

export function registerPdfQuickLook(win: _ZoteroTypes.MainWindow) {
  if (!Zotero.isMac) return;
  if (quickLookListeners.has(win)) return;

  const keydownListener = (event: KeyboardEvent) => {
    if (handledSpaceEvents.has(event)) return;
    if (!shouldHandleSpace(event, win)) return;

    handledSpaceEvents.add(event);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void toggleQuickLookForSelection(win);
  };

  const listeners = [
    addKeydownListener(win, keydownListener),
    addKeydownListener(win.document, keydownListener),
  ].filter(Boolean) as QuickLookHandle["listeners"];

  quickLookListeners.set(win, { listeners });
  quickLookWindows.add(win);
}

export function unregisterPdfQuickLook(win: Window) {
  const handle = quickLookListeners.get(win);
  if (!handle) return;

  for (const { target, listener } of handle.listeners) {
    target.removeEventListener("keydown", listener as EventListener, true);
  }
  quickLookListeners.delete(win);
  quickLookWindows.delete(win);

  if (!quickLookWindows.size) {
    closeQuickLook();
  }
}

export function unregisterAllPdfQuickLook() {
  for (const win of Array.from(quickLookWindows)) {
    unregisterPdfQuickLook(win);
  }
  closeQuickLook();
}

function shouldHandleSpace(
  event: KeyboardEvent,
  win: _ZoteroTypes.MainWindow,
): boolean {
  if (!isSpaceKey(event)) return false;
  if (event.repeat) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return false;
  if (shouldIgnoreTarget(event.target)) return false;
  if (shouldIgnoreTarget(win.document.activeElement)) return false;

  return true;
}

async function toggleQuickLookForSelection(win: _ZoteroTypes.MainWindow) {
  const attachment = await resolveSelectedQuickLookAttachment(win);
  if (!attachment) {
    if (quickLookFilePath) closeQuickLook();
    return;
  }

  const filePath = await getAttachmentPath(attachment);
  if (!filePath) return;

  if (isQuickLookOpenFor(filePath)) {
    closeQuickLook();
    return;
  }

  closeQuickLook();
  openQuickLook(filePath);
}

async function resolveSelectedQuickLookAttachment(
  win: _ZoteroTypes.MainWindow,
): Promise<Zotero.Item | null> {
  const selectedItems = getSelectedItems(win);
  if (selectedItems.length !== 1) return null;

  const item = selectedItems[0];
  if (isPreviewableAttachment(item)) return item;
  if (!isRegularItem(item)) return null;

  const bestAttachment = await item.getBestAttachment?.();
  if (bestAttachment && isPreviewableAttachment(bestAttachment)) {
    return bestAttachment;
  }

  const bestAttachments = await item.getBestAttachments?.();
  const bestPreviewableAttachment = bestAttachments?.find(
    (attachment: Zotero.Item) => isPreviewableAttachment(attachment),
  );
  if (bestPreviewableAttachment) return bestPreviewableAttachment;

  const attachmentIds = item.getAttachments?.() || [];
  let fallbackMarkdownAttachment: Zotero.Item | null = null;
  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId);
    if (isPdfAttachment(attachment)) return attachment;
    if (!fallbackMarkdownAttachment && isMarkdownAttachment(attachment)) {
      fallbackMarkdownAttachment = attachment;
    }
  }

  return fallbackMarkdownAttachment;
}

function getSelectedItems(win: _ZoteroTypes.MainWindow): Zotero.Item[] {
  const pane = (win.ZoteroPane || Zotero.getActiveZoteroPane?.()) as
    | PaneWithSelection
    | undefined;
  return pane?.getSelectedItems?.() || [];
}

function isRegularItem(item: Zotero.Item | null | undefined): boolean {
  return Boolean(item?.isRegularItem?.());
}

function isPdfAttachment(
  item: Zotero.Item | false | null | undefined,
): boolean {
  if (!item || !item.isAttachment?.()) return false;
  const attachment = item as Zotero.Item & {
    isPDFAttachment?: () => boolean;
    attachmentContentType?: string;
    attachmentFilename?: string;
  };
  if (attachment.isPDFAttachment?.()) return true;
  if (attachment.attachmentContentType === "application/pdf") return true;
  return Boolean(attachment.attachmentFilename?.toLowerCase().endsWith(".pdf"));
}

function isPreviewableAttachment(
  item: Zotero.Item | false | null | undefined,
): boolean {
  return isPdfAttachment(item) || isMarkdownAttachment(item);
}

function isMarkdownAttachment(
  item: Zotero.Item | false | null | undefined,
): item is Zotero.Item {
  if (!item || !item.isAttachment?.()) return false;
  const attachment = item as Zotero.Item & {
    attachmentContentType?: string;
    attachmentFilename?: string;
    getField?: (field: string) => unknown;
  };
  const contentType = attachment.attachmentContentType?.toLowerCase();
  if (contentType === "text/markdown" || contentType === "text/x-markdown") {
    return true;
  }

  const fileName =
    attachment.attachmentFilename ||
    String(attachment.getField?.("title") || "");
  return MARKDOWN_FILE_EXTENSION_RE.test(fileName);
}

async function getAttachmentPath(
  attachment: Zotero.Item,
): Promise<string | null> {
  const withPath = attachment as Zotero.Item & {
    getFilePathAsync?: () => Promise<string | false | null | undefined>;
    getFilePath?: () => string | false | null | undefined;
    attachmentPath?: string;
  };

  const asyncPath = await withPath.getFilePathAsync?.();
  if (typeof asyncPath === "string" && asyncPath) return asyncPath;

  const syncPath = withPath.getFilePath?.();
  if (typeof syncPath === "string" && syncPath) return syncPath;

  const fallbackPath = withPath.attachmentPath || null;
  if (fallbackPath?.startsWith("storage:")) return null;
  return fallbackPath;
}

function openQuickLook(filePath: string) {
  if (openingFilePath === filePath) return;
  openingFilePath = filePath;

  try {
    const localFile = createLocalFile(filePath);
    if (!localFile.exists() || !localFile.isFile()) return;

    const process = createProcess(QUICK_LOOK_EXECUTABLE);
    runProcessAsync(process, ["-p", localFile.path], () => {
      if (quickLookProcess === process) {
        quickLookProcess = null;
        quickLookFilePath = null;
      }
    });
    quickLookProcess = process;
    quickLookFilePath = filePath;
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to open macOS Quick Look", err);
  } finally {
    openingFilePath = null;
  }
}

function closeQuickLook() {
  try {
    if (quickLookProcess?.isRunning) {
      quickLookProcess.kill();
    } else if (quickLookFilePath) {
      killDetachedQuickLook();
    }
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to close macOS Quick Look", err);
  } finally {
    quickLookProcess = null;
    quickLookFilePath = null;
  }
}

function isQuickLookOpenFor(filePath: string): boolean {
  return quickLookFilePath === filePath;
}

function createProcess(executablePath: string): nsIProcess {
  const file = createLocalFile(executablePath);
  const classes = Components.classes as Record<
    string,
    { createInstance: (interfaceType: nsJSIID<nsIProcess>) => nsIProcess }
  >;
  const process = classes["@mozilla.org/process/util;1"].createInstance(
    Components.interfaces.nsIProcess,
  );
  process.init(file);
  return process;
}

function createLocalFile(path: string): nsIFile {
  const File = Components.Constructor(
    "@mozilla.org/file/local;1",
    "nsIFile",
    "initWithPath",
  ) as FileConstructor;
  return new File(path);
}

function addKeydownListener(
  target: EventTarget | null | undefined,
  listener: (event: KeyboardEvent) => void,
) {
  if (!target?.addEventListener) return null;
  target.addEventListener("keydown", listener as EventListener, true);
  return { target, listener };
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return (
    event.key === " " ||
    event.key === "Space" ||
    event.key === "Spacebar" ||
    event.code === "Space"
  );
}

function shouldIgnoreTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element) return false;

  const tagName = element.tagName?.toLowerCase();
  if (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    tagName === "textbox" ||
    tagName === "search-textbox"
  ) {
    return true;
  }

  if ((element as HTMLElement).isContentEditable) return true;

  const role = element.getAttribute?.("role");
  if (role === "textbox" || role === "searchbox") return true;
  if (role === "button" || role === "checkbox" || role === "radio") return true;

  return false;
}

function runProcessAsync(
  process: nsIProcess,
  args: string[],
  onExit: () => void,
) {
  const observer = {
    observe: onExit,
  };

  if (process.runwAsync) {
    process.runwAsync(args, args.length, observer);
    return;
  }

  process.runAsync(args, args.length, observer);
}

function killDetachedQuickLook() {
  const process = createProcess(QUICK_LOOK_KILL_EXECUTABLE);
  runProcessAsync(process, ["-x", "qlmanage"], () => {});
}
