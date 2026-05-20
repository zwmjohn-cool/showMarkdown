import { config } from "../../../package.json";
import {
  ensureNamedMineruMarkdownFile,
  findCachedMineruMarkdownPaths,
  getFileNameFromPath,
  isMineruCachePath,
} from "./cache";

const MARKDOWN_CONTENT_TYPE = "text/markdown";
const MARKDOWN_FILE_EXTENSION_RE = /\.(?:md|markdown)$/i;
const MARKDOWN_RETRY_DELAYS_MS = [
  1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000,
  300_000, 300_000, 300_000,
];
const SELECTED_ITEMS_SYNC_INTERVAL_MS = 5_000;

type SyncOptions = {
  retryMissingMarkdown?: boolean;
  retryAttempt?: number;
};

type SelectListenerApi = {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

type PaneWithSelection = {
  getSelectedItems?: () => Zotero.Item[];
  itemsView?:
    | false
    | {
        onSelect?: SelectListenerApi;
      };
};

type SelectListenerHandle = {
  pane: PaneWithSelection;
  listener?: () => void;
  pollIntervalId: ReturnType<typeof globalThis.setInterval>;
};

let notifierObserverId: string | null = null;
const processingItemIds = new Set<number>();
const markdownRetryTimers = new Map<
  number,
  ReturnType<typeof globalThis.setTimeout>
>();
const selectionListeners = new WeakMap<Window, SelectListenerHandle>();
const selectionWindows = new Set<Window>();

export function registerMineruMarkdownAttachmentSync() {
  if (notifierObserverId) return;
  notifierObserverId = Zotero.Notifier.registerObserver(
    {
      notify: async (event, type, ids) => {
        if (type !== "item") return;
        if (event !== "add" && event !== "modify" && event !== "refresh")
          return;
        await syncItemsByIds(ids);
      },
    },
    ["item"],
    config.addonID,
  );
}

export function unregisterMineruMarkdownAttachmentSync() {
  if (!notifierObserverId) return;
  Zotero.Notifier.unregisterObserver(notifierObserverId);
  notifierObserverId = null;
  processingItemIds.clear();
  clearMarkdownRetryTimers();
}

export function registerSelectionSync(win: _ZoteroTypes.MainWindow) {
  if (selectionListeners.has(win)) return;
  const pane = (win.ZoteroPane || Zotero.getActiveZoteroPane?.()) as
    | PaneWithSelection
    | undefined;
  if (!pane) return;
  const itemsView = pane.itemsView || undefined;
  const listenerApi = itemsView?.onSelect;
  const pollIntervalId = globalThis.setInterval(() => {
    void syncSelectedItems(win);
  }, SELECTED_ITEMS_SYNC_INTERVAL_MS);

  if (listenerApi?.addListener) {
    const listener = () => {
      void syncSelectedItems(win);
    };
    listenerApi.addListener(listener);
    selectionListeners.set(win, { pane, listener, pollIntervalId });
    selectionWindows.add(win);
    return;
  }

  selectionListeners.set(win, { pane, pollIntervalId });
  selectionWindows.add(win);
}

export function unregisterSelectionSync(win: Window) {
  const handle = selectionListeners.get(win);
  if (!handle) return;
  const itemsView = handle.pane.itemsView || undefined;
  if (handle.listener) {
    itemsView?.onSelect?.removeListener?.(handle.listener);
  }
  globalThis.clearInterval(handle.pollIntervalId);
  selectionListeners.delete(win);
  selectionWindows.delete(win);
}

export function unregisterAllSelectionSync() {
  for (const win of Array.from(selectionWindows)) {
    unregisterSelectionSync(win);
  }
}

export async function syncSelectedItems(win?: _ZoteroTypes.MainWindow) {
  const pane = (win?.ZoteroPane || Zotero.getActiveZoteroPane?.()) as
    | PaneWithSelection
    | undefined;
  const selectedItems = pane?.getSelectedItems?.() || [];
  await Promise.all(
    selectedItems.map((item) => syncItem(item, { retryMissingMarkdown: true })),
  );
}

export async function syncAllItems() {
  const items = await Zotero.Items.getAll(
    Zotero.Libraries.userLibraryID,
    true,
    false,
    false,
  );
  await Promise.all(items.map((item) => syncItem(item)));
}

async function syncItemsByIds(ids: string[] | number[]) {
  await Promise.all(
    ids.map(async (id) => {
      const numericId = Number(id);
      if (!Number.isFinite(numericId)) return;
      const item = Zotero.Items.get(numericId);
      if (!item) return;
      await syncItem(item, { retryMissingMarkdown: true });
    }),
  );
}

async function syncItem(item: Zotero.Item, options: SyncOptions = {}) {
  if (isPdfAttachment(item)) {
    await ensureMarkdownAttachmentForPdf(item, options);
    return;
  }

  if (isRegularItem(item)) {
    await syncRegularItemMarkdownAttachments(item, options);
  }
}

export async function syncRegularItemMarkdownAttachments(
  parentItem: Zotero.Item,
  options: SyncOptions = {},
) {
  if (!isRegularItem(parentItem)) return;
  const attachmentIds = parentItem.getAttachments?.() || [];
  await Promise.all(
    attachmentIds.map(async (attachmentId) => {
      const attachment = Zotero.Items.get(attachmentId);
      if (!attachment) return;
      if (isPdfAttachment(attachment)) {
        await ensureMarkdownAttachmentForPdf(attachment, options);
      }
    }),
  );
}

export async function ensureMarkdownAttachmentForPdf(
  pdfAttachment: Zotero.Item,
  options: SyncOptions = {},
) {
  if (!isPdfAttachment(pdfAttachment)) return;
  if (processingItemIds.has(pdfAttachment.id)) {
    scheduleMarkdownRetry(pdfAttachment.id, options);
    return;
  }

  processingItemIds.add(pdfAttachment.id);
  try {
    const parentId = Number(pdfAttachment.parentID || 0);
    if (!parentId) return;

    const parentItem = Zotero.Items.get(parentId);
    if (!isRegularItem(parentItem)) return;

    const itemTitle = String(parentItem.getField?.("title") || "Untitled");
    await ensureNamedMineruMarkdownFile(pdfAttachment.id, itemTitle);
    const markdownPaths = await findCachedMineruMarkdownPaths(pdfAttachment.id);
    if (!markdownPaths.length) {
      scheduleMarkdownRetry(pdfAttachment.id, options);
      return;
    }

    const existingAttachments =
      await findExistingMarkdownAttachments(parentItem);

    await Promise.all(
      markdownPaths.map(async (markdownPath) => {
        const title = getFileNameFromPath(markdownPath);
        const existing = existingAttachments.get(normalizePath(markdownPath));
        if (existing) {
          await normalizeMarkdownAttachment(existing, title);
          return;
        }

        const linkedAttachment = await Zotero.Attachments.linkFromFile({
          file: markdownPath,
          parentItemID: parentItem.id,
          title,
          contentType: MARKDOWN_CONTENT_TYPE,
          charset: "utf-8",
        });
        await normalizeMarkdownAttachment(linkedAttachment, title);
      }),
    );
    clearMarkdownRetryTimer(pdfAttachment.id);
  } catch (err) {
    ztoolkit.log("Show Markdown: failed to create Markdown attachment", err);
    scheduleMarkdownRetry(pdfAttachment.id, options);
  } finally {
    processingItemIds.delete(pdfAttachment.id);
  }
}

function scheduleMarkdownRetry(pdfAttachmentId: number, options: SyncOptions) {
  if (!options.retryMissingMarkdown) return;
  if (markdownRetryTimers.has(pdfAttachmentId)) return;

  const attempt = options.retryAttempt || 0;
  const delay = MARKDOWN_RETRY_DELAYS_MS[attempt];
  if (typeof delay !== "number") return;

  const timeoutId = globalThis.setTimeout(() => {
    markdownRetryTimers.delete(pdfAttachmentId);
    void retryMarkdownAttachmentSync(pdfAttachmentId, attempt + 1);
  }, delay);
  markdownRetryTimers.set(pdfAttachmentId, timeoutId);
}

async function retryMarkdownAttachmentSync(
  pdfAttachmentId: number,
  retryAttempt: number,
) {
  const item = Zotero.Items.get(pdfAttachmentId);
  if (!item) return;

  await ensureMarkdownAttachmentForPdf(item, {
    retryMissingMarkdown: true,
    retryAttempt,
  });
}

function clearMarkdownRetryTimer(pdfAttachmentId: number) {
  const timeoutId = markdownRetryTimers.get(pdfAttachmentId);
  if (!timeoutId) return;
  globalThis.clearTimeout(timeoutId);
  markdownRetryTimers.delete(pdfAttachmentId);
}

function clearMarkdownRetryTimers() {
  for (const timeoutId of markdownRetryTimers.values()) {
    globalThis.clearTimeout(timeoutId);
  }
  markdownRetryTimers.clear();
}

async function findExistingMarkdownAttachments(
  parentItem: Zotero.Item,
): Promise<Map<string, Zotero.Item>> {
  const attachments = new Map<string, Zotero.Item>();
  const attachmentIds = parentItem.getAttachments?.() || [];

  for (const attachmentId of attachmentIds) {
    const attachment = Zotero.Items.get(attachmentId) as
      | (Zotero.Item & {
          getField?: (field: string) => unknown;
          setDeleted?: (deleted?: boolean) => void;
          saveTx?: () => Promise<unknown>;
        })
      | null;
    if (!attachment?.isAttachment?.()) continue;
    if (isPdfAttachment(attachment as Zotero.Item)) continue;

    const attachmentPath = await getAttachmentPath(attachment as Zotero.Item);
    if (!attachmentPath || !isMineruCachePath(attachmentPath)) continue;
    if (!isMarkdownAttachment(attachment as Zotero.Item, attachmentPath)) {
      continue;
    }

    attachments.set(normalizePath(attachmentPath), attachment as Zotero.Item);
  }

  return attachments;
}

async function normalizeMarkdownAttachment(
  attachment: Zotero.Item,
  title: string,
) {
  const currentTitle = String(attachment.getField?.("title") || "");
  const mutable = attachment as Zotero.Item & {
    attachmentContentType?: string;
  };

  let changed = false;
  if (currentTitle !== title) {
    attachment.setField?.("title", title);
    changed = true;
  }
  if (mutable.attachmentContentType !== MARKDOWN_CONTENT_TYPE) {
    mutable.attachmentContentType = MARKDOWN_CONTENT_TYPE;
    changed = true;
  }
  if (changed) await attachment.saveTx();
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

  return withPath.attachmentPath || null;
}

function isMarkdownAttachment(item: Zotero.Item, filePath?: string): boolean {
  const attachment = item as Zotero.Item & {
    attachmentContentType?: string;
    attachmentFilename?: string;
  };
  const contentType = attachment.attachmentContentType?.toLowerCase();
  if (
    contentType === MARKDOWN_CONTENT_TYPE ||
    contentType === "text/x-markdown"
  )
    return true;

  const fileName = attachment.attachmentFilename || filePath || "";
  return MARKDOWN_FILE_EXTENSION_RE.test(fileName);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isRegularItem(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  return Boolean(item?.isRegularItem?.());
}

function isPdfAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  if (!item?.isAttachment?.()) return false;
  const attachment = item as Zotero.Item & {
    isPDFAttachment?: () => boolean;
    attachmentContentType?: string;
    attachmentFilename?: string;
  };
  if (attachment.isPDFAttachment?.()) return true;
  if (attachment.attachmentContentType === "application/pdf") return true;
  return Boolean(attachment.attachmentFilename?.toLowerCase().endsWith(".pdf"));
}
