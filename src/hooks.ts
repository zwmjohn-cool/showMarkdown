import {
  registerMineruMarkdownAttachmentSync,
  registerSelectionSync,
  syncAllItems,
  syncSelectedItems,
  unregisterAllSelectionSync,
  unregisterMineruMarkdownAttachmentSync,
  unregisterSelectionSync,
} from "./modules/mineruMarkdownPanel";
import {
  registerPdfQuickLook,
  unregisterAllPdfQuickLook,
  unregisterPdfQuickLook,
} from "./modules/pdfQuickLook";
import {
  registerMineruReaderTools,
  unregisterMineruReaderTools,
} from "./modules/mineruReaderTools";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  registerMineruMarkdownAttachmentSync();
  registerMineruReaderTools();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  void syncAllItems();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  registerSelectionSync(win);
  registerPdfQuickLook(win);
  await syncSelectedItems(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterSelectionSync(win);
  unregisterPdfQuickLook(win);
}

function onShutdown(): void {
  unregisterAllSelectionSync();
  unregisterAllPdfQuickLook();
  unregisterMineruReaderTools();
  unregisterMineruMarkdownAttachmentSync();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
