import {
  registerMineruMarkdownAttachmentSync,
  registerSelectionSync,
  syncSelectedItems,
  unregisterMineruMarkdownAttachmentSync,
  unregisterSelectionSync,
} from "./modules/mineruMarkdownPanel";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  registerMineruMarkdownAttachmentSync();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  registerSelectionSync(win);
  await syncSelectedItems(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterSelectionSync(win);
}

function onShutdown(): void {
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
