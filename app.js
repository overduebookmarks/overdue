let allBookmarks = [];
let flatFolders = [];
let flatAllBookmarks = []; 
let activePane = "left";
let ctxClipboard = null;

function updatePasteButton() {
  const btn = document.getElementById("tb-paste");
  if (!btn) return;
  const has = !!(ctxClipboard?.items?.length);
  btn.disabled = !has;
}

async function _refreshOtherPane(currentSide, deletedIds) {
  const otherSide = currentSide === "left" ? "right" : "left";
  const otherPane = panes[otherSide];

  if (otherPane.isSearchMode) {
    
    const searchInput = document.getElementById(`search-${otherSide}`);
    if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  
  function isDeletedOrChild(folderId) {
    if (!folderId) return false;
    if (deletedIds.includes(String(folderId))) return true;
    
    let cur = flatFolders.find(f => String(f.id) === String(folderId));
    while (cur && cur.parentId) {
      if (deletedIds.includes(String(cur.parentId))) return true;
      cur = flatFolders.find(f => String(f.id) === String(cur.parentId));
    }
    return false;
  }

  if (isDeletedOrChild(otherPane.currentFolderId)) {
    
    setAllBookmarks(otherSide);
  } else if (otherPane.currentFolderId) {
    
    const f = flatFolders.find(x => String(x.id) === String(otherPane.currentFolderId));
    if (f) await browseFolder({ id: f.id, title: f.title }, otherSide);
    else renderVirtual(otherSide);
  } else {
    
    renderVirtual(otherSide);
  }
}

async function executeDelete(side, context, snapItems) {
  const pane = panes[side];
  const panel = context || state.activePanel;

  
  const isRootById = (id) => {
    const ff = flatFolders.find(f => String(f.id) === String(id));
    return ff && ff.depth === 0;
  };
  if (panel === "tree") {
    const idx = Array.from(pane.selection.tree)[0];
    const item = (snapItems && snapItems[0]) || (idx != null ? flatFolders[idx] : null);
    if (item && isRootById(item.id)) return;
  } else {
    
    let checkItems = snapItems;
    if (!checkItems) {
      const ids = [...pane.selection.results];
      if (!ids.length && pane.currentRowIndex >= 0) {
        const cur = pane.currentResults[pane.currentRowIndex];
        if (cur) ids.push(String(cur.id));
      }
      checkItems = ids.map(id => pane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
    }
    if (checkItems.some(item => item.isFolder && isRootById(item.id))) return;
  }

  
  
  
  if (panel === "tree") {
    
    const folder = (snapItems && snapItems[0]) || (() => {
      const idx = Array.from(pane.selection.tree)[0];
      return idx != null ? { ...flatFolders[idx], isFolder: true } : null;
    })();
    if (!folder) return;

    
    const flatFolder = flatFolders.find(f => String(f.id) === String(folder.id));
    if (!flatFolder) return;

    let hasChild = false;
    try {
      const ch = await browser.bookmarks.getChildren(String(flatFolder.id));
      hasChild = ch.length > 0;
    } catch (_) {}
    const msg = hasChild
      ? `Delete "${truncate(flatFolder.title || "Unnamed")}" and all its contents?`
      : `Delete "${truncate(flatFolder.title || "Unnamed")}"?`;
    if (!await showConfirm(msg)) return;

    const deletedId = String(flatFolder.id);
    const parentId = flatFolder.parentId ? String(flatFolder.parentId) : null;

    undoPush({ type: "delete", items: [{ item: { ...flatFolder, isFolder: true }, parentId }] });

    isMoving = true;
    try { await browser.bookmarks.removeTree(deletedId); } catch (_) {}
    await loadBookmarks();
    isMoving = false;

    pane.selection.tree.clear();
    pane.tree.focused = null;
    pane.tree.selected = null;

    if (parentId) {
      const newIdx = flatFolders.findIndex(f => String(f.id) === parentId);
      if (newIdx !== -1) {
        pane.selection.tree.add(newIdx);
        pane.tree.focused = newIdx;
        pane.tree.selected = newIdx;
        expandAndSelectInTree(parentId, side);
        await browseFolder({ id: flatFolders[newIdx].id, title: flatFolders[newIdx].title }, side);
      }
    } else {
      setAllBookmarks(side);
    }

    
    await _refreshOtherPane(side, [deletedId]);
    return;
  }
  
  let delItems;
  if (snapItems && snapItems.length) {
    delItems = snapItems;
  } else {
    const delIds = [...pane.selection.results];
    if (!delIds.length && pane.currentRowIndex >= 0) {
      const cur = pane.currentResults[pane.currentRowIndex];
      if (cur) delIds.push(String(cur.id));
    }
    if (!delIds.length) return;
    delItems = delIds.map(id => pane.currentResults.find(x => String(x.id) === id)).filter(Boolean);
  }
  if (!delItems.length) return;

  const folders = delItems.filter(x => x.isFolder);
  const listNames = (items, max = 9) => {
    const shown = items.slice(0, max).map(i => `"${truncate(i.title || i.url || "Unnamed")}"`).join("\n");
    return items.length > max ? shown + `\n… and ${items.length - max} more` : shown;
  };

  let confirmMsg;
  if (folders.length > 0) {
    const hasChildren = await Promise.all(
      folders.map(async f => {
        const ch = await browser.bookmarks.getChildren(String(f.id));
        return ch.length > 0;
      })
    );
    const nonEmpty = folders.filter((_, i) => hasChildren[i]);
    if (nonEmpty.length > 0) {
      confirmMsg = `Delete and all contents?\n${listNames(nonEmpty)}`;
    } else {
      confirmMsg = delItems.length === 1
        ? `Delete "${truncate(delItems[0].title || "Folder")}"?`
        : `Delete these ${delItems.length} items?\n${listNames(delItems)}`;
    }
  } else {
    confirmMsg = delItems.length === 1
      ? `Delete "${truncate(delItems[0].title || delItems[0].url || "this bookmark")}"?`
      : `Delete these ${delItems.length} bookmarks?\n${listNames(delItems)}`;
  }
  if (!await showConfirm(confirmMsg)) return;

  const hasFolder = folders.length > 0;
  const _stayId = hasFolder
    ? String(folders[0].parentId || pane.currentFolderId || "")
    : String(pane.currentFolderId || "");

  
  const undoItems = delItems.map(item => ({
    item: { ...item },
    parentId: item.parentId || pane.currentFolderId || null
  }));

  isMoving = true;
  for (const item of delItems) {
    try {
      if (item.isFolder) await browser.bookmarks.removeTree(String(item.id));
      else await browser.bookmarks.remove(String(item.id));
    } catch (_) {}
  }
  await loadBookmarks();
  isMoving = false;

  undoPush({ type: "delete", items: undoItems });

  pane.selection.results.clear();
  pane.currentRowIndex = -1;

  if (pane.isSearchMode) {
    
    const searchInput = document.getElementById(`search-${side}`);
    if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (_stayId) {
    const target = flatFolders.find(f => String(f.id) === _stayId);
    if (target) await browseFolder({ id: target.id, title: target.title }, side);
  }

  
  const deletedIds = delItems.map(x => String(x.id));
  await _refreshOtherPane(side, deletedIds);
}

function truncate(str, max = 60) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function showConfirm(msg, yesLabel = "Delete") {
  return new Promise(resolve => {
    const overlay = document.getElementById("confirm-overlay");
    const msgEl   = document.getElementById("confirm-msg");
    const yesBtn  = document.getElementById("confirm-yes");
    const noBtn   = document.getElementById("confirm-no");
    if (!overlay) { resolve(window.confirm(msg)); return; }
    msgEl.textContent = msg;
    yesBtn.textContent = yesLabel;
    noBtn.textContent  = "Cancel";

    const done = (val) => {
      overlay.style.display = "none";
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onYes = (e) => { e.stopPropagation(); done(true); };
    const onNo  = (e) => { e.stopPropagation(); done(false); };
    const onKey = (e) => {
      
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.key === "Enter" || e.key === " ") {
        if (document.activeElement === noBtn) done(false);
        else done(true);
      } else if (e.key === "Escape") {
        done(false);
      } else if (e.key === "Tab") {
        if (document.activeElement === yesBtn) noBtn.focus();
        else yesBtn.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (document.activeElement === yesBtn) noBtn.focus();
        else yesBtn.focus();
      }
      
    };
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey, true); 

    setTimeout(() => {
      overlay.style.display = "flex";
      yesBtn.focus();
    }, 0);
  });
}

function showToast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, ms);
}

let undoHistory = [];
let redoHistory = [];

function undoPush(record) {
  undoHistory.push(record);
  
  redoHistory = [];
  
  if (undoHistory.length > 50) undoHistory.shift();
  
  _browseFolderCache.clear();
  _sortCache.clear();
  updateUndoButton();
  updateRedoButton();
}

function updateUndoButton() {
  const disabled = undoHistory.length === 0;
  const btn = document.getElementById("tb-undo") || document.querySelector(".tb-undo");
  if (btn) { btn.disabled = disabled; btn.style.opacity = disabled ? "0.4" : ""; }
}

function updateRedoButton() {
  const disabled = redoHistory.length === 0;
  const btn = document.getElementById("tb-redo") || document.querySelector(".tb-redo");
  if (btn) { btn.disabled = disabled; btn.style.opacity = disabled ? "0.4" : ""; }
}

function updateNavButtons(side = activePane) {
  const pane = panes[side];
  const backBtn    = document.getElementById("tb-back");
  const forwardBtn = document.getElementById("tb-forward");
  const parentBtn  = document.getElementById("tb-parent");
  const parentLabel = document.getElementById("tb-parent-label");
  if (backBtn)    backBtn.disabled    = pane.historyIndex <= 0;
  if (forwardBtn) forwardBtn.disabled = pane.historyIndex >= pane.history.length - 1;

  let hasParent = false;
  let parentName = "";
  if (!pane.isSearchMode && pane.currentFolderId !== null) {
    const folder = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
    if (folder) {
      if (folder.parentId) {
        const parentFolder = flatFolders.find(f => String(f.id) === String(folder.parentId));
        parentName = parentFolder ? (parentFolder.title || "All Bookmarks") : "All Bookmarks";
        hasParent = true;
      } else {
        
        parentName = "All Bookmarks";
        hasParent = true;
      }
    }
  }

  if (parentBtn) {
	parentBtn.disabled = !hasParent;
	parentBtn.style.opacity = "";
}	
  if (parentBtn) {
    const tooltipSpan = parentBtn.querySelector(".tb-tooltip");
    if (tooltipSpan) tooltipSpan.textContent = hasParent ? `Up to "${parentName}" (Alt+↑)` : "Up to Parent (Alt+↑)";
  }
  if (parentLabel) parentLabel.textContent = hasParent ? parentName : "";
}

async function executeUndo() {
  if (!undoHistory.length) return;
  const record = undoHistory.pop();
  updateUndoButton();
  
  if (record.type === "rename") {
    redoHistory.push({ type: "rename", id: record.id, oldTitle: record.oldTitle, newTitle: record.newTitle });
  } else {
    redoHistory.push(record);
  }
  updateRedoButton();

  if (record.type === "rename") {
    try {
      isRenaming = true;
      await browser.bookmarks.update(String(record.id), { title: record.oldTitle });
    } catch (_) {
      showToast("Undo failed"); isRenaming = false; return;
    }
    for (const s of ["left", "right"]) {
      _applyRenameToPane(s, String(record.id), record.oldTitle);
    }
    
    const fab = flatAllBookmarks.find(x => String(x.id) === String(record.id));
    if (fab) { fab.title = record.oldTitle; fab.full = (record.oldTitle + " " + (fab.url || "") + " " + (fab.fullPath || "")).toLowerCase(); }
    
    const ff = flatFolders.find(x => String(x.id) === String(record.id));
    if (ff) { ff.title = record.oldTitle; renderTree("left"); renderTree("right"); }
    
    
    _browseFolderCache.clear();
    _sortCache.clear();
    for (const s of ["left", "right"]) {
      renderVirtualInPlace(s);
    }
    isRenaming = false;
    showToast(`"${record.newTitle}" → "${record.oldTitle}"`);
    updateStatus();
  } else if (record.type === "delete") {
    
    const restoredItems = [];
    isMoving = true;
    for (const { item, parentId } of record.items) {
      let targetParentId = parentId;
      try { await browser.bookmarks.get(String(targetParentId)); } catch (_) { targetParentId = "unfiled_____"; }
      try {
        let created;
        if (item.isFolder) {
          created = await browser.bookmarks.create({ parentId: String(targetParentId), title: item.title || "Unnamed" });
        } else {
          created = await browser.bookmarks.create({ parentId: String(targetParentId), title: item.title || "", url: item.url });
        }
        if (created) {
          restoredItems.push({ item: { ...item, id: String(created.id) }, parentId: String(targetParentId) });
        }
      } catch (_) {}
    }
    isMoving = false;
    
    const redoRecord = redoHistory[redoHistory.length - 1];
    if (redoRecord && redoRecord.type === "delete" && restoredItems.length) {
      redoRecord.items = restoredItems;
    }
    showToast(`${record.items.length} item(s) restored`);
    await loadBookmarks();
    for (const s of ["left", "right"]) {
      const p = panes[s];
      if (p.currentFolderId) {
        const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
        if (f) await browseFolder({ id: f.id, title: f.title }, s);
      } else {
        renderVirtual(s);
      }
    }
  } else if (record.type === "move") {
    
    isMoving = true;
    try {
      for (const id of record.movedIds) {
        try { await browser.bookmarks.move(String(id), { parentId: String(record.fromFolderId) }); } catch (_) {}
      }
    } finally { isMoving = false; }
    if (record.clipboardSnapshot) {
      ctxClipboard = { items: record.clipboardSnapshot, op: "cut" };
      updatePasteButton();
    }
    showToast(`${record.movedIds.length} item(s) moved back`);
    await loadBookmarks();
    
    for (const s of ["left", "right"]) {
      const p = panes[s];
      if (p.currentFolderId) {
        const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
        if (f) await browseFolder({ id: f.id, title: f.title }, s);
      }
    }
  }
}

let folderSelectToken = 0;

let isKeyboardNavigating = false;
let isKeyboardScrolling = false;
let isRestoring = false;
let browseToken = 0;
let isBrowsing = false;

let isMoving = false; 
let isRenaming = false; 
const ROW_HEIGHT = 28;
const BUFFER = 15;

const selectionCache = new Map();
const anchorCache = new Map();
const scrollCache = new Map();

const cursorCache = new Map();

const state = {
  activePanel: "results",
};

const panes = {

  left: {

    isSearchMode: false,
  baseResults: [],
    tree: {
      expanded: new Set(),
      selected: null,
      focused: null,
      filter: "",
      searchQuery: "",
      visibleMap: new Map(),
      openMap: new Map(),
      allBookmarksOpen: false
    },

    currentFolderId: null,
    currentResults: [],
    currentRowIndex: 0,

    selection: {
      tree: new Set(),
      results: new Set()
    },

    anchor: {
      tree: null,
      results: null
    },
    sort: { col: "title", asc: true },
    history: [],
    historyIndex: -1
  },

  right: {

    isSearchMode: false,
  baseResults: [],
    tree: {
      expanded: new Set(),
      selected: null,
      focused: null,
      filter: "",
      searchQuery: "",
      visibleMap: new Map(),
      openMap: new Map(),
      allBookmarksOpen: false
    },

    currentFolderId: null,
    currentResults: [],
    currentRowIndex: 0,

    selection: {
      tree: new Set(),
      results: new Set()
    },

    anchor: {
      tree: null,
      results: null
    },
    sort: { col: "title", asc: true },
    history: [],
    historyIndex: -1
  }
};

async function moveItems(ids, folderId, sourceSide, targetSide) {
  const sourcePane = panes[sourceSide];

  
  const moved = ids.map(id => {
    return sourcePane.currentResults.find(x => String(x.id) === String(id))
      || flatAllBookmarks.find(x => String(x.id) === String(id))
      || { id };
  }).filter(Boolean);
  if (!moved.length) return;

  
  const allAlreadyThere = moved.every(x => x.parentId && String(x.parentId) === String(folderId));
  if (allAlreadyThere) return;

  const fromFolderId = sourcePane.currentFolderId;

  isMoving = true;
  try {
    for (const item of moved) {
      await browser.bookmarks.move(String(item.id), { parentId: String(folderId) });
    }
  } catch (err) {
    console.error(err);
    isMoving = false;
    return;
  }
  
  undoPush({ type: "move", movedIds: moved.map(x => String(x.id)), fromFolderId, toFolderId: folderId, sourceSide, targetSide });
  
  _browseFolderCache.delete(String(fromFolderId));
  _browseFolderCache.delete(String(folderId));
  _sortCache.clear();
  
  sourcePane.currentResults = sourcePane.currentResults.filter(x => !moved.find(m => String(m.id) === String(x.id)));
  sourcePane.baseResults = sourcePane.baseResults.filter(x => !moved.find(m => String(m.id) === String(x.id)));
  sourcePane.selection.results.clear();
  sourcePane.anchor.results = null;
  sourcePane.currentRowIndex = -1;

  isMoving = false;
  
  await loadBookmarks();

  _browseFolderCache.clear();
  _sortCache.clear();

  _historyNavigating = true; 
  for (const side of ["left", "right"]) {
    const p = panes[side];
    if (!p.currentFolderId) continue;
    const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
    if (f) await browseFolder({ id: f.id, title: f.title }, side);
  }
  _historyNavigating = false;

  renderVirtual("left");
  renderVirtual("right");
  updateSelectionUI("left");
  updateSelectionUI("right");
  updateStatus();
}

function collectFolderBookmarks(nodes, out = [], parentFullPath = "") {
  for (const node of nodes) {
    const currentPath = parentFullPath ? parentFullPath + "\\" + node.title : node.title;

    if (node.url) {
      out.push({
        ...node,
        path: undefined,
        fullPath: parentFullPath || "",
        full: normalizeText((node.title || "") + " " + (node.url || "") + " " + (parentFullPath || ""))
      });
    }

    if (node.children?.length) {
      collectFolderBookmarks(node.children, out, currentPath);
    }
  }
  return out;
}

function collectFolderBookmarksFrom(nodes, rootFolderId, out = [], parentRelPath = "", rootPrefix = "") {
  for (const node of nodes) {
    if (node.children !== undefined) {
      const relPath = parentRelPath
        ? parentRelPath + "\\" + node.title
        : node.title;
      collectFolderBookmarksFrom(node.children, rootFolderId, out, relPath, rootPrefix);
    } else if (node.url) {
      
      const relPath = parentRelPath === "" ? "." : parentRelPath;
      const displayPath = rootPrefix
        ? (parentRelPath === "" ? rootPrefix : rootPrefix + "\\" + parentRelPath)
        : relPath;
      out.push({
        ...node,
        path: undefined,
        fullPath: displayPath,
        full: normalizeText((node.title || "") + " " + (node.url || "") + " " + displayPath)
      });
    }
  }
  return out;
}

let _historyNavigating = false;

function _historyPush(pane, folderId) {
  pane.history.splice(pane.historyIndex + 1);
  pane.history.push(folderId);
  if (pane.history.length > 100) pane.history.shift();
  pane.historyIndex = pane.history.length - 1;
}

const _browseFolderCache = new Map();
const _sortCache = new Map();

async function browseFolder(node, side = activePane) {
  const pane = getPane(side);
  const cacheKey = String(node.id);
  let folder;
  if (_browseFolderCache.has(cacheKey)) {
    folder = _browseFolderCache.get(cacheKey);
  } else {
    const result = await browser.bookmarks.getSubTree(node.id);
    folder = result?.[0];
    if (!folder) return;
    _browseFolderCache.set(cacheKey, folder);
    
    setTimeout(() => _browseFolderCache.delete(cacheKey), 5000);
  }

  if (!_historyNavigating) _historyPush(pane, folder.id);
  pane.currentFolderId = folder.id;
  const parentPath = node.fullPath || node.title;

  pane.baseResults = (folder.children || []).map(child => ({
    ...child,
    isFolder: !!child.children,
    path: undefined,
    fullPath: parentPath,
    full: normalizeText((child.title || "") + " " + (child.url || ""))
  }));

  pane.currentResults = pane.baseResults.slice();

  pane.selection.results.clear();
  pane.anchor.results = null;
  pane.currentRowIndex = -1;

  if (!pane.tree.filter) {
    expandAndSelectInTree(folder.id, side);
  }
  
  const searchInput = document.getElementById(`search-${side}`);
  if (searchInput && searchInput.value.trim()) {
    sortResults(side);
    renderVirtual(side);
    updateSelectionUI(side);
    updateNavButtons(side);
    updateStatus();
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  sortResults(side);
  renderVirtual(side);
  updateSelectionUI(side);
  updateNavButtons(side);
  updateStatus();
}

function expandAndSelectInTree(folderId, side = activePane) {
  const pane = getPane(side);
  const targetIndex = flatFolders.findIndex(f => String(f.id) === String(folderId));
  if (targetIndex === -1) return;
  const ancestorIds = new Set();
  let searchId = flatFolders[targetIndex].parentId;
  while (searchId) {
    ancestorIds.add(String(searchId));
    const parentIdx = flatFolders.findIndex(f => String(f.id) === String(searchId));
    if (parentIdx === -1) break;
    searchId = flatFolders[parentIdx].parentId;
  }
  
  const targetDepth = flatFolders[targetIndex].depth;
  const hasDepth0Ancestor = targetDepth === 0 || [...ancestorIds].some(id => {
    const f = flatFolders.find(x => String(x.id) === String(id));
    return f && f.depth === 0;
  });
  if (hasDepth0Ancestor) {
    pane.tree.allBookmarksOpen = true;
    flatFolders.forEach((f, i) => { if (f.depth === 0) pane.tree.visibleMap.set(i, true); });
  }

  flatFolders.forEach((f, i) => {
    if (ancestorIds.has(String(f.id))) {
      pane.tree.openMap.set(i, true);
      for (let j = i + 1; j < flatFolders.length; j++) {
        if (flatFolders[j].depth <= f.depth) break;
        if (flatFolders[j].depth === f.depth + 1) {
          pane.tree.visibleMap.set(j, true);
        }
      }
    }
  });

  pane.tree.visibleMap.set(targetIndex, true);
  pane.selection.tree.clear();
  pane.selection.tree.add(targetIndex);
  pane.tree.selected = targetIndex;
  pane.tree.focused = targetIndex;

  renderTree(side);

  requestAnimationFrame(() => {
    const treeEl = document.getElementById(`tree-${side}`);
    const row = treeEl?.querySelector(`.folder-row[data-index="${targetIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });
}

function setupResultsEvents(side) {

const listEl = document.getElementById(`results-list-${side}`);
  if (!listEl) return;
  
  const els = getResultsElements(side);
  if (!els.listEl) return;
  let isDragging = false;

  listEl.addEventListener("click", (e) => {
    const row = e.target.closest(".row");

    if (!e.target.closest(".col-resize-handle")) {
      setActivePanel("results", side);
    }

    if (!row) return;

    const index = Number(row.dataset.index);
    const pane = panes[side];
    const item = pane.currentResults[index];

    if (e.detail === 2 && item) {
      if (item.isFolder) {
        browseFolder(item, side);
      } else if (item.url) {
        browser.tabs.create({ url: item.url });
      }
      return;
    }

    selectIndex(index, {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      panel: "results",
      side
    });
    
    panes[side]._lastInteraction = "mouse";

    isDragging = false;
    requestAnimationFrame(() => {
      if (!isDragging) {
        
        updateSelectionUI(side);
        updateStatus();
      }
    });
  });

  listEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;

    isDragging = true;

    const pane = panes[side];
    const index = Number(row.dataset.index);
    const item = pane.currentResults[index];
    if (!item) return;

    if (!pane.selection.results.has(String(item.id))) {
      selectIndex(index, { panel: "results", side });
    }

    dragState.items = pane.currentResults.filter(x =>
      pane.selection.results.has(String(x.id))
    );
    dragState.sourceSide = side;

    const ghost = document.createElement("div");
    ghost.textContent = dragState.items.length === 1
      ? item.title
      : `${dragState.items.length} items`;
    ghost.style.cssText = "position:fixed;top:-999px;left:-999px;pointer-events:none;padding:4px 8px;background:#333;color:#fff;border-radius:4px;font-size:12px;white-space:nowrap;";
    document.body.appendChild(ghost);
    dragState.ghost = ghost;

    e.dataTransfer.setDragImage(ghost, 0, 0);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "bookmark");
  });

  listEl.addEventListener("dragend", () => {
    isDragging = false;
    dragState.ghost?.remove();
    dragState.ghost = null;
    renderVirtualInPlace(side);
    updateSelectionUI(side);
    updateStatus();
  });

  let resultsDropActive = false;
  let resultsDragOverRow = null;
  const contentEl = listEl.querySelector(".results-content") || listEl;

  function _getFolderIdFromRow(row) {
    if (!row) return null;
    const pane = panes[side];
    const index = Number(row.dataset.index);
    const item = pane.currentResults[index];
    if (!item || !item.isFolder) return null;
    return item.id;
  }

  listEl.addEventListener("dragover", (e) => {
    if (!dragState.items || !dragState.items.length) return;
    const pane = panes[side];

    const hoverRow = e.target.closest(".row");
    const folderIdFromRow = _getFolderIdFromRow(hoverRow);

    if (folderIdFromRow) {
      const isSelfDrag = dragState.sourceSide === side &&
        dragState.items.every(x => String(x.id) === String(folderIdFromRow));
      if (isSelfDrag) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (resultsDragOverRow !== hoverRow) {
        resultsDragOverRow?.classList.remove("drag-over");
        contentEl.classList.remove("drag-over");
        resultsDropActive = false;
        resultsDragOverRow = hoverRow;
        hoverRow.classList.add("drag-over");
      }
      return;
    }

    if (!pane.currentFolderId) return;
    if (dragState.sourceSide === side &&
        dragState.items.every(x => String(x.parentId) === String(pane.currentFolderId))) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (resultsDragOverRow) {
      resultsDragOverRow.classList.remove("drag-over");
      resultsDragOverRow = null;
    }
    resultsDropActive = true;
    contentEl.classList.add("drag-over");
  });

  listEl.addEventListener("dragleave", (e) => {
    if (!listEl.contains(e.relatedTarget)) {
      resultsDropActive = false;
      contentEl.classList.remove("drag-over");
      resultsDragOverRow?.classList.remove("drag-over");
      resultsDragOverRow = null;
    }
  });

  listEl.addEventListener("drop", async (e) => {
    const droppedOnRow = resultsDragOverRow;
    resultsDropActive = false;
    contentEl.classList.remove("drag-over");
    resultsDragOverRow?.classList.remove("drag-over");
    resultsDragOverRow = null;

    if (!dragState.items || !dragState.items.length) return;
    e.preventDefault();

    const folderIdFromRow = _getFolderIdFromRow(droppedOnRow);
    if (folderIdFromRow) {
      const ids = dragState.items.map(x => x.id);
      await moveItems(ids, folderIdFromRow, dragState.sourceSide, side);
      dragState.items = [];
      dragState.sourceSide = null;
      return;
    }

    const targetFolderId = panes[side].currentFolderId;
    if (!targetFolderId) return;

    const ids = dragState.items.map(x => x.id);
    await moveItems(ids, targetFolderId, dragState.sourceSide, side);

    dragState.items = [];
    dragState.sourceSide = null;
  });

}

function normalizeUrl(url = "") {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function getTreeElement(side) {
  return document.getElementById(
    side === "left"
      ? "tree-left"
      : "tree-right"
  );
}

function getResultsElements(side = activePane) {

  const listEl = document.querySelector(
    `#results-list-${side} .results-content`
  );

  if (!listEl) return {};

  return {
    listEl,

    visibleEl: document.querySelector(
      `#results-list-${side} .visible-items`
    ),

    spacerEl: document.querySelector(
      `#results-list-${side} .spacer`
    )
  };
}

function getPane(side = activePane) {
  return panes[side];
}

let currentSortSearch = {
    col: "title",
    asc: true
};
  

let dragState = {
  items: [],
  sourceSide: null,
  targetFolderId: null,
  ghost: null
};

function hasMatchingChild(node, query) {

    if (
        !Array.isArray(node.children)
    ) {
        return false;
    }

    return node.children.some(child => {

        if (
            child?.title &&
            child.title
                .toLowerCase()
                .includes(query)
        ) {
            return true;
        }

        return hasMatchingChild(
            child,
            query
        );
    });
}

function setupSearchKeyboardNavigation() {

  const inputs = [
    "search-left",
    "search-right",
    "tree-search-left",
    "tree-search-right"
  ];

  inputs.forEach(id => {

    const input = document.getElementById(id);
    if (!input) return;

    input.addEventListener("keydown", (e) => {

      const side =
        id.includes("right")
          ? "right"
          : "left";

      const pane = panes[side];

if (
  e.key === "ArrowDown" ||
  e.key === "ArrowUp"
) {

  e.preventDefault();

  activePane = side;

  setActivePanel("results");

  const dir =
    e.key === "ArrowDown"
      ? 1
      : -1;
  
if (
  pane.selection.results.size === 0
) {

  const startIndex =
    dir > 0
      ? 0
      : pane.currentResults.length - 1;

  if (pane.currentResults[startIndex]) {

    selectIndex(startIndex, {
      panel: "results"
    });

    ensureRowVisible(startIndex, side);
  }

} else {

    const next =
      pane.currentRowIndex + dir;

    if (
      next >= 0 &&
      next < pane.currentResults.length
    ) {

      selectIndex(next, {
        panel: "results"
      });

      ensureRowVisible(next, side);
    }
  }

  renderVirtual(side);
  updateSelectionUI(side);
  updateStatus();

  return;
}

    });
  });
}

function escapeHtml(str = "") {

    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function selectIndex(
  index,
  {
    ctrl = false,
    shift = false,
    panel = "results",
    side = activePane
  } = {}
) {
  const pane = getPane(side);
  const sel = pane.selection[panel];

  if (panel === "tree") {
    setActiveFolder(index);
    return;
  }

  const item = pane.currentResults[index];
  if (!item) return;

  const id = String(item.id);

  clearOtherPanelSelection(side);

  if (shift) {
    if (pane.anchor.results == null) {
      const cur = pane.currentResults[pane.currentRowIndex];
      pane.anchor.results = cur ? String(cur.id) : id;
    }

    const anchorIndex = pane.currentResults.findIndex(
      x => String(x.id) === String(pane.anchor.results)
    );
    const from = anchorIndex === -1 ? index : anchorIndex;
    const start = Math.min(from, index);
    const end   = Math.max(from, index);

    if (!ctrl) sel.clear();

    for (let i = start; i <= end; i++) {
      const it = pane.currentResults[i];
      if (it) sel.add(String(it.id));
    }

    pane.currentRowIndex = index;
    updateSelectionUI(side);
    updateStatus();
    return;
  }

  if (ctrl) {
    if (sel.has(id)) {
      sel.delete(id);
    } else {
      sel.add(id);
    }
    pane.anchor.results = id;
    pane.currentRowIndex = index;
    updateSelectionUI(side);
    updateStatus();
    return;
  }

  sel.clear();
  sel.add(id);
  pane.anchor.results = id;
  pane.currentRowIndex = index;
  updateSelectionUI(side);
  updateStatus();
}

function getStateKey(side = activePane) {

  const search = normalizeText(
    document.getElementById(`search-${side}`)?.value || ""
  );

  const treeSearch = normalizeText(
    document.getElementById(`tree-search-${side}`)?.value || ""
  );

  const sort =
    (getPane(side).sort?.col || "title") + "_" + (getPane(side).sort?.asc ?? true);

  const pane = getPane(side);

  const datasetId = pane.isSearchMode
    ? "search"
   : (pane.currentFolderId || null);

  return (
    side + "::" +
    datasetId + "::" +
    search + "::" +
    treeSearch + "::" +
    sort
  );
}

function saveState(side = activePane) {
	
	const pane = getPane(side);

if (pane.isSearchMode) {

  pane.selection.results.clear();
  pane.anchor.results = null;
  pane.currentRowIndex = 0;

  updateSelectionUI(side);
  updateStatus();

  return;
}

  const key = getStateKey(side);

  const { listEl } = getResultsElements(side);

  selectionCache.set(key, new Set(pane.selection.results));
  anchorCache.set(key, pane.anchor.results);
  cursorCache.set(key, pane.currentRowIndex);

  scrollCache.set(key, listEl?.scrollTop || 0);
}

function updateSortIcons() {
    ["left", "right"].forEach(side => {
        const paneEl = document.getElementById(`pane-${side}`);
        if (!paneEl) return;
        const sort = panes[side].sort || { col: "title", asc: true };
        paneEl.querySelectorAll('.sort-col').forEach(el => {
            const icon = el.querySelector('.sort-icon');
            if (!icon) return;
            if (el.dataset.sort === sort.col) {
                icon.textContent = sort.asc ? '▲' : '▼';
                icon.style.opacity = "1";
            } else {
                icon.textContent = '';
                icon.style.opacity = "0";
            }
        });
    });
}

function getDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function compareValues(aVal, bVal, asc = true, key = "") {

if (key === "url") {
  const aDomain = getDomain(aVal);
  const bDomain = getDomain(bVal);

  const domainCmp = aDomain.localeCompare(bDomain, "tr", { sensitivity: "base" });
  if (domainCmp !== 0) return asc ? domainCmp : -domainCmp;

  aVal = normalizeUrl(aVal);
  bVal = normalizeUrl(bVal);
}

  aVal = aVal ?? "";
  bVal = bVal ?? "";

  let result;

  if (typeof aVal === "string" && typeof bVal === "string") {
    result = aVal.localeCompare(bVal, "tr", { sensitivity: "base" });
  } else {
    if (aVal < bVal) result = -1;
    else if (aVal > bVal) result = 1;
    else result = 0;
  }

  return asc ? result : -result;
}

function triggerDefaultAction(panel, index, mode) {

  if (panel === "results") {

    const bm =
      getPane(activePane)
        .currentResults[index];

    if (!bm) return;

    if (bm.isFolder) {

      browseFolder(bm, activePane);

    } else if (bm.url) {

      if (mode === "background") {
        browser.tabs.create({ url: bm.url, active: false });
      } else if (mode === "window") {
        browser.windows.create({ url: bm.url });
      } else {
        browser.tabs.create({
          url: bm.url
        });
      }
    }
  }

  if (panel === "tree") {

    toggleFolder(index, activePane);
  }
}

function ensureRowVisible(index, side = activePane) {

  const { listEl } = getResultsElements(side);

  if (!listEl) return;

  isKeyboardScrolling = true;

  const rowTop = index * ROW_HEIGHT;
  const rowBottom = rowTop + ROW_HEIGHT;

  const viewTop = listEl.scrollTop;
  const viewBottom = viewTop + listEl.clientHeight;

  if (rowBottom > viewBottom) {
    listEl.scrollTop = rowBottom - listEl.clientHeight;
  } else if (rowTop < viewTop) {
    listEl.scrollTop = rowTop;
  }

  _renderVirtualWindow(side, listEl.scrollTop);

  requestAnimationFrame(() => {
    isKeyboardScrolling = false;
  });
}

function setActivePanel(panel, side = activePane) {
  activePane = side;
  state.activePanel = panel;

  document.querySelectorAll(".pane").forEach(el => {
    el.classList.remove("active-pane");
  });

  const currentPaneEl = document.querySelector(`#pane-${side}`);
  if (currentPaneEl) {
    currentPaneEl.classList.add("active-pane");
  }

  updateSelectionUI(); 
  updateStatus();
}

function clearOtherPanelSelection(activeSide) {
  if (activePane === activeSide) return;

  const other =
    activeSide === "left"
      ? "right"
      : "left";

  const otherPane = panes[other];

  otherPane.selection.results.clear();
  otherPane.anchor.results = null;
  otherPane.currentRowIndex = -1;

  updateSelectionUI(other);
}

function hideContextMenu() {
  const menu = document.getElementById("context-menu");
  if (menu) menu.style.display = "none";
}

function hasChildren(index) {
  return (
    index + 1 < flatFolders.length &&
    flatFolders[index + 1].depth > flatFolders[index].depth
  );
}

function getFullFolderPath(bm) {
    if (!bm) return '';
    let path = [];
    let currentId = bm.parentId;

    while (currentId) {
        const folder = flatFolders.find(f => f.id === currentId);
        if (!folder) break;
        path.unshift(folder.title);
        currentId = folder.parentId;
    }

    if (path.length === 0) {
		return '';
    }
    let cur = flatFolders.find(f => String(f.id) === String(bm.parentId));
    while (cur && cur.parentId) cur = flatFolders.find(f => String(f.id) === String(cur.parentId));

    return path.join('\\');
}

function updatePaneStatus(side) {
  const el = document.getElementById(`pane-mini-${side}`);
  if (!el) return;
  const pane = getPane(side);
  const sel = pane.selection.results.size;
  const folders   = pane.currentResults.filter(x => x.isFolder).length;
  const bookmarks = pane.currentResults.filter(x => !x.isFolder).length;

  const parts = [];
  if (folders > 0)   parts.push(`${folders} Folder${folders !== 1 ? "s" : ""}`);
  if (bookmarks > 0) parts.push(`${bookmarks} Bookmark${bookmarks !== 1 ? "s" : ""}`);
  const baseText = parts.length ? parts.join(", ") : "0 Items";

  if (sel > 0) {
    el.textContent = `${baseText}  |  ${sel} Selected`;
  } else {
    el.textContent = baseText;
  }
}

function updateStatus() {
  const pane = getPane(activePane);

  const isAllBookmarksMode = pane.currentFolderId === null && !pane.isSearchMode;
  if (isAllBookmarksMode) {
    const disableIds = [
      "tb-parent",
      "tb-open-opposite","tb-container-left","tb-container-right",
      "tb-cut","tb-copy-url","tb-paste","tb-select-all",
      "tb-new-folder","tb-rename","tb-delete"
    ];
    disableIds.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = true; btn.style.opacity = "0.35"; }
    });
    [".tb-rename",".tb-danger.tb-delete"].forEach(sel => {
      const btn = document.querySelector(sel);
      if (btn) { btn.disabled = true; btn.style.opacity = "0.35"; }
    });
    ["tb-move-left","tb-move-right"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = true; btn.style.opacity = "0.35"; }
    });
    const openAllBtn = document.querySelector(".tb-open-all");
    if (openAllBtn) { openAllBtn.disabled = false; openAllBtn.style.opacity = ""; }
    updateUndoButton();
    updateRedoButton();
    const titleEl = document.getElementById('stat-name');
    const pathEl  = document.getElementById('stat-path');
    const urlEl   = document.getElementById('stat-url');
    const abSel = pane.selection.results;
    if (abSel.size === 1) {
      const abId = [...abSel][0];
      const abBm = pane.currentResults.find(x => x.id === abId);
      if (abBm) {
        const titleVal = abBm.title || "";
if (abBm.isFolder && !abBm.parentId) {
    if (titleEl) titleEl.textContent = titleVal;
  } else {			  
        if (titleEl) {
          titleEl.textContent = "";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.id = "status-title-input";
          inp.value = titleVal;
          inp.size = Math.max(10, titleVal.length + 1);
          titleEl.appendChild(inp);
        }
	 }
        const ti = document.getElementById('status-title-input');
        if (ti) ti.addEventListener('input', e => { e.target.size = Math.max(10, e.target.value.length + 1); });
        if (pathEl) { pathEl.textContent = getFullFolderPath(abBm); pathEl.style.userSelect = 'text'; }
        if (urlEl)  urlEl.textContent = abBm.url ? abBm.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
        updatePaneStatus("left"); updatePaneStatus("right");
        return;
      }
    }
    if (abSel.size > 1) {
      if (titleEl) titleEl.innerHTML = "";
      if (pathEl) pathEl.textContent = ``;
      if (urlEl)  urlEl.textContent = "";
	    const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) copyBtn.style.display = 'none';
      updatePaneStatus("left"); updatePaneStatus("right");
      return;
    }
    if (titleEl) titleEl.innerHTML = "";
    const abFolders      = pane.currentResults.filter(x => x.isFolder).length;
    const abDirect       = pane.currentResults.length;
    const totalFolders   = flatFolders.length;
    const totalBookmarks = flatAllBookmarks.length;
    const totalAll       = totalFolders + totalBookmarks;
    if (titleEl) titleEl.innerHTML = ``;
    if (pathEl) pathEl.textContent = ``;
    if (urlEl)   urlEl.textContent  = "";
    updatePaneStatus("left"); updatePaneStatus("right");
    return;
  }
  {
    const resetIds = [
      "tb-open-opposite","tb-container-left","tb-container-right",
      "tb-cut","tb-copy-url","tb-paste","tb-select-all","tb-rename","tb-delete"
    ];
    resetIds.forEach(id => {
      const btn = document.getElementById(id);
      if (btn && btn.disabled) { btn.disabled = false; btn.style.opacity = ""; }
    });
    [".tb-rename",".tb-danger.tb-delete",".tb-open-all"].forEach(sel => {
      const btn = document.querySelector(sel);
      if (btn && btn.disabled) { btn.disabled = false; btn.style.opacity = ""; }
    });
    updateUndoButton();
    updateRedoButton();
  }

  {
    const btn = document.getElementById("tb-new-folder");
    if (btn) {
      const shouldDisable = pane.currentFolderId === null;
      btn.disabled = shouldDisable;
      btn.style.opacity = shouldDisable ? "0.35" : "";
    }
  }

  const rootSelected = (() => {
    if (state.activePanel === "tree") {
      const idx = Array.from(pane.selection.tree)[0];
      const ff = idx != null ? flatFolders[idx] : null;
      updatePaneStatus("left"); updatePaneStatus("right");
      return !!(ff && ff.depth === 0);
    }
    const selIds = Array.from(pane.selection.results);
    const checkItems = selIds.length
      ? selIds.map(id => pane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean)
      : (pane.currentRowIndex >= 0 ? [pane.currentResults[pane.currentRowIndex]].filter(Boolean) : []);
    updatePaneStatus("left"); updatePaneStatus("right");
    return checkItems.some(item => {
      if (!item || !item.isFolder) return false;
      const ff = flatFolders.find(f => String(f.id) === String(item.id));
      updatePaneStatus("left"); updatePaneStatus("right");
      return !!(ff && ff.depth === 0);
    });
  })();

  ["tb-cut","tb-copy-url"].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = rootSelected;
    btn.style.opacity = rootSelected ? "0.35" : "";
  });
  [".tb-rename",".tb-danger.tb-delete"].forEach(sel => {
    const btn = document.querySelector(sel);
    if (!btn) return;
    btn.disabled = rootSelected;
    btn.style.opacity = rootSelected ? "0.35" : "";
  });

  {
    const inSearch = pane.isSearchMode;
    const hasSelection = pane.selection.results.size > 0;
    const oppositeSide = activePane === "left" ? "right" : "left";
    const btnL = document.getElementById("tb-container-left");
    const btnR = document.getElementById("tb-container-right");
    if (btnL) {
      const active = hasSelection && (inSearch || activePane !== "left");
      btnL.disabled = !active;
      btnL.style.opacity = active ? "" : "0.35";
    }
    if (btnR) {
      const active = hasSelection && (inSearch || activePane !== "right");
      btnR.disabled = !active;
      btnR.style.opacity = active ? "" : "0.35";
    }
  }

  {
    function _canMovePaneToolbar(sourceSide) {
      const sp = panes[sourceSide];
      if (!sp || sp.selection.results.size === 0) return false;
      const targetSide = sourceSide === "left" ? "right" : "left";
      const tp = panes[targetSide];
      const selIds = Array.from(sp.selection.results);
      const isRootSelected = sp.currentFolderId === null && !sp.isSearchMode && selIds.some(id => {
        const ff = flatFolders.find(f => String(f.id) === String(id));
        return ff && ff.depth === 0;
      });
      if (isRootSelected || !tp || tp.currentFolderId === null) return false;
      const items = selIds.map(id => sp.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
      if (items.length && items.every(item => String(item.parentId) === String(tp.currentFolderId))) return false;
      if (items.filter(i => i.isFolder).some(i => String(i.id) === String(tp.currentFolderId))) return false;
      const tFolder = flatFolders.find(f => String(f.id) === String(tp.currentFolderId));
      if (tFolder) {
        const folderSelIds = items.filter(i => i.isFolder).map(i => String(i.id));
        let anc = tFolder;
        while (anc) {
          if (folderSelIds.includes(String(anc.id))) return false;
          anc = anc.parentId ? flatFolders.find(f => String(f.id) === String(anc.parentId)) : null;
        }
      }
      return true;
    }

    function _updateMoveBtn(sourceSide) {
      const btnId = sourceSide === "left" ? "tb-move-left" : "tb-move-right";
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const ok = _canMovePaneToolbar(sourceSide);
      btn.disabled = !ok;
      btn.style.opacity = ok ? "" : "0.35";
      const targetSide = sourceSide === "left" ? "right" : "left";
      const tp = panes[targetSide];
      const tFolder = tp && tp.currentFolderId
        ? flatFolders.find(f => String(f.id) === String(tp.currentFolderId))
        : null;
      const tLabel = tFolder ? `"${tFolder.title}"` : (targetSide === "right" ? "Right Panel" : "Left Panel");
      const tip = btn.querySelector(".tb-tooltip");
      const fKey = sourceSide === "left" ? "F6" : "F7";
      if (tip) tip.textContent = `Move to ${tLabel} (${fKey})`;
    }

    _updateMoveBtn("left");
    _updateMoveBtn("right");
  }

  {
    const btn = document.getElementById("tb-open-opposite");
    if (btn) {
      let hasFolder = false;
      if (state.activePanel === "tree") {
        const treeIdx = Array.from(pane.selection.tree)[0];
        if (treeIdx != null && flatFolders[treeIdx]) hasFolder = true;
      }
      if (!hasFolder) {
        const selId = Array.from(pane.selection.results)[0];
        if (selId) {
          const selItem = pane.currentResults.find(x => String(x.id) === String(selId));
          if (selItem && selItem.isFolder) hasFolder = true;
        }
        if (!hasFolder && pane.currentRowIndex >= 0) {
          const cur = pane.currentResults[pane.currentRowIndex];
          if (cur && cur.isFolder) hasFolder = true;
        }
      }
      btn.disabled = !hasFolder;
      btn.style.opacity = hasFolder ? "" : "0.35";
    }
  }

  const titleEl = document.getElementById('stat-name');
  const pathEl = document.getElementById('stat-path');
  const urlEl = document.getElementById('stat-url');

  if (!titleEl || !pathEl || !urlEl) return;

  const sel = pane.selection.results;
  const count = sel.size;

  if (count > 1) {
    titleEl.innerHTML = "";
    pathEl.textContent =``;
    urlEl.textContent = "";
	  const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) copyBtn.style.display = 'none';
    updatePaneStatus("left"); updatePaneStatus("right");
    return;
  }

  if (count === 1) {
    const id = [...sel][0];
const bm = pane.currentResults.find(x => x.id === id) ?? null;

    if (!bm) {
      titleEl.innerHTML = "";
      pathEl.textContent = `${pane.currentResults.length} Items`;
      urlEl.textContent = "";
	    const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) copyBtn.style.display = 'none';

      updatePaneStatus("left"); updatePaneStatus("right");
      return;
    }

const titleVal = bm.title || "";
const oldTitle = titleVal;
titleEl.textContent = "";
const _inp = document.createElement("input");
_inp.type = "text";
_inp.id = "status-title-input";
_inp.value = titleVal;
_inp.size = Math.max(10, titleVal.length + 1);
titleEl.appendChild(_inp);    const titleInput = document.getElementById('status-title-input');
    titleInput.addEventListener('input', (e) => {
      e.target.size = Math.max(10, e.target.value.length + 1);
    });
    titleInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Enter' && bm.id) {
          const newTitle = titleInput.value.trim();
          if (newTitle && newTitle !== oldTitle) {
            try {
              isRenaming = true;
              await browser.bookmarks.update(String(bm.id), { title: newTitle });
              undoPush({ type: "rename", id: String(bm.id), oldTitle, newTitle });
              bm.title = newTitle;
              for (const s of ["left", "right"]) {
                _applyRenameToPane(s, String(bm.id), newTitle);
              }
            } catch (_) {} finally { isRenaming = false; }
          }
        } else if (e.key === 'Escape') {
          titleInput.value = oldTitle;
        }
        titleInput.blur();
      }
    });
    titleInput.addEventListener('blur', async () => {
      if (!bm.id) return;
      const newTitle = titleInput.value.trim();
      if (newTitle && newTitle !== oldTitle) {
        try {
          isRenaming = true;
          await browser.bookmarks.update(String(bm.id), { title: newTitle });
          undoPush({ type: "rename", id: String(bm.id), oldTitle, newTitle });
          bm.title = newTitle;
          for (const s of ["left", "right"]) {
            _applyRenameToPane(s, String(bm.id), newTitle);
          }
        } catch (_) {} finally { isRenaming = false; }
      }
    });

pathEl.textContent = getFullFolderPath(bm);
pathEl.style.userSelect = 'text';

if (bm.url) {
  urlEl.textContent = bm.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  urlEl.style.userSelect = 'text';
  const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) {
    copyBtn.style.display = 'inline';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(bm.url);
      showToast('URL copied!');
    };
  }
} else {
  urlEl.textContent = "";
  const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) copyBtn.style.display = 'none';
}

    updatePaneStatus("left"); updatePaneStatus("right");
    return;
  }

  if (pane.currentFolderId !== null) {
    const rec = countRecursive(String(pane.currentFolderId));
    titleEl.innerHTML = ``;
    pathEl.textContent =``;
    urlEl.textContent = "";
  const copyBtn = document.getElementById('stat-url-copy');
  if (copyBtn) copyBtn.style.display = 'none';

  } else {
    titleEl.innerHTML  = "";
    pathEl.textContent = `${pane.currentResults.length} items`;
    urlEl.textContent  = "";
  }
  updatePaneStatus("left");
  updatePaneStatus("right");
}

function countRecursive(folderId) {
  const id = String(folderId);
  const subFolderIds = new Set();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    const children = flatFolders.filter(f => f.parentId && String(f.parentId) === cur);
    for (const c of children) {
      const cid = String(c.id);
      if (!subFolderIds.has(cid)) {
        subFolderIds.add(cid);
        queue.push(cid);
      }
    }
  }
  const bookmarks = flatAllBookmarks.filter(bm =>
    bm.parentId && (String(bm.parentId) === id || subFolderIds.has(String(bm.parentId)))
  ).length;
  const folders = subFolderIds.size;
  return { folders, bookmarks, total: folders + bookmarks };
}

function highlightFolder(text, side = activePane) {

  const q =
    getTreeSearchInput(side)?.value;

  if (!q) return text;

  const safe =
    q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const reg =
    new RegExp(`(${safe})`, 'gi');

  return text.replace(
    reg,
    '<mark class="hl">$1</mark>'
  );
}

function setupTreeSearch(side) {
  const input = getTreeSearchInput(side);
  if (!input) return;
  input.addEventListener("focus", () => {
    setActivePanel("tree", side);
  });
  input.addEventListener("input", () => {
    const pane = panes[side];
    pane.tree.filter = input.value || "";
    const q = normalizeText(pane.tree.filter);
    pane.tree.visibleMap = new Map();
    pane.tree.openMap = new Map();
    flatFolders.forEach((f, i) => {
      pane.tree.visibleMap.set(i, false);
      pane.tree.openMap.set(i, false);
    });

    if (!q) {
      flatFolders.forEach((f, i) => {
        pane.tree.visibleMap.set(i, f.depth === 0);
        pane.tree.openMap.set(i, false);
      });
      renderTree(side);
      return;
    }

    const matched = new Set();
    flatFolders.forEach((f, i) => {
      if (
        normalizeText(f.title).includes(q)
      ) {
        matched.add(i);
      }
    });

    matched.forEach(index => {
      const folder = flatFolders[index];
      pane.tree.visibleMap.set(index, true);
      pane.tree.openMap.set(index, false);
      let d = folder.depth - 1;
      for (
        let i = index - 1;
        i >= 0 && d >= 0;
        i--
      ) {
        if (flatFolders[i].depth === d) {
          pane.tree.visibleMap.set(i, true);
          pane.tree.openMap.set(i, true);
          d--;
        }
      }

      for (
        let i = index + 1;
        i < flatFolders.length;
        i++
      ) {
        if (flatFolders[i].depth <= folder.depth) break;
        if (flatFolders[i].depth === folder.depth + 1) {
          pane.tree.visibleMap.set(i, true);
        }
      }
    });

    renderTree(side);
  });
}

function setupClearAndEsc() {
  const pairs = [
    ["tree-search-left", "clear-tree-left"],
    ["tree-search-right", "clear-tree-right"],

    ["search-left", "clear-search-left"],
    ["search-right", "clear-search-right"]
  ];
  pairs.forEach(([inputId, clearId]) => {
    const input =
      document.getElementById(inputId);
    const clear =
      document.getElementById(clearId);
    if (!input || !clear) return;
    const wrapper =
      input.closest(".search-wrapper");
    const refresh = () => {
      wrapper.classList.toggle(
        "has-value",
        !!input.value
      );
    };
    refresh();
    input.addEventListener("input", refresh);
    clear.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = "";
      input.dispatchEvent(
        new Event("input")
      );
      input.focus();
      refresh();
    });
  });
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadBookmarks();

  setAllBookmarks("left");
  setAllBookmarks("right");

setupSearch("left");
setupSearch("right");

setupTreeSearch("left");
setupTreeSearch("right");

setupResultsEvents("left");
setupResultsEvents("right");

updateUndoButton();
updateRedoButton();

["left", "right"].forEach(side => {
    const treeEl = getTreeElement(side);
    if (!treeEl) return;

    let dragOverRow = null;

    treeEl.addEventListener("dragover", (e) => {
        if (dragState.items && dragState.items.length > 0) {
            const row = e.target.closest(".folder-row");
            if (row) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";

                if (dragOverRow !== row) {
                    dragOverRow?.classList.remove("drag-over");
                    dragOverRow = row;
                    row.classList.add("drag-over");
                }
            }
        }
    });

    treeEl.addEventListener("dragleave", (e) => {
        if (!treeEl.contains(e.relatedTarget)) {
            dragOverRow?.classList.remove("drag-over");
            dragOverRow = null;
        }
    });

    treeEl.addEventListener("drop", async (e) => {
        dragOverRow?.classList.remove("drag-over");
        dragOverRow = null;

        if (!dragState.items || dragState.items.length === 0) return;

        const row = e.target.closest(".folder-row");
        if (row) {
            e.preventDefault();
            const index = Number(row.dataset.index);
            const targetFolderId = flatFolders[index]?.id;

            if (targetFolderId) {
                const ids = dragState.items.map(x => x.id);
                await moveItems(ids, targetFolderId, dragState.sourceSide, side);
            }
        }
        dragState.items = [];
        dragState.sourceSide = null;
    });
});

setupSearchKeyboardNavigation();

  setupClearAndEsc();
  setupKeyboard();
  setupContextMenuActions();
  setupResultsContextMenu("left");
  setupResultsContextMenu("right");
  setupTreeContextMenu("left");
  setupTreeContextMenu("right");

const pane = getPane(activePane);

  setActivePanel("results", activePane);
setTimeout(() => {
  if (getPane(activePane).currentResults.length) {
    renderVirtual(activePane);
  }
}, 50);

  let ticking = false;

  const menu = document.getElementById("context-menu");

document.getElementById("move-btn")?.addEventListener("click", async () => {
    const sourceSide = activePane;
    const targetSide = sourceSide === "left" ? "right" : "left";
    
    const sourcePane = panes[sourceSide];
    const targetPane = panes[targetSide];

    const ids = Array.from(sourcePane.selection.results);
    if (ids.length === 0) return;

    let targetFolderId = targetPane.currentFolderId;
    
    const selectedTreeIndex = Array.from(targetPane.selection.tree)[0];
    if (selectedTreeIndex !== undefined) {
        targetFolderId = flatFolders[selectedTreeIndex].id;
    }

    if (targetFolderId) {
        await moveItems(ids, targetFolderId, sourceSide, targetSide);
    }
});

document.getElementById("delete-btn")?.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    const panel = state.activePanel;
    const side = activePane;
    await executeDelete(side, panel);
});

document.getElementById("undo-btn")?.addEventListener("click", async () => {
    await executeUndo();
});

document.querySelector(".tb-undo")?.addEventListener("click", async () => {
  await executeUndo();
});

async function executeMoveFromPane(sourceSide) {
  const sourcePane = panes[sourceSide];
  if (!sourcePane) return;
  const targetSide = sourceSide === "left" ? "right" : "left";
  const targetPane = panes[targetSide];
  const ids = Array.from(sourcePane.selection.results);
  if (!ids.length) return;
  let targetFolderId = targetPane.currentFolderId;
  const selectedTreeIndex = Array.from(targetPane.selection.tree)[0];
  if (selectedTreeIndex !== undefined) targetFolderId = flatFolders[selectedTreeIndex]?.id ?? targetFolderId;
  if (!targetFolderId) return;
  const items = ids.map(id => sourcePane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
  if (items.length && items.every(item => String(item.parentId) === String(targetFolderId))) return;
  await moveItems(ids, targetFolderId, sourceSide, targetSide);
}

document.getElementById("tb-move-left")?.addEventListener("click", () => executeMoveFromPane("left"));
document.getElementById("tb-move-right")?.addEventListener("click", () => executeMoveFromPane("right"));

document.getElementById("tb-open-opposite")?.addEventListener("click", async () => {
  const pane = panes[activePane];
  const targetSide = activePane === "left" ? "right" : "left";
  let item = null;

  if (state.activePanel === "tree") {
    const treeIdx = Array.from(pane.selection.tree)[0];
    if (treeIdx != null && flatFolders[treeIdx]) {
      item = flatFolders[treeIdx];
    }
  }

  if (!item) {
    const sel = Array.from(pane.selection.results)[0];
    if (sel) item = pane.currentResults.find(x => String(x.id) === String(sel) && x.isFolder);
    if (!item && pane.currentRowIndex >= 0) {
      const cur = pane.currentResults[pane.currentRowIndex];
      if (cur && cur.isFolder) item = cur;
    }
  }

  if (!item) return;
  await browseFolder({ id: item.id, title: item.title }, targetSide);
  expandAndSelectInTree(item.id, targetSide);
});

function _tbShowContaining(targetSide) {
  const pane = panes[activePane];
  let item = null;
  const sel = Array.from(pane.selection.results)[0];
  if (sel) item = pane.currentResults.find(x => String(x.id) === String(sel));
  else if (pane.currentRowIndex >= 0) item = pane.currentResults[pane.currentRowIndex];
  if (!item) return;
  const searchInput = document.getElementById(`search-${targetSide}`);
  if (searchInput) { searchInput.value = ""; searchInput.dispatchEvent(new Event("input", { bubbles: true })); }
  const parentId = item.parentId;
  if (parentId) {
    const folder = flatFolders.find(f => String(f.id) === String(parentId));
    if (folder) { browseFolder({ id: folder.id, title: folder.title }, targetSide); expandAndSelectInTree(folder.id, targetSide); }
  }
}

document.getElementById("tb-container-left")?.addEventListener("click", () => _tbShowContaining("left"));
document.getElementById("tb-container-right")?.addEventListener("click", () => _tbShowContaining("right"));

document.querySelector(".tb-delete")?.addEventListener("mousedown", async (e) => {
  e.preventDefault();
  await executeDelete(activePane, state.activePanel);
});

document.querySelector(".tb-rename")?.addEventListener("click", async () => {
  const side = activePane;
  const pane = panes[side];
  let item = null;
  if (state.activePanel === "tree" || pane.selection.results.size === 0) {
    const idx = Array.from(pane.selection.tree)[0];
    if (idx != null) item = { ...flatFolders[idx], isFolder: true };
  }
  if (!item) {
    const ids = Array.from(pane.selection.results);
    if (ids.length) item = pane.currentResults.find(x => String(x.id) === ids[0]);
    else if (pane.currentRowIndex >= 0) item = pane.currentResults[pane.currentRowIndex];
  }
  if (!item) return;
  const oldTitle = item.title || "";
  const newTitle = prompt(item.isFolder ? "Rename folder:" : "Rename bookmark:", oldTitle);
  if (newTitle !== null && newTitle.trim() && newTitle.trim() !== oldTitle) {
    try {
      isRenaming = true;
      await browser.bookmarks.update(String(item.id), { title: newTitle.trim() });
      undoPush({ type: "rename", id: String(item.id), oldTitle, newTitle: newTitle.trim() });
      for (const s of ["left", "right"]) {
        _applyRenameToPane(s, String(item.id), newTitle.trim());
      }
      const ff = flatFolders.find(x => String(x.id) === String(item.id));
      if (ff) { ff.title = newTitle.trim(); renderTree("left"); renderTree("right"); }
    } catch (_) {} finally { isRenaming = false; }
  }
});

document.getElementById("tb-back")?.addEventListener("click", async () => {
  const pane = panes[activePane];
  const nextIdx = pane.historyIndex - 1;
  if (nextIdx < 0) return;
  const folderId = pane.history[nextIdx];
  pane.historyIndex = nextIdx;
  _historyNavigating = true;
  if (folderId === null) { setAllBookmarks(activePane); }
  else {
    const folder = flatFolders.find(f => String(f.id) === String(folderId));
    if (folder) { await browseFolder({ id: folder.id, title: folder.title }, activePane); expandAndSelectInTree(folder.id, activePane); }
  }
  _historyNavigating = false;
  updateNavButtons(activePane);
});

document.getElementById("tb-forward")?.addEventListener("click", async () => {
  const pane = panes[activePane];
  const nextIdx = pane.historyIndex + 1;
  if (nextIdx >= pane.history.length) return;
  const folderId = pane.history[nextIdx];
  pane.historyIndex = nextIdx;
  _historyNavigating = true;
  if (folderId === null) { setAllBookmarks(activePane); }
  else {
    const folder = flatFolders.find(f => String(f.id) === String(folderId));
    if (folder) { await browseFolder({ id: folder.id, title: folder.title }, activePane); expandAndSelectInTree(folder.id, activePane); }
  }
  _historyNavigating = false;
  updateNavButtons(activePane);
});

document.getElementById("tb-parent")?.addEventListener("click", async () => {
  const pane = panes[activePane];
  if (pane.isSearchMode) { document.getElementById(`search-${activePane}`)?.focus(); return; }
  if (!pane.currentFolderId) return;
  const folder = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
  if (!folder) return;
  if (folder.parentId) {
    const parent = flatFolders.find(f => String(f.id) === String(folder.parentId));
    if (parent) { await browseFolder({ id: parent.id, title: parent.title }, activePane); expandAndSelectInTree(parent.id, activePane); }
    else { setAllBookmarks(activePane); }
  } else {
    setAllBookmarks(activePane);
  }
  updateNavButtons(activePane);
});

document.getElementById("tb-cut")?.addEventListener("click", () => {
  const side = activePane;
  const pane = panes[side];
  let items = [];
  if (state.activePanel === "tree") {
    const idx = [...pane.selection.tree][0];
    if (idx != null) items = [{ ...flatFolders[idx], isFolder: true }];
  } else {
    const ids = [...pane.selection.results];
    if (!ids.length && pane.currentRowIndex >= 0) {
      const cur = pane.currentResults[pane.currentRowIndex];
      if (cur) ids.push(String(cur.id));
    }
    items = ids.map(id => pane.currentResults.find(x => String(x.id) === id)).filter(Boolean);
  }
  if (items.length) { ctxClipboard = { items, op: "cut" }; showToast(`${items.length} item(s) cut`); renderVirtualInPlace(side); }
  updatePasteButton();
});

document.getElementById("tb-copy-url")?.addEventListener("click", () => {
  const side = activePane;
  const pane = panes[side];
  let items = [];
  const ids = [...pane.selection.results];
  if (!ids.length && pane.currentRowIndex >= 0) {
    const cur = pane.currentResults[pane.currentRowIndex];
    if (cur) ids.push(String(cur.id));
  }
  items = ids.map(id => pane.currentResults.find(x => String(x.id) === id)).filter(Boolean);
  if (!items.length) return;
  const text = items.map(i => i.url || i.title || "").filter(Boolean).join("\n");
  navigator.clipboard.writeText(text).catch(() => {});
  ctxClipboard = { items, op: "copy" };
  showToast(`Copied ${items.length} URL(s)`);
  updatePasteButton();
});

document.getElementById("tb-paste")?.addEventListener("click", async () => {
  if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;
  const side = activePane;
  const pane = panes[side];
  const targetFolderId = pane.currentFolderId;
  if (!targetFolderId) return;
  const movedIds = [];
  const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
  for (const item of ctxClipboard.items) {
    if (String(item.parentId) === String(targetFolderId)) continue;
    try { await browser.bookmarks.move(String(item.id), { parentId: String(targetFolderId) }); movedIds.push(String(item.id)); } catch (_) {}
  }
  if (movedIds.length) undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: String(targetFolderId), sourceSide: side, targetSide: side, clipboardSnapshot: ctxClipboard.items.slice() });
  ctxClipboard = null;
  updatePasteButton();
  await loadBookmarks();
  const folder = flatFolders.find(f => String(f.id) === String(targetFolderId));
  if (folder) await browseFolder({ id: folder.id, title: folder.title }, side);
});

document.getElementById("tb-select-all")?.addEventListener("click", () => {
  const side = activePane;
  const pane = panes[side];
  if (!pane.currentResults.length) return;
  pane.currentResults.forEach(item => pane.selection.results.add(String(item.id)));
  pane.anchor.results = String(pane.currentResults[0].id);
  pane.currentRowIndex = pane.currentResults.length - 1;
  renderVirtualInPlace(side); updateSelectionUI(side); updateStatus();
});

document.getElementById("tb-new-folder")?.addEventListener("click", async () => {
  const side = activePane;
  const pane = panes[side];
  const parentId = pane.currentFolderId || "unfiled_____";
  const name = prompt("New folder name:");
  if (!name || !name.trim()) return;
  try {
    await browser.bookmarks.create({ parentId: String(parentId), title: name.trim() });
    await loadBookmarks();
    const folder = flatFolders.find(f => String(f.id) === String(parentId));
    if (folder) await browseFolder({ id: folder.id, title: folder.title }, side);
  } catch (_) {}
});

async function executeRedo() {
  if (!redoHistory.length) return;
  const record = redoHistory.pop();
  updateRedoButton();
  undoHistory.push(record);
  updateUndoButton();

  if (record.type === "rename") {
    try {
      isRenaming = true;
      await browser.bookmarks.update(record.id, { title: record.newTitle });
    } catch (_) {
      showToast("Redo failed"); isRenaming = false; return;
    }
    for (const s of ["left", "right"]) {
      _applyRenameToPane(s, String(record.id), record.newTitle);
    }
    const fabRedo = flatAllBookmarks.find(x => String(x.id) === String(record.id));
    if (fabRedo) { fabRedo.title = record.newTitle; fabRedo.full = (record.newTitle + " " + (fabRedo.url || "") + " " + (fabRedo.fullPath || "")).toLowerCase(); }
    const ffRedo = flatFolders.find(x => String(x.id) === String(record.id));
    if (ffRedo) { ffRedo.title = record.newTitle; renderTree("left"); renderTree("right"); }
    _browseFolderCache.clear();
    _sortCache.clear();
    for (const s of ["left", "right"]) {
      renderVirtualInPlace(s);
    }
    isRenaming = false;
    showToast(`"${record.oldTitle}" → "${record.newTitle}"`);
    updateStatus();

  } else if (record.type === "delete") {
    isMoving = true;
    for (const { item } of record.items) {
      try {
        if (item.isFolder) await browser.bookmarks.removeTree(String(item.id));
        else await browser.bookmarks.remove(String(item.id));
      } catch (_) {}
    }
    await loadBookmarks();
    isMoving = false;
    showToast(`${record.items.length} item(s) deleted again`);
    for (const s of ["left", "right"]) {
      const p = panes[s];
      if (p.isSearchMode) {
        const searchInput = document.getElementById(`search-${s}`);
        if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (p.currentFolderId) {
        const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
        if (f) await browseFolder({ id: f.id, title: f.title }, s);
        else renderVirtual(s);
      } else {
        renderVirtual(s);
      }
    }
    updateStatus();

  } else if (record.type === "move") {
    isMoving = true;
    try {
      for (const id of record.movedIds) {
        try { await browser.bookmarks.move(String(id), { parentId: String(record.toFolderId) }); } catch (_) {}
      }
    } finally { isMoving = false; }
    showToast(`${record.movedIds.length} item(s) moved again`);
    await loadBookmarks();
    for (const s of ["left", "right"]) {
      const p = panes[s];
      if (p.currentFolderId) {
        const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
        if (f) await browseFolder({ id: f.id, title: f.title }, s);
      } else {
        renderVirtual(s);
      }
    }
    updateStatus();
  }
}

document.getElementById("tb-redo")?.addEventListener("click", async () => {
  await executeRedo();
});



document.querySelector(".tb-open-all")?.addEventListener("click", async () => {  const side = activePane;
  const pane = panes[side];
  function collectUrls(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.url) out.push(n.url);
      if (n.children?.length) out.push(...collectUrls(n.children));
    }
    return out;
  }
  let urls = [];
  if (pane.currentFolderId === null && !pane.isSearchMode && pane.selection.results.size === 0) {
    urls = collectUrls(allBookmarks.flatMap(r => r.children || []));
  } else {
    const selItems = pane.selection.results.size > 0
      ? Array.from(pane.selection.results).map(id => pane.currentResults.find(x => String(x.id) === id)).filter(Boolean)
      : pane.currentResults;
    for (const item of selItems) {
      if (item.url) { urls.push(item.url); }
      else if (item.isFolder) {
        try {
          const result = await browser.bookmarks.getSubTree(String(item.id));
          urls.push(...collectUrls(result?.[0]?.children || []));
        } catch (_) {}
      }
    }
  }
  if (!urls.length) return;
  if (urls.length > 5) {
    const ok = await showConfirm(`Open ${urls.length} bookmarks in new tabs?`, "Open All");
    if (!ok) return;
  }
  for (const url of urls) await browser.tabs.create({ url, active: false });
});

document.getElementById("tree-left")
?.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  setActivePanel("tree", "left");
});

let _leftTreeClickTimer = null;

document.getElementById("tree-left")
?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const row = e.target.closest(".folder-row");
  if (!row) return;

  const index = Number(row.dataset.index);

  if (index === -1) {
    if (e.target.closest(".tree-arrow")) {
      toggleAllBookmarks("left");
    }
    setAllBookmarks("left");
    return;
  }

  if (e.target.closest(".tree-arrow")) {
    toggleFolder(index, "left");
    return;
  }

  clearTimeout(_leftTreeClickTimer);
  _leftTreeClickTimer = setTimeout(() => {
    setActiveFolder(index, "left");
  }, 220);
});

document.getElementById("tree-left")
?.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".folder-row");
  if (!row) return;

  const index = Number(row.dataset.index);

  if (index === -1) {
    toggleAllBookmarks("left");
    return;
  }

if (!e.target.closest(".tree-arrow")) {
  clearTimeout(_leftTreeClickTimer);

  setActiveFolder(index, "left");
  toggleFolder(index, "left");
}
});

document.getElementById("tree-right")
?.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  setActivePanel("tree", "right");
});

let _rightTreeClickTimer = null;

document.getElementById("tree-right")
?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const row = e.target.closest(".folder-row");
  if (!row) return;

  const index = Number(row.dataset.index);

  if (index === -1) {
    if (e.target.closest(".tree-arrow")) {
      toggleAllBookmarks("right");
    }
    setAllBookmarks("right");
    return;
  }

  if (e.target.closest(".tree-arrow")) {
    toggleFolder(index, "right");
    return;
  }

  clearTimeout(_rightTreeClickTimer);
  _rightTreeClickTimer = setTimeout(() => {
    setActiveFolder(index, "right");
  }, 220);
});

document.getElementById("tree-right")
?.addEventListener("dblclick", (e) => {
  const row = e.target.closest(".folder-row");
  if (!row) return;

  const index = Number(row.dataset.index);

  if (index === -1) {
    toggleAllBookmarks("right");
    return;
  }

if (!e.target.closest(".tree-arrow")) {
  clearTimeout(_rightTreeClickTimer);

  setActiveFolder(index, "right");
  toggleFolder(index, "right");
}
});

  menu.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

});

document.addEventListener("click", hideContextMenu);
document.addEventListener("mousedown", (e) => {
  const menu = document.getElementById("context-menu");
  if (menu && menu.style.display !== "none" && !menu.contains(e.target)) {
    hideContextMenu();
  }
}, true);
document.addEventListener("scroll", hideContextMenu);
window.addEventListener("blur", hideContextMenu);

browser.bookmarks.onCreated.addListener(() => {
  if (!isMoving) loadBookmarks();
});

browser.bookmarks.onRemoved.addListener(() => {
  if (!isMoving) loadBookmarks();
});

browser.bookmarks.onChanged.addListener(() => {
  if (!isMoving && !isRenaming) loadBookmarks();
});

browser.bookmarks.onMoved.addListener(() => {
  if (!isMoving) loadBookmarks();
});

document.querySelectorAll('.sort-col').forEach(cell => {

  cell.addEventListener('click', (e) => {

    if (e.target.closest('.col-resize-handle')) return;
    const panelEl = cell.closest('#pane-left, #pane-right');
    const side = panelEl?.id === 'pane-right' ? 'right' : (panelEl?.id === 'pane-left' ? 'left' : activePane);
    const pane = getPane(side);
    const listEl =
      document.querySelector(
        `#results-list-${side} .results-content`
      );
    saveState(side);
    const selectedIds =
      new Set(pane.selection.results);
    const sort = pane.sort;
    if (sort.col === cell.dataset.sort) {
      sort.asc = !sort.asc;
    } else {
      sort.col = cell.dataset.sort;
      sort.asc = true;
    }
    sortResults(side);
    renderVirtual(side);
    pane.selection.results.clear();
    for (const id of selectedIds) {
      if (pane.currentResults.find(x => x.id === id)) {
        pane.selection.results.add(id);
      }
    }
    const firstId = [...selectedIds][0];
    const newIndex =
      pane.currentResults.findIndex(
        x => x.id === firstId
      );
    if (newIndex !== -1) {
      pane.currentRowIndex = newIndex;
      listEl.scrollTop = newIndex * ROW_HEIGHT;
    }
    updateSelectionUI(side);
    updateSortIcons();
  });
});

let ctxSide = "left";
let ctxContext = "results";

function showContextMenu(x, y, type, { isSearchMode = false, emptyArea = false } = {}) {
  const menu = document.getElementById("context-menu");

  if (emptyArea) {
    menu.querySelectorAll("[data-type]").forEach(el => { el.style.display = "none"; });
    menu.querySelectorAll("hr[data-type]").forEach(hr => { hr.style.display = "none"; });
    const pasteEl = document.getElementById("ctx-empty-paste");
    const addFolderEl = document.getElementById("ctx-empty-add-folder");
    const selectAllEl = document.getElementById("ctx-empty-select-all");
    const hrEmpty = document.getElementById("ctx-empty-hr");
    if (pasteEl) {
      const hasPaste = !!(ctxClipboard?.items?.length && ctxClipboard.op === "cut");
      pasteEl.style.display = "flex";
      pasteEl.style.opacity = hasPaste ? "" : "0.4";
      pasteEl.style.pointerEvents = hasPaste ? "" : "none";
    }
    if (addFolderEl) {
      addFolderEl.style.display = "flex";
      const isAllBookmarks = panes[ctxSide].currentFolderId === null;
      addFolderEl.style.opacity = isAllBookmarks ? "0.4" : "";
      addFolderEl.style.pointerEvents = isAllBookmarks ? "none" : "";
    }
    const pane = panes[ctxSide];
    const hasResults = pane.currentResults && pane.currentResults.length > 0;
    if (selectAllEl) {
      selectAllEl.style.display = "flex";
      selectAllEl.style.opacity = hasResults ? "" : "0.4";
      selectAllEl.style.pointerEvents = hasResults ? "" : "none";
    }
    if (hrEmpty) hrEmpty.style.display = "block";
    menu.style.display = "block";
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || 200;
    menu.style.left = (x + mw > window.innerWidth  ? window.innerWidth  - mw - 4 : x) + "px";
    menu.style.top  = (y + mh > window.innerHeight ? window.innerHeight - mh - 4 : y) + "px";
    return;
  }

  menu.querySelectorAll("[data-type]").forEach(el => {
    if (el.dataset.type !== type) { el.style.display = "none"; return; }
    el.style.display = (el.dataset.ctx === "search-only" && !isSearchMode) ? "none" : "flex";
  });
  menu.querySelectorAll("hr[data-type]").forEach(hr => {
    if (hr.dataset.type !== type) { hr.style.display = "none"; return; }
    hr.style.display = (hr.dataset.ctx === "search-only" && !isSearchMode) ? "none" : "block";
  });
  ["ctx-empty-paste","ctx-empty-add-folder","ctx-empty-select-all"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  const hrEmpty = document.getElementById("ctx-empty-hr");
  if (hrEmpty) hrEmpty.style.display = "none";

  if (type === "bookmark") {
    const pane = panes[ctxSide];
    const multi = pane.selection.results.size > 1;
    const _setDisabled = (id, disabled) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.opacity = disabled ? "0.4" : "";
      el.style.pointerEvents = disabled ? "none" : "";
    };
    _setDisabled("ctx-rename", multi);
    const hasCut = !!(ctxClipboard?.items?.length && ctxClipboard.op === "cut");
    _setDisabled("ctx-paste", !hasCut);
    const expandLeftEl = document.getElementById("ctx-expand-left");
    const expandRightEl = document.getElementById("ctx-expand-right");
    if (!isSearchMode) {
      if (expandLeftEl)  expandLeftEl.style.display  = ctxSide === "left"  ? "none" : "flex";
      if (expandRightEl) expandRightEl.style.display = ctxSide === "right" ? "none" : "flex";
    } else {
      if (expandLeftEl)  expandLeftEl.style.display  = "flex";
      if (expandRightEl) expandRightEl.style.display = "flex";
      if (multi) {
        _setDisabled("ctx-expand-left", true);
        _setDisabled("ctx-expand-right", true);
      }
    }
  }

  const _ctxTargetSide = ctxSide === "left" ? "right" : "left";
  const _ctxTargetPane = panes[_ctxTargetSide];
  const _ctxTargetFolder = _ctxTargetPane.currentFolderId
    ? flatFolders.find(f => String(f.id) === String(_ctxTargetPane.currentFolderId))
    : null;
  const _ctxFolderLabel = _ctxTargetFolder ? `"${_ctxTargetFolder.title}"` : (_ctxTargetSide === "right" ? "Right Panel" : "Left Panel");
  const ctxSendEl = document.getElementById("ctx-send");
  if (ctxSendEl) ctxSendEl.textContent = `Move to ${_ctxFolderLabel}`;
  const ctxFolderSendEl = document.getElementById("ctx-folder-send");
  if (ctxFolderSendEl) ctxFolderSendEl.textContent = `Move to ${_ctxFolderLabel}`;
  const ctxFolderDisplayOpp = document.getElementById("ctx-folder-display-opposite");
  if (ctxFolderDisplayOpp) ctxFolderDisplayOpp.textContent = "Open in Opposite Panel";

  if (type === "folder") {
    const pane = panes[ctxSide];
    const multiFolder = pane.selection.results.size > 1
      || (ctxContext === "tree" && pane.selection.tree.size > 1);
    if (multiFolder) {
      const _fdisable = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.opacity = "0.4";
        el.style.pointerEvents = "none";
      };
      _fdisable("ctx-folder-rename");
      _fdisable("ctx-folder-add-folder");
      _fdisable("ctx-folder-display-opposite");
    }
    const hasCutFolder = !!(ctxClipboard?.items?.length && ctxClipboard.op === "cut");
    const pasteEl = document.getElementById("ctx-folder-paste");
    if (pasteEl) {
      pasteEl.style.opacity = hasCutFolder ? "" : "0.4";
      pasteEl.style.pointerEvents = hasCutFolder ? "" : "none";
    }
  }

  const ctxDeleteEl = document.getElementById("ctx-delete");
  const ctxFolderDeleteEl = document.getElementById("ctx-folder-delete");
  const _checkRootDelete = () => {
    let isRoot = false;
    if (ctxContext === "tree") {
      const idx = Array.from(panes[ctxSide].selection.tree)[0];
      const ff = idx != null ? flatFolders[idx] : null;
      isRoot = ff && ff.depth === 0;
    } else {
      const pane = panes[ctxSide];
      const selIds = [...pane.selection.results];
      let items;
      if (selIds.length) {
        items = selIds.map(id => pane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
      } else if (pane.currentRowIndex >= 0) {
        const cur = pane.currentResults[pane.currentRowIndex];
        items = cur ? [cur] : [];
      } else {
        items = [];
      }
      isRoot = items.some(item => {
        if (!item || !item.isFolder) return false;
        const ff = flatFolders.find(f => String(f.id) === String(item.id));
        return ff && ff.depth === 0;
      });
    }
    if (isRoot) {
      menu.querySelectorAll("[data-root-hide]").forEach(el => {
        el.style.display = "none";
      });
    }
  };
  _checkRootDelete();

  const oppositeSide = ctxSide === "left" ? "right" : "left";
  const oppositeIsAllBookmarks = panes[oppositeSide].currentFolderId === null;

  const targetFolderId = panes[oppositeSide].currentFolderId;
  const ctxItemsNow = getCtxItems();
  const allAlreadyInTarget = !oppositeIsAllBookmarks && targetFolderId &&
    ctxItemsNow.length > 0 &&
    ctxItemsNow.every(item => {
      if (item.isFolder) return String(item.id) === String(targetFolderId);
      return String(item.parentId) === String(targetFolderId);
    });

  const _disableMove = (el) => {
    if (!el) return;
    const shouldDisable = oppositeIsAllBookmarks || allAlreadyInTarget;
    el.style.opacity = shouldDisable ? "0.4" : "";
    el.style.pointerEvents = shouldDisable ? "none" : "";
  };
  _disableMove(ctxSendEl);
  _disableMove(ctxFolderSendEl);

  if (type === "folder") {
    const _isProtectedFolder = () => {
      if (ctxContext === "tree") {
        const pane = panes[ctxSide];
        const idx = Array.from(pane.selection.tree)[0];
        if (idx == null) return true;
        const ff = flatFolders[idx];
        return !ff || ff.depth === 0;
      } else {
        const pane = panes[ctxSide];
        const items = (() => {
          const ids = [...pane.selection.results];
          if (!ids.length && pane.currentRowIndex >= 0) {
            const cur = pane.currentResults[pane.currentRowIndex];
            return cur ? [cur] : [];
          }
          return ids.map(id => pane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
        })();
        return items.some(item => {
          if (!item) return true;
          const ff = flatFolders.find(f => String(f.id) === String(item.id));
          return !ff || ff.depth === 0;
        });
      }
    };
    const isProtected = _isProtectedFolder();
    const _disableFolderAction = (el) => {
      if (!el) return;
      el.style.opacity = isProtected ? "0.4" : "";
      el.style.pointerEvents = isProtected ? "none" : "";
    };
    if (isProtected) _disableFolderAction(ctxFolderSendEl);

    if (!isProtected && ctxFolderSendEl && targetFolderId) {
      const _isSelfOrDescendant = () => {
        const selectedItems = getCtxItems();
        for (const item of selectedItems) {
          if (!item || !item.isFolder) continue;
          if (String(item.id) === String(targetFolderId)) return true;
          let cur = flatFolders.find(f => String(f.id) === String(targetFolderId));
          while (cur) {
            if (String(cur.id) === String(item.id)) return true;
            cur = flatFolders.find(f => String(f.id) === String(cur.parentId));
          }
        }
        return false;
      };
      if (_isSelfOrDescendant()) {
        ctxFolderSendEl.style.opacity = "0.4";
        ctxFolderSendEl.style.pointerEvents = "none";
      }
    }
  }

  menu.style.display = "block";
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 200;
  menu.style.left = (x + mw > window.innerWidth  ? window.innerWidth  - mw - 4 : x) + "px";
  menu.style.top  = (y + mh > window.innerHeight ? window.innerHeight - mh - 4 : y) + "px";
}

function getCtxItems() {
  const pane = panes[ctxSide];
  if (ctxContext === "tree") {
    const idx = Array.from(pane.selection.tree)[0];
    const folder = flatFolders[idx];
    return folder ? [{ ...folder, isFolder: true }] : [];
  }
  const ids = Array.from(pane.selection.results);
  if (!ids.length && pane.currentRowIndex >= 0) {
    const item = pane.currentResults[pane.currentRowIndex];
    if (item) return [item];
  }
  return ids.map(id => pane.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
}

function setupContextMenuActions() {

  document.getElementById("ctx-open")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    for (const item of getCtxItems()) if (item?.url) await browser.tabs.create({ url: item.url, active: true });
  });

  document.getElementById("ctx-open-bg")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    for (const item of getCtxItems()) if (item?.url) await browser.tabs.create({ url: item.url, active: false });
  });

  document.getElementById("ctx-cut")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    const items = getCtxItems();
if (items.length) { ctxClipboard = { items, op: "cut" }; renderVirtualInPlace(ctxSide); }
  });

  document.getElementById("ctx-copy")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    const items = getCtxItems();
    if (!items.length) return;
    navigator.clipboard.writeText(items.map(i => i.url || i.title || "").filter(Boolean).join("\n")).catch(() => {});
    ctxClipboard = { items, op: "copy" };
  });

  document.getElementById("ctx-paste")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;
    const pane = panes[ctxSide];
    const ctxItem = getCtxItems()[0];
    const targetFolderId = ctxItem
      ? String(ctxItem.parentId || pane.currentFolderId || "unfiled_____")
      : String(pane.currentFolderId || "unfiled_____");
    if (!targetFolderId) return;
    const movedIds = [];
    const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
    for (const item of ctxClipboard.items) {
      if (String(item.parentId) === targetFolderId) continue;
      try { await browser.bookmarks.move(String(item.id), { parentId: targetFolderId }); movedIds.push(String(item.id)); } catch (_) {}
    }
    if (movedIds.length) undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: targetFolderId, sourceSide: ctxSide, targetSide: ctxSide, clipboardSnapshot: ctxClipboard.items.slice() });
    ctxClipboard = null;
    updatePasteButton();
    await loadBookmarks();
    const folder = flatFolders.find(f => String(f.id) === targetFolderId);
    if (folder) await browseFolder({ id: folder.id, title: folder.title }, ctxSide);
    else renderVirtual(ctxSide);
  });

  document.getElementById("ctx-rename")?.addEventListener("click", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    if (!item) return;
    const oldTitle = item.title || "";
    const newTitle = prompt("Rename bookmark:", oldTitle);
    if (newTitle !== null && newTitle.trim() && newTitle.trim() !== oldTitle) {
      try {
        isRenaming = true;
        await browser.bookmarks.update(String(item.id), { title: newTitle.trim() });
        undoPush({ type: "rename", id: String(item.id), oldTitle, newTitle: newTitle.trim() });
        for (const s of ["left", "right"]) {
          _applyRenameToPane(s, String(item.id), newTitle.trim());
        }
      } catch (err) {
      } finally { isRenaming = false; }
    }
  });

  document.getElementById("ctx-delete")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation();
    const side = ctxSide;
    const snap = getCtxItems().slice();
    if (snap.some(item => {
      const ff = flatFolders.find(f => String(f.id) === String(item.id));
      return ff && ff.depth === 0;
    })) { hideContextMenu(); return; }
    hideContextMenu();
    await executeDelete(side, "results", snap);
  });

  document.getElementById("ctx-add-folder")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    const pane = panes[ctxSide];
    const parentId = item
      ? String(item.parentId || pane.currentFolderId || "unfiled_____")
      : String(pane.currentFolderId || "unfiled_____");
    const name = prompt("New folder name:");
    if (name && name.trim()) {
      await browser.bookmarks.create({ parentId, title: name.trim() });
      await loadBookmarks();
      const folder = flatFolders.find(f => String(f.id) === String(parentId));
      if (folder) await browseFolder({ id: folder.id, title: folder.title }, ctxSide);
    }
  });
  
  function _showContainingFolder(item, targetSide) {
    if (!item) return;
    const searchInput = document.getElementById(`search-${targetSide}`);
    if (searchInput) { searchInput.value = ""; searchInput.dispatchEvent(new Event("input", { bubbles: true })); }
    const parentId = item.parentId;
    if (parentId) {
      const folder = flatFolders.find(f => String(f.id) === String(parentId));
      if (folder) { browseFolder({ id: folder.id, title: folder.title }, targetSide); expandAndSelectInTree(folder.id, targetSide); }
    }
  }

  document.getElementById("ctx-expand-left")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    _showContainingFolder(getCtxItems()[0], "left");
  });

  document.getElementById("ctx-expand-right")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    _showContainingFolder(getCtxItems()[0], "right");
  });

  document.getElementById("ctx-send")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    executeMoveFromPane(ctxSide);
  });

  document.getElementById("ctx-folder-open-all")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    function _collectUrls(nodes) { const o=[]; for (const n of nodes) { if (n.url) o.push(n.url); if (n.children?.length) o.push(..._collectUrls(n.children)); } return o; }
    let urls = [];
    const _treeSelIdx = ctxContext === "tree" ? [...panes[ctxSide].selection.tree][0] : undefined;
    const isAllBkCtx = ctxContext === "tree" && (_treeSelIdx == null || _treeSelIdx === -1) && panes[ctxSide].currentFolderId === null;
    if (isAllBkCtx) {
      urls = _collectUrls(allBookmarks?.[0]?.children || []);
    } else {
      const items = getCtxItems();
      if (!items.length) return;
      for (const item of items) {
        try {
          const result = await browser.bookmarks.getSubTree(String(item.id));
          urls.push(..._collectUrls(result?.[0]?.children || []));
        } catch (_) {}
      }
    }
    if (!urls.length) return;
    const WARN_THRESHOLD = 5;
    if (urls.length > WARN_THRESHOLD) {
      const ok = await showConfirm(
        `Open all ${urls.length} links in new tabs?`,
        "Open All"
      );
      if (!ok) return;
    }
    for (const url of urls) await browser.tabs.create({ url, active: false });
  });

  document.getElementById("ctx-folder-open-all-bg")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    function _collectUrlsBg(nodes) { const o=[]; for (const n of nodes) { if (n.url) o.push(n.url); if (n.children?.length) o.push(..._collectUrlsBg(n.children)); } return o; }
    let urls = [];
    const _treeSelIdxBg = ctxContext === "tree" ? [...panes[ctxSide].selection.tree][0] : undefined;
    const isAllBkCtxBg = ctxContext === "tree" && (_treeSelIdxBg == null || _treeSelIdxBg === -1) && panes[ctxSide].currentFolderId === null;
    if (isAllBkCtxBg) {
      urls = _collectUrlsBg(allBookmarks?.[0]?.children || []);
    } else {
      const items = getCtxItems();
      if (!items.length) return;
      for (const item of items) {
        try {
          const result = await browser.bookmarks.getSubTree(String(item.id));
          urls.push(..._collectUrlsBg(result?.[0]?.children || []));
        } catch (_) {}
      }
    }
    if (!urls.length) return;
    const WARN_THRESHOLD = 5;
    if (urls.length > WARN_THRESHOLD) {
      const ok = await showConfirm(
        `Open all ${urls.length} links in background tabs?`,
        "Open All"
      );
      if (!ok) return;
    }
    for (const url of urls) await browser.tabs.create({ url, active: false });
  });

  document.getElementById("ctx-folder-cut")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    const items = getCtxItems();
if (items.length) { ctxClipboard = { items, op: "cut" }; renderVirtualInPlace(ctxSide); }
  });

  document.getElementById("ctx-folder-copy")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    const items = getCtxItems();
    if (items.length) ctxClipboard = { items, op: "copy" };
  });

  document.getElementById("ctx-folder-paste")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;
    const item = getCtxItems()[0];
    const pane = panes[ctxSide];
    const targetFolderId = item ? String(item.id) : String(pane.currentFolderId || "unfiled_____");
    const movedIds = [];
    const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
    for (const ci of ctxClipboard.items) {
      if (String(ci.parentId) === targetFolderId) continue;
      try { await browser.bookmarks.move(String(ci.id), { parentId: targetFolderId }); movedIds.push(String(ci.id)); } catch (_) {}
    }
    if (movedIds.length) undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: targetFolderId, sourceSide: ctxSide, targetSide: ctxSide, clipboardSnapshot: ctxClipboard.items.slice() });
    ctxClipboard = null;
    updatePasteButton();
    await loadBookmarks();
    const folder = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
    if (folder) await browseFolder({ id: folder.id, title: folder.title }, ctxSide);
    else renderVirtual(ctxSide);
  });

  document.getElementById("ctx-folder-rename")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    if (!item) return;
    const oldTitle = item.title || "";
    const newTitle = prompt("Rename folder:", oldTitle);
    if (newTitle !== null && newTitle.trim() && newTitle.trim() !== oldTitle) {
      try {
        isRenaming = true;
        await browser.bookmarks.update(String(item.id), { title: newTitle.trim() });
        undoPush({ type: "rename", id: String(item.id), oldTitle, newTitle: newTitle.trim() });
        for (const s of ["left", "right"]) {
          _applyRenameToPane(s, String(item.id), newTitle.trim());
        }
        const ff = flatFolders.find(x => String(x.id) === String(item.id));
        if (ff) { ff.title = newTitle.trim(); renderTree("left"); renderTree("right"); }
      } catch (_) {} finally { isRenaming = false; }
    }
  });

  document.getElementById("ctx-folder-delete")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation();
    const side = ctxSide;
    const snap = getCtxItems().slice();
    if (snap.some(item => {
      const ff = flatFolders.find(f => String(f.id) === String(item.id));
      return ff && ff.depth === 0;
    })) { hideContextMenu(); return; }
    hideContextMenu();
    await executeDelete(side, "results", snap);
  });

    document.getElementById("ctx-folder-add-folder")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    if (!item) return;
    const parentId = String(item.id);
    const folderName = prompt("New folder name:", "New Folder");
    if (folderName === null) return; 
    const title = folderName.trim() || "New Folder";
    const _addSide = ctxSide;
    const _addPane = panes[_addSide];
    const _addParentIdx = flatFolders.findIndex(f => String(f.id) === parentId);
    if (_addParentIdx !== -1 && _addPane.tree.openMap.get(_addParentIdx)) {
      _addPane.tree.openMap.set(_addParentIdx, true);
    }
    isMoving = true;
    await browser.bookmarks.create({ parentId, title });
    await loadBookmarks();
    isMoving = false;
    if (_addParentIdx !== -1 && !_addPane.tree.openMap.get(_addParentIdx)) {
      if (String(_addPane.currentFolderId) === parentId) {
        const f = flatFolders.find(x => String(x.id) === parentId);
        if (f) await browseFolder({ id: f.id, title: f.title }, _addSide);
      }
    }
  });

  document.getElementById("ctx-folder-display-opposite")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    if (!item) return;
    const targetSide = ctxSide === "left" ? "right" : "left";
    await browseFolder({ id: item.id, title: item.title }, targetSide);
    expandAndSelectInTree(item.id, targetSide);
  });

  document.getElementById("ctx-folder-goto")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const item = getCtxItems()[0];
    if (!item) return;
    const side = ctxSide;
    const searchInput = document.getElementById(`search-${side}`);
    if (searchInput) { searchInput.value = ""; searchInput.dispatchEvent(new Event("input", { bubbles: true })); }
    await browseFolder({ id: item.id, title: item.title }, side);
    expandAndSelectInTree(item.id, side);
  });

  document.getElementById("ctx-folder-send")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const items = getCtxItems();
    if (!items.length) return;
    const targetSide = ctxSide === "left" ? "right" : "left";
    const targetPane = panes[targetSide];
    let targetFolderId = targetPane.currentFolderId;
    const selTreeIdx = Array.from(targetPane.selection.tree)[0];
    if (selTreeIdx !== undefined && flatFolders[selTreeIdx]) {
      targetFolderId = flatFolders[selTreeIdx].id;
    }
    if (!targetFolderId) return;
    const ids = items.map(x => String(x.id));
    await moveItems(ids, targetFolderId, ctxSide, targetSide);
  });

  document.getElementById("ctx-tree-new-folder")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const pane = panes[ctxSide];
    const parentId = pane.currentFolderId || "unfiled_____";
    const name = prompt("New folder name:");
    if (name && name.trim()) await browser.bookmarks.create({ parentId: String(parentId), title: name.trim() });
  });

  document.getElementById("ctx-tree-rename")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const pane = panes[ctxSide];
    const idx = Array.from(pane.selection.tree)[0];
    const folder = flatFolders[idx];
    if (!folder) return;
    const oldTitle = folder.title || "";
    const newTitle = prompt("Rename folder:", oldTitle);
    if (newTitle !== null && newTitle.trim() && newTitle.trim() !== oldTitle) {
      try {
        isRenaming = true;
        await browser.bookmarks.update(String(folder.id), { title: newTitle.trim() });
        undoPush({ type: "rename", id: String(folder.id), oldTitle, newTitle: newTitle.trim() });
        folder.title = newTitle.trim();
        renderTree("left"); renderTree("right");
      } catch (_) {} finally { isRenaming = false; }
    }
  });

  document.getElementById("ctx-tree-delete")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation();
    const side = ctxSide;
    const snap = getCtxItems().slice();
    hideContextMenu();
    await executeDelete(side, "tree", snap);
  });

  document.getElementById("ctx-empty-paste")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;
    const pane = panes[ctxSide];
    const targetFolderId = String(pane.currentFolderId || "unfiled_____");
    const movedIds = [];
    const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
    for (const ci of ctxClipboard.items) {
      if (String(ci.parentId) === targetFolderId) continue;
      try { await browser.bookmarks.move(String(ci.id), { parentId: targetFolderId }); movedIds.push(String(ci.id)); } catch (_) {}
    }
    if (movedIds.length) undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: targetFolderId, sourceSide: ctxSide, targetSide: ctxSide, clipboardSnapshot: ctxClipboard.items.slice() });
    ctxClipboard = null;
    updatePasteButton();
    await loadBookmarks();
    const folder = flatFolders.find(f => String(f.id) === targetFolderId);
    if (folder) await browseFolder({ id: folder.id, title: folder.title }, ctxSide);
    else renderVirtual(ctxSide);
  });

  document.getElementById("ctx-empty-add-folder")?.addEventListener("mousedown", async (e) => {
    e.stopPropagation(); hideContextMenu();
    const pane = panes[ctxSide];
    const parentId = pane.currentFolderId || "unfiled_____";
    const name = prompt("New folder name:");
    if (name && name.trim()) {
      await browser.bookmarks.create({ parentId: String(parentId), title: name.trim() });
      await loadBookmarks();
      const folder = flatFolders.find(f => String(f.id) === String(parentId));
      if (folder) await browseFolder({ id: folder.id, title: folder.title }, ctxSide);
    }
  });

  document.getElementById("ctx-empty-select-all")?.addEventListener("mousedown", (e) => {
    e.stopPropagation(); hideContextMenu();
    const pane = panes[ctxSide];
    pane.selection.results.clear();
    pane.currentResults.forEach(item => pane.selection.results.add(String(item.id)));
    renderVirtual(ctxSide); updateSelectionUI(ctxSide); updateStatus();
  });
}

function setupResultsContextMenu(side) {
  const listEl = document.getElementById(`results-list-${side}`);
  if (!listEl) return;
  listEl.addEventListener("contextmenu", async (e) => {
    e.preventDefault(); e.stopPropagation();
    setActivePanel("results", side);
    ctxSide = side;
    ctxContext = "results";

    const row = e.target.closest(".row");
    if (!row) {
      if (e.target.closest(".table-header")) return;
      showContextMenu(e.clientX, e.clientY, "bookmark", { emptyArea: true });
      return;
    }

    const index = Number(row.dataset.index);
    const pane = panes[side];
    const item = pane.currentResults[index];
    if (!item) return;
    if (!pane.selection.results.has(String(item.id))) {
      selectIndex(index, { panel: "results", side });
      renderVirtualInPlace(side); updateSelectionUI(side); updateStatus();
    }
    const isSearchMode = pane.isSearchMode;
    const menuType = item.isFolder ? "folder" : "bookmark";
    showContextMenu(e.clientX, e.clientY, menuType, { isSearchMode });

    if (item.isFolder) {
      const openAllEl = document.getElementById("ctx-folder-open-all");
      const openAllBgEl = document.getElementById("ctx-folder-open-all-bg");
      const _disable = (el, disabled) => {
        if (!el) return;
        el.style.opacity = disabled ? "0.4" : "";
        el.style.pointerEvents = disabled ? "none" : "";
      };
      try {
        const result = await browser.bookmarks.getSubTree(String(item.id));
        function _hasUrl(nodes) { for (const n of nodes) { if (n.url) return true; if (n.children?.length && _hasUrl(n.children)) return true; } return false; }
        const hasUrls = _hasUrl(result?.[0]?.children || []);
        _disable(openAllEl, !hasUrls);
        _disable(openAllBgEl, !hasUrls);
      } catch (_) {}
    }
  });
}

function setupTreeContextMenu(side) {
  const treeEl = document.getElementById(`tree-${side}`);
  if (!treeEl) return;
  treeEl.addEventListener("contextmenu", async (e) => {
    const row = e.target.closest(".folder-row");
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    setActivePanel("tree", side);
    const index = Number(row.dataset.index);
    if (index >= 0) {
      const pane = panes[side];
      pane.selection.tree.clear(); pane.selection.tree.add(index);
      pane.tree.focused = index; pane.tree.selected = index;
      renderTree(side);
    }
    ctxSide = side;
    ctxContext = "tree";

    if (index === -1) {
      const menu = document.getElementById("context-menu");
      menu.querySelectorAll("[data-type], hr[data-type]").forEach(el => { el.style.display = "none"; });
      ["ctx-empty-paste","ctx-empty-add-folder","ctx-empty-select-all"].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = "none";
      });
      const hrEmpty = document.getElementById("ctx-empty-hr");
      if (hrEmpty) hrEmpty.style.display = "none";
      const openAllEl = document.getElementById("ctx-folder-open-all");
      const openAllBgEl = document.getElementById("ctx-folder-open-all-bg");
      if (openAllEl) openAllEl.style.display = "flex";
      if (openAllBgEl) openAllBgEl.style.display = "flex";
      let hasUrls = false;
      try {
        function _hasUrlAll(nodes) { for (const n of nodes) { if (n.url) return true; if (n.children?.length && _hasUrlAll(n.children)) return true; } return false; }
        hasUrls = _hasUrlAll(allBookmarks.flatMap(r => r.children || []));
      } catch (_) { hasUrls = true; }
      const _disableEl = (el, disabled) => {
        if (!el) return;
        el.style.opacity = disabled ? "0.4" : "";
        el.style.pointerEvents = disabled ? "none" : "";
      };
      _disableEl(openAllEl, !hasUrls);
      _disableEl(openAllBgEl, !hasUrls);
      menu.style.display = "block";
      const mw = menu.offsetWidth || 180;
      const mh = menu.offsetHeight || 200;
      menu.style.left = (e.clientX + mw > window.innerWidth  ? window.innerWidth  - mw - 4 : e.clientX) + "px";
      menu.style.top  = (e.clientY + mh > window.innerHeight ? window.innerHeight - mh - 4 : e.clientY) + "px";
      return;
    }

    const folder = flatFolders[index];
    let hasUrls = false;
    if (folder) {
      try {
        const result = await browser.bookmarks.getSubTree(String(folder.id));
        function _hasUrlT(nodes) { for (const n of nodes) { if (n.url) return true; if (n.children?.length && _hasUrlT(n.children)) return true; } return false; }
        hasUrls = _hasUrlT(result?.[0]?.children || []);
      } catch (_) { hasUrls = true; }
    }
    const openAllEl = document.getElementById("ctx-folder-open-all");
    const openAllBgEl = document.getElementById("ctx-folder-open-all-bg");
    const _disable = (el, disabled) => {
      if (!el) return;
      el.style.opacity = disabled ? "0.4" : "";
      el.style.pointerEvents = disabled ? "none" : "";
    };
    showContextMenu(e.clientX, e.clientY, "folder", { isSearchMode: false });
    _disable(openAllEl, !hasUrls);
    _disable(openAllBgEl, !hasUrls);
  });
}

async function loadBookmarks() {
  _browseFolderCache.clear();
  _sortCache.clear();
	
  const tree = await browser.bookmarks.getTree();
  const pane = getPane(activePane);

  allBookmarks = tree;

  const _openIds = { left: new Set(), right: new Set() };
  const _selectedFolderIds = { left: null, right: null };
  ["left","right"].forEach(s => {
    const p = panes[s];
    p.tree.openMap.forEach((isOpen, idx) => {
      if (isOpen && flatFolders[idx]) _openIds[s].add(String(flatFolders[idx].id));
    });
    const selIdx = [...p.selection.tree][0];
    if (selIdx != null && flatFolders[selIdx]) {
      _selectedFolderIds[s] = String(flatFolders[selIdx].id);
    }
  });

  flatFolders = [];
  buildFlatTree(tree[0].children);

  flatAllBookmarks = collectFolderBookmarks(tree[0].children);

  ["left","right"].forEach(s => {
    const p = panes[s];
    if (!p.currentFolderId) {
      p.tree.visibleMap = new Map();
      p.tree.openMap = new Map();
      if (p.tree.allBookmarksOpen) {
        flatFolders.forEach((f, i) => { if (f.depth === 0) p.tree.visibleMap.set(i, true); });
      }
      return;
    }
    const newOpenMap = new Map();
    const newVisibleMap = new Map();
    flatFolders.forEach((f, i) => { if (f.depth === 0) newVisibleMap.set(i, true); });
    flatFolders.forEach((f, i) => {
      if (_openIds[s].has(String(f.id))) {
        newOpenMap.set(i, true);
        for (let j = i + 1; j < flatFolders.length; j++) {
          if (flatFolders[j].depth <= f.depth) break;
          if (flatFolders[j].depth === f.depth + 1) newVisibleMap.set(j, true);
        }
      }
    });
    p.tree.openMap = newOpenMap;
    p.tree.visibleMap = newVisibleMap;
  });

  renderTree("left");
  renderTree("right");

  ["left", "right"].forEach(s => {
    const p = panes[s];
    if (p.currentFolderId) {
      expandAndSelectInTree(p.currentFolderId, s);
    } else if (_selectedFolderIds[s]) {
      const newIdx = flatFolders.findIndex(f => String(f.id) === _selectedFolderIds[s]);
      if (newIdx !== -1) {
        p.selection.tree.clear();
        p.selection.tree.add(newIdx);
        p.tree.focused = newIdx;
        p.tree.selected = newIdx;
        expandAndSelectInTree(_selectedFolderIds[s], s);
      }
   }
  });

  updateNavButtons("left");
  updateNavButtons("right");
  updateUndoButton();
  updateRedoButton();
  updateStatus();
  isSearchMode = false;

  ["left", "right"].forEach(s => {
    const p = panes[s];
    if (!p.currentFolderId && p.currentResults.length === 0) {
      const topFolders = flatFolders
      .filter(f => f.depth === 0)
      .map(f => ({ id: f.id, title: f.title, isFolder: true, parentId: f.parentId, fullPath: f.title, full: (f.title || "").toLowerCase() }));
      p.baseResults = topFolders;
      p.currentResults = topFolders.slice();
    }
  });

  for (const s of ["left", "right"]) {
    const p = panes[s];
    if (p.isSearchMode) {
      const searchInput = document.getElementById(`search-${s}`);
      if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (p.currentFolderId) {
        const f = flatFolders.find(x => String(x.id) === String(p.currentFolderId));
        if (f) await browseFolder({ id: f.id, title: f.title }, s);
        else {
          p.currentFolderId = null;
          renderVirtual(s);
        }
    } else {
    sortResults(s);
    renderVirtual(s);
    }
  }
  updateStatus();
  }

  function buildFlatTree(nodes, depth = 0, parentId = null) {
    const sorted = [...nodes].sort((a, b) => {
        const aIsFolder = !!a.children;
        const bIsFolder = !!b.children;
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
    });

    sorted.forEach(node => {
        if (!node.children) return;

        flatFolders.push({
            id: node.id,
            title: node.title || "Unnamed",
            children: node.children,
            depth,
            parentId,
            open: false,
            visible: depth === 0,
            childCount: (function countBookmarks(children) {
              let n = 0;
              for (const c of children) {
                if (c.children) n += countBookmarks(c.children);
                else n++;
              }
              return n;
            })(node.children)
        });

        buildFlatTree(node.children, depth + 1, node.id);
    });
}

function renderTree(side = activePane) {
  const pane = panes[side];
  const container = getTreeElement(side);
  if (!container) return;
  const parts = [];
  const allSelected = pane.currentFolderId === null && pane.tree.focused === -1;
  const allOpen = pane.tree.allBookmarksOpen || false;
  const allArrow = allOpen ? "&#9660;" : "&#9654;";
  parts.push(
    `<div class="folder-row all-bookmarks-row${allSelected ? " selected kb-focus" : ""}" data-index="-1" data-depth="0" style="--depth:0">` +
    `<div class="tree-row-inner">` +
    `<span class="tree-arrow all-bm-arrow">${allArrow}</span>` +
    `<span class="tree-icon">📁</span>` +
    `<span class="tree-title">${highlightFolder("All Bookmarks", side)}</span>` +
    `<span class="folder-count-badge">${flatAllBookmarks.length}</span>` +
    `</div></div>`
  );

  flatFolders.forEach((folder, index) => {

    let visible =
      pane.tree.visibleMap.has(index)
        ? pane.tree.visibleMap.get(index)
        : folder.visible;

    if (folder.depth === 0 && !pane.tree.allBookmarksOpen) {
      visible = false;
    }

    if (!visible) return;

    const isSelected = pane.selection.tree.has(index);
    const isFocused = index === pane.tree.focused;
    const hasChild = hasChildren(index);
    const isOpen = pane.tree.openMap?.get(index);

    const classes = [
      "folder-row",
      isSelected ? "selected" : "",
      isFocused  ? "kb-focus"  : "",
      hasChild   ? "has-child" : ""
    ].filter(Boolean).join(" ");

    const arrow = hasChild ? (isOpen ? "&#9660;" : "&#9654;") : "";
    const title = highlightFolder(folder.title, side);
    const displayDepth = pane.tree.allBookmarksOpen ? folder.depth + 1 : folder.depth;
    const countBadge = folder.childCount != null ? `<span class="folder-count-badge">${folder.childCount}</span>` : "";

    parts.push(
      `<div class="${classes}" data-index="${index}" data-depth="${folder.depth}" style="--depth:${displayDepth}">` +
      `<div class="tree-row-inner">` +
      `<span class="tree-arrow">${arrow}</span>` +
      `<span class="tree-icon">📁</span>` +
      `<span class="tree-title">${title}</span>` +
      countBadge +
      `</div></div>`
    );
  });

  const _treeDoc = new DOMParser().parseFromString(
    `<div>${parts.join("")}</div>`, "text/html"
  );
  container.replaceChildren(..._treeDoc.body.firstChild.childNodes);

  if (pane.tree.filter) {
    const anyVisible = flatFolders.some((_, i) => pane.tree.visibleMap.get(i) === true);
    if (!anyVisible) {
      const _noRes = document.createElement("div");
      _noRes.className = "no-results-msg";
      const _strong = document.createElement("strong");
      _strong.textContent = pane.tree.filter;
      _noRes.append('No folders matching "', _strong, '"');
      container.appendChild(_noRes);
    }
  }

  updateStatus();
}

function updateTreeSelection(prevIndex, nextIndex, side = activePane) {
  const pane = panes[side];
  const container = getTreeElement(side);
  if (!container) return;

  if (prevIndex != null) {
    const prevRow = container.querySelector(`.folder-row[data-index="${prevIndex}"]`);
    if (prevRow) {
      prevRow.classList.remove("selected", "kb-focus");
    }
  }

  if (nextIndex != null) {
    const nextRow = container.querySelector(`.folder-row[data-index="${nextIndex}"]`);
    if (nextRow) {
      nextRow.classList.add("selected", "kb-focus");
      nextRow.scrollIntoView({ block: "nearest" });
    }
  }
}

function setAllBookmarks(side = activePane) {
  const pane = panes[side];

  const prev = pane.tree.focused;

  if (!_historyNavigating) _historyPush(pane, null);

  pane.currentFolderId = null;
  pane.tree.focused = -1;
  pane.tree.selected = -1;
  pane.selection.tree.clear();
  pane.selection.results.clear();
  pane.anchor.results = null;
  pane.currentRowIndex = -1;

  if (prev != null && prev !== -1) {
    const container = getTreeElement(side);
    const prevRow = container?.querySelector(`.folder-row[data-index="${prev}"]`);
    if (prevRow) prevRow.classList.remove("selected", "kb-focus");
  }

  const container = getTreeElement(side);
  const allRow = container?.querySelector(`.folder-row[data-index="-1"]`);
  if (allRow) allRow.classList.add("selected", "kb-focus");

  const searchInput = document.getElementById(`search-${side}`);
  const searchVal = searchInput?.value || "";

  if (searchVal) {
    setSearchMode(side, true);
    pane.isSearchMode = true;
    const val = normalizeText(searchVal.trim());
    pane.currentResults = flatAllBookmarks.filter(bm => bm.full.includes(val));
    renderSearchResults(side);
    updateNavButtons(side);
    return;
  }

  pane.isSearchMode = false;
  setSearchMode(side, false);

  const topFolders = flatFolders
    .filter(f => f.depth === 0)
    .map(f => ({
      id: f.id,
      title: f.title,
      isFolder: true,
      parentId: f.parentId,
      fullPath: f.title,
      full: (f.title || "").toLowerCase()
    }));

  pane.baseResults = topFolders;
  pane.currentResults = topFolders.slice();

  renderVirtual(side);
  updateSelectionUI(side);
  updateNavButtons(side);
  updateStatus();
}

function toggleAllBookmarks(side = activePane) {
  const pane = panes[side];
  pane.tree.allBookmarksOpen = !pane.tree.allBookmarksOpen;

  if (pane.tree.allBookmarksOpen) {
    flatFolders.forEach((f, i) => {
      if (f.depth === 0) {
        pane.tree.visibleMap.set(i, true);
      }
    });
  } else {
    flatFolders.forEach((f, i) => {
      pane.tree.visibleMap.set(i, false);
      pane.tree.openMap.set(i, false);
    });
  }

  renderTree(side);
}

async function setActiveFolder(
  index,
  side = activePane
) {
  const myToken = ++folderSelectToken;
  const pane = panes[side];
  const folder = flatFolders[index];

  if (!folder) return;

  const prevIndex = pane.tree.focused;

  pane.tree.focused = index;
  pane.selection.tree.clear();
  pane.selection.tree.add(index);
  pane.tree.selected = index;
  pane.currentFolderId = folder.id;
  pane.selection.results.clear();
  pane.anchor.results = null;
  pane.currentRowIndex = -1;
  updateTreeSelection(prevIndex, index, side);
  const visibleEl = document.querySelector(`#results-list-${side} .visible-items`);
  if (visibleEl) visibleEl.innerHTML = "";
  if (pane.tree.filter) {
    pane.tree.openMap.set(index, true);
    for (let i = index + 1; i < flatFolders.length; i++) {
      if (flatFolders[i].depth <= folder.depth) break;
      if (flatFolders[i].depth === folder.depth + 1) {
        pane.tree.visibleMap.set(i, true);
      }
    }
  }
  renderTree(side);

  await browseFolder({ id: folder.id, title: folder.title }, side);
  if (myToken !== folderSelectToken) return;
  updateNavButtons(side);
  updateSelectionUI();
  updateStatus();
}

function toggleFolder(index, side = activePane) {
  const folder = flatFolders[index];
  const pane = panes[side];
  const current =
  pane.tree.openMap?.get(index) || false;
  pane.tree.openMap.set(index, !current);
  for (let i = index + 1; i < flatFolders.length; i++) {
    if (flatFolders[i].depth <= folder.depth) break;

    if (!current) {
      if (flatFolders[i].depth === folder.depth + 1) {
        pane.tree.visibleMap.set(i, true);
      }
    } else {
  pane.tree.visibleMap.set(i, false);
  pane.tree.openMap.set(i, false);
    }
  }

  renderTree(side);
}

function updateSelectionUI(side = activePane) {
  const pane = panes[side];
  const { visibleEl } =
    getResultsElements(side);

  if (visibleEl) {
    visibleEl.querySelectorAll(".row").forEach(row => {
      const i = Number(row.dataset.index);
      const id = String(row.dataset.id);
      row.classList.toggle(
        "selected",
        pane.selection.results.has(id)
      );
      row.classList.toggle(
        "kb-focus",
        i === pane.currentRowIndex
      );
    });
  }

  document
    .querySelectorAll(
      side === "left"
        ? "#tree-left .folder-row"
        : "#tree-right .folder-row"
    )
    .forEach(row => {
      const i = Number(row.dataset.index);
      if (i === -1) {
        row.classList.toggle(
          "selected",
          pane.currentFolderId === null && pane.tree.focused === -1
        );
        return;
      }
      row.classList.toggle(
        "selected",
        pane.selection.tree.has(i)
      );
    });
}

function setupKeyboard() {

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
      const activeEl = document.activeElement;
      if (!activeEl || !activeEl.matches("input, textarea")) e.preventDefault();
    }
  }, true);

  document.addEventListener("keydown", async(e) => {
   const activeEl = document.activeElement;

   if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.code === "KeyZ")) {
    e.preventDefault();
    await executeUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y" || e.code === "KeyY" || (e.shiftKey && (e.key === "Z" || e.code === "KeyZ")))) {
    e.preventDefault();
    await executeRedo();
    return;
  }

  if (
    (!e.shiftKey && e.key === "F3") ||
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyF")
  ) {
    e.preventDefault();
    const searchEl = document.getElementById(`search-${activePane}`);
    if (searchEl) { searchEl.focus(); searchEl.select(); }
    return;
  }

  if (
    (e.shiftKey && e.key === "F3") ||
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyB")
  ) {
    e.preventDefault();
    const treeSearchEl = document.getElementById(`tree-search-${activePane}`);
    if (treeSearchEl) { treeSearchEl.focus(); treeSearchEl.select(); }
    return;
  }

  if (e.key === "F6" || e.key === "F7") {
    e.preventDefault();
    const _src = e.key === "F6" ? "left" : "right";
    const _tgt = _src === "left" ? "right" : "left";
    const _sp = panes[_src];
    const _tp = panes[_tgt];
    const _ids = Array.from(_sp.selection.results);
    if (_ids.length) {
      const _treeIdx = Array.from(_tp.selection.tree)[0];
      const _folderId = (_treeIdx !== undefined && flatFolders[_treeIdx])
        ? flatFolders[_treeIdx].id
        : _tp.currentFolderId;
      if (_folderId) await moveItems(_ids, _folderId, _src, _tgt);
    }
    return;
  }

  if (activeEl && activeEl.matches("input, textarea")) {
    if (e.key === "Escape") {
    } else {
      return;
    }
  }

 if (e.key === "Escape") {

  e.preventDefault();
  e.stopPropagation();

  const _ctxMenu = document.getElementById("context-menu");
  if (_ctxMenu && _ctxMenu.style.display !== "none" && _ctxMenu.style.display !== "") {
    hideContextMenu();
    return;
  }

  const focusedInput = document.activeElement;
  const isAnyInput = focusedInput && focusedInput.matches(
    "#search-left, #search-right, #tree-search-left, #tree-search-right"
  );
  const side = isAnyInput
    ? (focusedInput.id.includes("right") ? "right" : "left")
    : activePane;
  const pane = getPane(side);

  const hasVisibleSelection = [...pane.selection.results]
    .some(id => pane.currentResults.some(x => x.id === id));

  if (hasVisibleSelection) {
    pane.selection.results.clear();
    pane.anchor.results = null;
    pane.currentRowIndex = -1;
    renderVirtual(side);
    updateSelectionUI(side);
    updateStatus();
    return;
  }

  const searchInput = document.getElementById(`search-${side}`);
  const treeSearchInput = document.getElementById(`tree-search-${side}`);

  if (searchInput?.value) {
    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    pane.isSearchMode = false;
    setSearchMode(side, false);
    if (pane.currentFolderId) {
      const folder = flatFolders.find(f => f.id === pane.currentFolderId);
      if (folder) browseFolder({ id: folder.id, title: folder.title }, side);
      else { pane.currentResults = []; renderVirtual(side); }
    } else {
      pane.currentResults = [];
      renderVirtual(side);
    }
    updateSelectionUI(side);
    updateStatus();
    return;
  }

if (treeSearchInput?.value) {
    treeSearchInput.value = "";
    treeSearchInput.dispatchEvent(new Event("input", { bubbles: true }));

    if (pane.currentFolderId) {
        const idx = flatFolders.findIndex(f => String(f.id) === String(pane.currentFolderId));
        if (idx !== -1) {
            pane.selection.tree.clear();
            pane.selection.tree.add(idx);
            pane.tree.focused = idx;
            pane.tree.selected = idx;
            expandAndSelectInTree(pane.currentFolderId, side);
        }
    }

    const treeEl = document.getElementById(`tree-list-${side}`) 
                || document.getElementById(`folder-tree-${side}`);
    if (treeEl) treeEl.focus();

    return;
}

  if (isAnyInput) {
    focusedInput.blur();
    return;
  }

}

async function executeMove(hint) {
    const other = hint === "left" ? "right" : "left";

    let sourceSide, targetSide;

    if (panes[hint].selection.results.size > 0) {
        sourceSide = hint;
        targetSide = other;
    } else if (panes[other].selection.results.size > 0) {
        sourceSide = other;
        targetSide = hint;
    } else {
        return;
    }

    const sourcePane = panes[sourceSide];
    const targetPane = panes[targetSide];

    const ids = Array.from(sourcePane.selection.results);

    let targetFolderId = null;

    const selectedTreeIndex = Array.from(targetPane.selection.tree)[0];
    if (selectedTreeIndex !== undefined && flatFolders[selectedTreeIndex]) {
        targetFolderId = flatFolders[selectedTreeIndex].id;
    }
    else if (targetPane.currentFolderId) {
        targetFolderId = targetPane.currentFolderId;
    }

    if (targetFolderId) {
        await moveItems(ids, targetFolderId, sourceSide, targetSide);
    }
}

  document.getElementById("move-btn")?.addEventListener("click", () => executeMove(activePane));

  if (e.key === "F2") {
    e.preventDefault();
    document.querySelector(".tb-rename")?.click();
    return;
  }

  if (e.key === "Delete" && state.activePanel === "results") {
    e.preventDefault();
    await executeDelete(activePane);
    return;
  }

	if (e.key === "Backspace" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
	  e.preventDefault();
	  const pane = getPane(activePane);
	  if (pane.isSearchMode) {
		document.getElementById(`search-${activePane}`)?.focus();
	  } else if (pane.currentFolderId) {
		const folder = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
		if (folder?.parentId) {
		  const parent = flatFolders.find(f => String(f.id) === String(folder.parentId));
		  if (parent) { browseFolder({ id: parent.id, title: parent.title }, activePane); expandAndSelectInTree(parent.id, activePane); }
		} else {
		  setAllBookmarks(activePane);
		}
	  }
	  updateNavButtons(activePane);
	}

	if (e.altKey && e.key === "ArrowUp") {
	  e.preventDefault();
	  const pane = getPane(activePane);
	  if (pane.isSearchMode) {
		document.getElementById(`search-${activePane}`)?.focus();
	  } else if (pane.currentFolderId) {
		const folder = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
		if (folder?.parentId) {
		  const parent = flatFolders.find(f => String(f.id) === String(folder.parentId));
		  if (parent) { await browseFolder({ id: parent.id, title: parent.title }, activePane); expandAndSelectInTree(parent.id, activePane); }
		  else { setAllBookmarks(activePane); }
		} else {
		  setAllBookmarks(activePane);
		}
	  }
	  updateNavButtons(activePane);
	}

	if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
	  e.preventDefault();
	  const pane = getPane(activePane);
	  const dir = e.key === "ArrowLeft" ? -1 : 1;
	  const nextIdx = pane.historyIndex + dir;
	  if (nextIdx < 0 || nextIdx >= pane.history.length) return;
	  const folderId = pane.history[nextIdx];
	  pane.historyIndex = nextIdx;
	  _historyNavigating = true;
	  if (folderId === null) { setAllBookmarks(activePane); }
	  else {
		const folder = flatFolders.find(f => String(f.id) === String(folderId));
		if (folder) { await browseFolder({ id: folder.id, title: folder.title }, activePane); expandAndSelectInTree(folder.id, activePane); }
	  }
	  _historyNavigating = false;
	  updateNavButtons(activePane);
	  return;
	}

	if (state.activePanel === "tree") {
	  const pane = getPane(activePane);

	  if (e.key === "ArrowDown") {
		e.preventDefault();
		moveTree(1);
		return;
	  }

	  if (e.key === "ArrowUp") {
		e.preventDefault();
		moveTree(-1);
		return;
	  }

	  if (e.key === "Enter") {
		e.preventDefault();
		triggerDefaultAction("tree", pane.tree.focused);
		setActivePanel("results", activePane);
		return;
	  }

	if (e.key === "ArrowRight" || e.key === "+") {

	  e.preventDefault();

	  const isOpen =
		pane.tree.openMap.get(
		  pane.tree.focused
		);

	  if (!isOpen) {

		toggleFolder(
		  pane.tree.focused,
		  activePane
		);
	  }

	  return;
	}

	if (e.key === "ArrowLeft" || e.key === "-") {

	  e.preventDefault();

	  const isOpen =
		pane.tree.openMap.get(
		  pane.tree.focused
		);

	  if (isOpen) {

		toggleFolder(
		  pane.tree.focused,
		  activePane
		);
	  }

	  return;
	}

	  if (e.key === "Delete") {
		e.preventDefault();
		await executeDelete(activePane);
		return;
	  }

	  if (e.key === "Home" || e.key === "End") {
		e.preventDefault();
		function _isVisTree(i) { const vm = pane.tree.visibleMap; if (vm?.has(i)) return vm.get(i); return flatFolders[i]?.visible ?? false; }
		let target = -1;
		if (e.key === "Home") { for (let i = 0; i < flatFolders.length; i++) { if (_isVisTree(i)) { target = i; break; } } }
		else { for (let i = flatFolders.length - 1; i >= 0; i--) { if (_isVisTree(i)) { target = i; break; } } }
		if (target === -1) return;
		const prev2 = pane.tree.focused;
		pane.tree.focused = target; pane.selection.tree.clear(); pane.selection.tree.add(target); pane.tree.selected = target;
		updateTreeSelection(prev2, target, activePane);
		clearTimeout(moveTreeTimer);
		moveTreeTimer = setTimeout(() => { setActiveFolder(target, activePane); }, 300);
		requestAnimationFrame(() => { document.getElementById(`tree-${activePane}`)?.querySelector(`.folder-row[data-index="${target}"]`)?.scrollIntoView({ block: "nearest" }); });
		return;
	  }
	if (e.ctrlKey && !e.shiftKey && e.code === "KeyV") {
	  e.preventDefault();
	  if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;

	  const idx = Array.from(pane.selection.tree)[0];
	  const targetFolder = idx != null ? flatFolders[idx] : null;
	  if (!targetFolder) return;
	  const targetFolderId = String(targetFolder.id);

	  const movedIds = [];
	  const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
	  for (const item of ctxClipboard.items) {
		if (String(item.parentId) === targetFolderId) continue;
		try {
		  await browser.bookmarks.move(String(item.id), { parentId: targetFolderId });
		  movedIds.push(String(item.id));
		} catch (_) {}
	  }
	  if (movedIds.length) {
		undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: targetFolderId, sourceSide: activePane, targetSide: activePane, clipboardSnapshot: ctxClipboard.items.slice() });
	  }
	  ctxClipboard = null;
	  updatePasteButton();
	  await loadBookmarks();

	  const updatedFolder = flatFolders.find(f => String(f.id) === targetFolderId);
	  if (updatedFolder) await browseFolder({ id: updatedFolder.id, title: updatedFolder.title }, activePane);
	  return;
	}
	}

	if (state.activePanel === "results") {
	  const pane = getPane(activePane);
	  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		isKeyboardNavigating = true;
		pane._lastInteraction = "keyboard";

		const dir = e.key === "ArrowDown" ? 1 : -1;
		const next = pane.currentRowIndex + dir;

		if (pane.currentRowIndex === -1) {
			pane.currentRowIndex = 0;
			const item =
			pane.currentResults[pane.currentRowIndex];
			pane.selection.results.clear();

	    if (item) {
			pane.selection.results.add(String(item.id));
			pane.anchor.results = String(item.id);
		  }

		  renderVirtualInPlace(activePane);
		  ensureRowVisible(pane.currentRowIndex);
		  updateSelectionUI(activePane);
		  updateStatus();

		  requestAnimationFrame(() => {
			isKeyboardNavigating = false;
		  });

		  return;
		}

	    if (next < 0 || next >= pane.currentResults.length)
		   return;

	    if (e.ctrlKey && e.shiftKey) {
		const sel = pane.selection.results;
		const anchorId = pane.anchor.results;
		const anchorIndex = anchorId
		  ? pane.currentResults.findIndex(x => String(x.id) === String(anchorId))
		  : pane.currentRowIndex;
		const from = anchorIndex === -1 ? pane.currentRowIndex : anchorIndex;
		const start = Math.min(from, next);
		const end   = Math.max(from, next);

		for (let i = start; i <= end; i++) {
		  const it = pane.currentResults[i];
		  if (it) sel.add(String(it.id));
		}
		pane.currentRowIndex = next;

		ensureRowVisible(next);
		renderVirtualInPlace(activePane);
		updateSelectionUI(activePane);
		updateStatus();

		} else if (e.ctrlKey) {

		pane.currentRowIndex = next;

		ensureRowVisible(next);

		requestAnimationFrame(() => {
		  renderVirtualInPlace(activePane);
		  updateSelectionUI(activePane);
		});

		} else if (e.shiftKey) {

		selectIndex(next, {
		  shift: true,
		  panel: "results",
		});

		ensureRowVisible(next);

		requestAnimationFrame(() => {
		  renderVirtualInPlace(activePane);
		});

		} else {

		selectIndex(next, {
		  panel: "results",
		});

		ensureRowVisible(next);

		requestAnimationFrame(() => {
		  renderVirtualInPlace(activePane);
		});
	  }

	  requestAnimationFrame(() => {
		isKeyboardNavigating = false;
	  });

	  return;
}

      if (!e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Space") {
        e.preventDefault();
        const item = pane.currentResults[pane.currentRowIndex];
        if (item) {
          const id = String(item.id);
          if (pane.selection.results.has(id)) {
            pane.selection.results.delete(id);
          } else {
            pane.selection.results.add(id);
          }
          pane.anchor.results = id;
        }
        renderVirtualInPlace(activePane);
        updateSelectionUI(activePane);
        updateStatus();
        return;
      }

      if (e.ctrlKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        selectIndex(pane.currentRowIndex, {
          ctrl: true,
          shift: true,
          panel: "results"
        });
        return;
      } else if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        if (pane._lastInteraction === "mouse") {
          const item = pane.currentResults[pane.currentRowIndex];
          if (item) pane.anchor.results = String(item.id);
          renderVirtualInPlace(activePane);
          updateSelectionUI(activePane);
          updateStatus();
          return;
        }
        const item = pane.currentResults[pane.currentRowIndex];
        if (item) {
          const id = String(item.id);
          if (pane.selection.results.has(id)) {
            pane.selection.results.delete(id);
          } else {
            pane.selection.results.add(id);
          }
          pane.anchor.results = id;
        }
        renderVirtualInPlace(activePane);
        updateSelectionUI(activePane);
        updateStatus();
        return;
      } else if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        selectIndex(pane.currentRowIndex, {
          shift: true,
          panel: "results"
        });
        return;
      }

      if (e.ctrlKey && !e.shiftKey && (e.code === "KeyC" || e.code === "KeyX")) {
        e.preventDefault();
        const selIds = [...pane.selection.results];
        if (!selIds.length && pane.currentRowIndex >= 0) {
          const cur = pane.currentResults[pane.currentRowIndex];
          if (cur) selIds.push(String(cur.id));
        }
        const selItems = selIds.map(id => pane.currentResults.find(x => String(x.id) === id)).filter(Boolean);
if (selItems.length) {
  const op = e.code === "KeyX" ? "cut" : "copy";
  ctxClipboard = { items: selItems, op };
  if (op === "cut") renderVirtualInPlace(activePane);  // side → activePane
}
        return;
      }

      if (e.ctrlKey && !e.shiftKey && e.code === "KeyV") {
        e.preventDefault();
        if (!ctxClipboard?.items?.length || ctxClipboard.op !== "cut") return;
        const targetFolderId = pane.currentFolderId;
        if (!targetFolderId) return;
        const movedIds = [];
        const fromFolderId = ctxClipboard.items[0]?.parentId || pane.currentFolderId;
        for (const item of ctxClipboard.items) {
          if (String(item.parentId) === String(targetFolderId)) continue;
          try { await browser.bookmarks.move(String(item.id), { parentId: String(targetFolderId) }); movedIds.push(String(item.id)); } catch (_) {}
        }
        if (movedIds.length) undoPush({ type: "move", movedIds, fromFolderId: String(fromFolderId), toFolderId: String(targetFolderId), sourceSide: activePane, targetSide: activePane, clipboardSnapshot: ctxClipboard.items.slice() });
        ctxClipboard = null;
        updatePasteButton();
        await loadBookmarks();
        const folder = flatFolders.find(f => String(f.id) === String(targetFolderId));
        if (folder) await browseFolder({ id: folder.id, title: folder.title }, activePane);
        return;
      }

      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        if (!pane.currentResults.length) return;
        const target = e.key === "Home" ? 0 : pane.currentResults.length - 1;
        if (e.shiftKey) {
          const anchorId = pane.anchor.results;
          const anchorIdx = anchorId ? pane.currentResults.findIndex(x => String(x.id) === String(anchorId)) : pane.currentRowIndex;
          const from = anchorIdx === -1 ? 0 : anchorIdx;
          pane.selection.results.clear();
          for (let i = Math.min(from, target); i <= Math.max(from, target); i++) {
            const it = pane.currentResults[i]; if (it) pane.selection.results.add(String(it.id));
          }
          pane.currentRowIndex = target;
        } else if (e.ctrlKey) {
          pane.currentRowIndex = target;
        } else {
          selectIndex(target, { panel: "results" });
        }
        ensureRowVisible(target);
        renderVirtualInPlace(activePane); updateSelectionUI(activePane); updateStatus();
        return;
      }

      if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        if (!pane.currentResults.length) return;
        const container = document.querySelector(`#results-list-${activePane} .results-content`);
        const pageRows = container ? Math.max(1, Math.floor(container.clientHeight / ROW_HEIGHT) - 1) : 10;
        const dir = e.key === "PageDown" ? 1 : -1;
        const target = Math.max(0, Math.min(pane.currentResults.length - 1, pane.currentRowIndex + dir * pageRows));
        if (e.shiftKey) {
          const anchorId = pane.anchor.results;
          const anchorIdx = anchorId ? pane.currentResults.findIndex(x => String(x.id) === String(anchorId)) : pane.currentRowIndex;
          const from = anchorIdx === -1 ? pane.currentRowIndex : anchorIdx;
          pane.selection.results.clear();
          for (let i = Math.min(from, target); i <= Math.max(from, target); i++) {
            const it = pane.currentResults[i]; if (it) pane.selection.results.add(String(it.id));
          }
          pane.currentRowIndex = target;
        } else if (e.ctrlKey) {
          pane.currentRowIndex = target;
        } else {
          selectIndex(target, { panel: "results" });
        }
        ensureRowVisible(target);
        updateSelectionUI(activePane); updateStatus();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.code === "KeyA" && !e.shiftKey) {
        e.preventDefault();
        if (!pane.currentResults.length) return;
        pane.currentResults.forEach(item => pane.selection.results.add(String(item.id)));
        pane.anchor.results = String(pane.currentResults[0].id);
        pane.currentRowIndex = pane.currentResults.length - 1;
        renderVirtualInPlace(activePane); updateSelectionUI(activePane); updateStatus();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();

        const openMode = (e.ctrlKey || e.metaKey) ? "background" : e.shiftKey ? "window" : undefined;

        const ids = [...pane.selection.results];
        if (!ids.length && pane.currentRowIndex >= 0) {
          ids.push(String(pane.currentResults[pane.currentRowIndex]?.id));
        }

        const firstIndex = getPane(activePane).currentResults.findIndex(x => String(x.id) === String(ids[0]));
        const firstItem = getPane(activePane).currentResults[firstIndex];

        if (firstItem?.isFolder && !openMode) {
          triggerDefaultAction("results", firstIndex);
        } else {
          for (const id of ids) {
            const index = getPane(activePane).currentResults.findIndex(x => String(x.id) === String(id));
            if (index !== -1) triggerDefaultAction("results", index, openMode);
          }
        }
        return;
      }
    }

  });
}

let moveTreeTimer = null;

async function moveTree(dir) {
  const pane = getPane(activePane);

  let current = pane.tree.focused;
  if (current === null || current === undefined) {
    current = dir > 0 ? -1 : flatFolders.length;
  }

  let next = current + dir;

  function isVisible(i) {
    const vm = pane.tree.visibleMap;
    if (vm && vm.has(i)) return vm.get(i);
    return flatFolders[i]?.visible ?? false;
  }

  while (
    next >= 0 &&
    next < flatFolders.length &&
    !isVisible(next)
  ) {
    next += dir;
  }

  if (next < -1 || next >= flatFolders.length) return;

  if (next === -1) {
    clearTimeout(moveTreeTimer);
    moveTreeTimer = setTimeout(() => {
      setAllBookmarks(activePane);
    }, 300);
    const container = getTreeElement(activePane);
    const prevRow = container?.querySelector(`.folder-row[data-index="${pane.tree.focused}"]`);
    if (prevRow) prevRow.classList.remove("selected", "kb-focus");
    const allRow = container?.querySelector(`.folder-row[data-index="-1"]`);
    if (allRow) {
      allRow.classList.add("selected", "kb-focus");
      allRow.scrollIntoView({ block: "nearest" });
    }
    pane.tree.focused = -1;
    return;
  }

  const prevFocused = pane.tree.focused;

  pane.tree.focused = next;
  pane.selection.tree.clear();
  pane.selection.tree.add(next);
  pane.tree.selected = next;

  updateTreeSelection(prevFocused, next, activePane);

  clearTimeout(moveTreeTimer);
  moveTreeTimer = setTimeout(() => {
    setActiveFolder(next, activePane);
  }, 300);
}

function setSearchMode(side, active) {
  const listEl = document.getElementById(`results-list-${side}`);
  if (listEl) listEl.classList.toggle("search-mode", active);
  requestAnimationFrame(() => window._rescaleColumns?.(side));
}

function setupSearch(side) {

  const input =
    document.getElementById(`search-${side}`);
  if (!input) return;
  input.addEventListener("focus", () => {
    setActivePanel("results", side);
  });
  let _searchDebounce = null;
  input.addEventListener("input", () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
    const pane = panes[side];
    const val =
      normalizeText(input.value.trim());
    pane.tree.searchQuery = val;
    if (!val) {
      pane.isSearchMode = false;
      if (pane.currentFolderId === null) {
        setSearchMode(side, false);
        const topFolders = flatFolders
          .filter(f => f.depth === 0)
          .map(f => ({
            id: f.id, title: f.title, isFolder: true,
            parentId: f.parentId, fullPath: f.title,
            full: (f.title || "").toLowerCase()
          }));
        pane.baseResults = topFolders;
        pane.currentResults = topFolders.slice();
      } else {
        setSearchMode(side, false);
        pane.currentResults = pane.baseResults.slice();
      }

	const stillVisible =
	  [...pane.selection.results]
		.filter(id =>
		  pane.currentResults.some(
			x => x.id === id
		  )
		);

	pane.selection.results.clear();

	for (const id of stillVisible) {
	  pane.selection.results.add(id);
	}

      renderSearchResults(side);

      return;
    }

    pane.isSearchMode = true;

    if (pane.currentFolderId === null) {
      setSearchMode(side, true);
      pane.currentResults = flatAllBookmarks.filter(bm => bm.full.includes(val));
    } else {
      setSearchMode(side, true);
      const folderObj = flatFolders.find(f => String(f.id) === String(pane.currentFolderId));
      const folderChildren = folderObj?.children || [];
      const rootFullPath = getFullFolderPath({ parentId: folderObj?.parentId })
        ? getFullFolderPath({ parentId: folderObj?.parentId }) + "\\" + (folderObj?.title || "")
        : (folderObj?.title || "");
      const allLocal = collectFolderBookmarksFrom(folderChildren, pane.currentFolderId, [], "", rootFullPath);
      pane.currentResults = allLocal.filter(bm => bm.full.includes(val));
    }

    renderSearchResults(side);
    }, 150);
  });
}

function getTreeSearchInput(side = activePane) {
  return document.getElementById(
    side === "left"
      ? "tree-search-left"
      : "tree-search-right"
  );
}

function renderSearchResults(side) {
  const pane = getPane(side);
  sortResults(side);
  pane.selection.results.clear();
  pane.anchor.results = null;
if (!pane.currentResults.length) {
  pane.currentRowIndex = -1;
}
  renderVirtual(side);
  requestAnimationFrame(() => {
    updateSelectionUI(side);
    updateStatus();
  });
}

function sortResults(side = activePane) {
  const pane = getPane(side);
  const col = pane.sort?.col || "title";
  const asc = pane.sort?.asc ?? true;
  const folderId = pane.currentFolderId || "__root__";
  const cacheKey = `${folderId}|${col}|${asc}`;

  if (!pane.isSearchMode && _sortCache.has(cacheKey)) {
    pane.currentResults = _sortCache.get(cacheKey).slice();
    return;
  }

  const sortChain = [
    { key: col, asc },
    { key: "title", asc: true },
    { key: "dateAdded", asc: false },
    { key: "id", asc: true }
  ];

  pane.currentResults.sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    for (const rule of sortChain) {
      const res = compareValues(a[rule.key], b[rule.key], rule.asc, rule.key);
      if (res !== 0) return res;
    }
    return 0;
  });

  if (!pane.isSearchMode) {
    _sortCache.set(cacheKey, pane.currentResults.slice());
  }
}

function _applyRenameToPane(s, itemId, newTitle) {
  const p = panes[s];
  for (const arr of [p.currentResults, p.baseResults]) {
    const r = arr.find(x => String(x.id) === String(itemId));
    if (r) { r.title = newTitle; r.full = newTitle.toLowerCase(); }
  }
  _sortCache.clear();
  sortResults(s);
  const newIdx = p.currentResults.findIndex(x => String(x.id) === String(itemId));
  if (newIdx !== -1) {
    if (p.selection.results.has(String(itemId)) || p.currentRowIndex !== -1) {
      p.currentRowIndex = newIdx;
    }
  }
  renderVirtualInPlace(s);
  if (newIdx !== -1) {
    ensureRowVisible(newIdx, s);
  }
}

const _vsState = {
  left:  { startIdx: 0, endIdx: 0, scrollTop: 0 },
  right: { startIdx: 0, endIdx: 0, scrollTop: 0 }
};

function _hlText(text, query) {
  if (!query || !text) return escapeHtml(text || "");
  const escaped = escapeHtml(text);
  const safeQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${safeQ})`, 'gi'), '<mark class="hl">$1</mark>');
}

function _buildRow(bm, i, pane, side) {
  const searchQ = (side && pane.isSearchMode)
    ? (document.getElementById(`search-${side}`)?.value || "")
    : "";

	const selected = pane.selection.results.has(String(bm.id));
	const focused  = i === pane.currentRowIndex;
	const isCut = selected && ctxClipboard?.op === "cut" && ctxClipboard.items.some(ci => String(ci.id) === String(bm.id));
	const cls = "row" + (selected ? " selected" : "") + (focused ? " kb-focus" : "") + (isCut ? " cut-pending" : "");
  const date = bm.dateAdded ? new Date(bm.dateAdded).toLocaleDateString() : "";

  const titleHtml = _hlText(bm.title || "", searchQ);

  const _rawPath = bm.fullPath || getFullFolderPath(bm);
  const _displayPath = _rawPath;
  const pathHtml  = _hlText(_displayPath, searchQ);
  const urlHtml   = _hlText(normalizeUrl(bm.url || ""), searchQ);

  const iconHtml = bm.isFolder
    ? `📁`
    : `<svg width="13" height="14" viewBox="0 0 11 13" fill="none" xmlns="http://www.w3.org/2000/svg"> style="opacity:.5;flex-shrink:0;">
        <path d="M2 1h5.5L10 3.5V12H2V1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M7 1v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>`;

  const _isRootRow = pane.currentFolderId === null && !pane.isSearchMode && bm.isFolder &&
    (() => { const ff = flatFolders.find(f => String(f.id) === String(bm.id)); return ff && ff.depth === 0; })();

  const _ff = bm.isFolder ? flatFolders.find(f => String(f.id) === String(bm.id)) : null;
  const countBadge = _ff != null ? `<span class="folder-count-badge">${_ff.childCount}</span>` : "";

  return `<div class="${cls}" data-id="${bm.id}" data-index="${i}" draggable="${_isRootRow ? 'false' : 'true'}" style="position:relative;top:auto;">
<div class="cell title"><span class="item-icon">${iconHtml}</span><span class="item-title">${titleHtml}</span>${countBadge}</div>
<div class="cell path">${pathHtml}</div>
<div class="cell url">${urlHtml}</div>
<div class="cell date">${date}</div>
</div>`;
}

function _renderVirtualWindow(side, scrollTop) {
  const pane = panes[side];
  const currentResults = pane.currentResults || [];
  const total = currentResults.length;

  const contentEl = document.querySelector(`#results-list-${side} .results-content`);
  const visibleEl = contentEl?.querySelector(".visible-items");
  const spacerEl  = contentEl?.querySelector(".spacer");
  if (!visibleEl || !spacerEl) return;

  const viewH    = contentEl.clientHeight || 600;
  const BUFFER_ROWS = 20;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const endIdx   = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + BUFFER_ROWS);

  const vs = _vsState[side];

const version = pane.renderVersion || 0;

  if (vs.startIdx === startIdx && vs.endIdx === endIdx && visibleEl.children.length > 0) {
    return;
  }
  vs.startIdx = startIdx;
  vs.endIdx   = endIdx;

vs.version = version;

  spacerEl.style.height = (total * ROW_HEIGHT) + "px";

  if (total === 0 && pane.isSearchMode) {
    const searchVal = document.getElementById(`search-${side}`)?.value || "";
    spacerEl.style.height = "0px";
    visibleEl.style.transform = "";
    const folderName = pane.currentFolderId
      ? (flatFolders.find(f => String(f.id) === String(pane.currentFolderId))?.title || "")
      : "All Bookmarks";
    const inFolder = !!folderName;
    visibleEl.textContent = "";
    const _noResDiv = document.createElement("div");
    _noResDiv.className = "no-results-msg";
    const _strong = document.createElement("strong");
    _strong.textContent = searchVal;
    _noResDiv.append('No results for "', _strong, '"');
    if (inFolder) {
      const _inFolderDiv = document.createElement("div");
      _inFolderDiv.style.cssText = "margin-top:4px;opacity:1;";
      _inFolderDiv.textContent = `in "${folderName}"`;
      _noResDiv.appendChild(_inFolderDiv);
    }
    visibleEl.appendChild(_noResDiv);
    vs.startIdx = startIdx;
    vs.endIdx   = endIdx;
    return;
  }

  let html = "";
  for (let i = startIdx; i < endIdx; i++) {
    const bm = currentResults[i];
    if (!bm) continue;
    html += _buildRow(bm, i, pane, side);
  }

  const _rowsDoc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  visibleEl.replaceChildren(..._rowsDoc.body.firstChild.childNodes);
  visibleEl.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;
  updateSelectionUI(side);
}

(function setupVirtualScrollListeners() {
  ["left", "right"].forEach(side => {
    const listEl = document.querySelector(`#results-list-${side} .results-content`);
    if (!listEl) return;
    listEl.addEventListener("scroll", () => {
      _renderVirtualWindow(side, listEl.scrollTop);
    }, { passive: true });
  });
})();

function renderVirtual(side = activePane) {
  const listEl = document.querySelector(`#results-list-${side} .results-content`);
  _vsState[side].startIdx = -1;
  _vsState[side].endIdx   = -1;
  if (listEl) listEl.scrollTop = 0;
  _renderVirtualWindow(side, 0);
}

function renderVirtualInPlace(side = activePane) {
  const listEl = document.querySelector(`#results-list-${side} .results-content`);
  _vsState[side].startIdx = -1;
  _vsState[side].endIdx   = -1;
  const scrollTop = listEl ? listEl.scrollTop : 0;
  _renderVirtualWindow(side, scrollTop);
}

const btn = document.getElementById("stat-right");
const overlay = document.getElementById("about-overlay");
const closeBtn = document.getElementById("close-about");

if (btn && overlay) {
  btn.onclick = () => {
    overlay.style.display = "flex";
    requestAnimationFrame(() => window.updateSelectionUI && window.updateSelectionUI(activePane));
  };
}

if (closeBtn && overlay) {
  closeBtn.onclick = () => {
    overlay.style.display = "none";
    requestAnimationFrame(() => window.updateSelectionUI && window.updateSelectionUI(activePane));
  };
}

(function setupColumnResize() {

  const widths = {
    left:  { name: 240, path: 180, url: 120 },
    right: { name: 240, path: 180, url: 120 }
  };

  const nameRatio = { left: null, right: null };
  const pathRatio = { left: null, right: null };

  function isSearchModeActive(side) {
    const root = document.getElementById(`results-list-${side}`);
    return root ? root.classList.contains("search-mode") : false;
  }

  function getResultsPanelWidth(side) {
    const paneEl = document.getElementById(`pane-${side}`);
    const treeEl = paneEl?.querySelector(".tree-panel");
    if (!paneEl || !treeEl) return null;
    const paneW = paneEl.getBoundingClientRect().width;
    const treeW = treeEl.getBoundingClientRect().width;
    return paneW - treeW - 20 - 6 - 1;
  }

  function rescale(side) {
    const availW = getResultsPanelWidth(side);
    if (!availW || availW <= 0) return;

    if (isSearchModeActive(side)) {
      const colW = Math.max(0, availW - 85);
      widths[side].name = Math.max(40, Math.round(colW * 0.46));
      widths[side].path = Math.max(40, Math.round(colW * 0.32));
      widths[side].url  = Math.max(40, Math.round(colW * 0.22));
      nameRatio[side] = null;
      pathRatio[side] = null;
    } else {
      if (nameRatio[side] === null) {
        nameRatio[side] = widths[side].name / availW;
      }
      widths[side].name = Math.max(40, Math.round(availW * nameRatio[side]));
    }

    apply(side);
  }

  const leftNeighbor = {
    path: "name",
    url:  "name",   
    date: "url"     
  };

  function apply(side) {
    const root = document.getElementById(`results-list-${side}`);
    if (!root) return;
    const w = widths[side];
    root.style.setProperty("--col-name", w.name + "px");
    root.style.setProperty("--col-path", w.path + "px");
    root.style.setProperty("--col-url",  w.url  + "px");
  }

  requestAnimationFrame(() => {
    ["left", "right"].forEach(side => {
      apply(side);
      const paneEl = document.getElementById(`pane-${side}`);
      if (!paneEl) return;
      const ro = new ResizeObserver(() => rescale(side));
      ro.observe(paneEl);
    });
  });

  window._rescaleColumns = rescale;

  document.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".col-resize-handle");
    if (!handle) return;

    e.preventDefault();
    e.stopPropagation();

    const side  = handle.dataset.pane;
    const col   = handle.dataset.col;   
    const edge  = handle.dataset.edge;  

    const root = document.getElementById(`results-list-${side}`);
    if (!root) return;

    const isSearchMode = root.classList.contains("search-mode");
    let targetCol = col;
    if (edge === "left") {
      if (col === "url" && isSearchMode) {
        targetCol = "path";
      } else {
        targetCol = leftNeighbor[col];
      }
    }
    if (!targetCol || !(targetCol in widths[side])) return;

    const startX = e.clientX;
    const startWidth = widths[side][targetCol];

    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";

    function move(ev) {
      const dx = ev.clientX - startX;
      widths[side][targetCol] = Math.max(0, startWidth + dx);
      apply(side);
    }

    function up() {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (targetCol === "name") {
        const availW = getResultsPanelWidth(side);
        if (availW > 0) nameRatio[side] = widths[side].name / availW;
      }
      if (targetCol === "path") {
        const availW = getResultsPanelWidth(side);
        if (availW > 0) pathRatio[side] = widths[side].path / availW;
      }
    }

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);

  });
})();

function setupPaneResize() {
  const resizer =
    document.getElementById("panel-resizer");
  const workspace =
    document.getElementById("workspace");

  if (!resizer || !workspace) return;
  let splitRatio = 0.5;
  function applyRatio() {
    const total = workspace.getBoundingClientRect().width - 6;
    const left = Math.round(total * splitRatio);
    const right = total - left;
    workspace.style.setProperty("--left-pane",  left  + "px");
    workspace.style.setProperty("--right-pane", right + "px");
  }
  window.addEventListener("resize", () => {
    applyRatio();
  });
  resizer.addEventListener(
    "mousedown",
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const workspaceRect = workspace.getBoundingClientRect();
      const total = workspaceRect.width - 6;
      const leftPane = document.getElementById("pane-left");
      const startLeft = leftPane.getBoundingClientRect().width;
      resizer.classList.add("dragging");

      function move(ev) {
        const dx = ev.clientX - startX;
        const min = 0;
        let left = startLeft + dx;
        left = Math.max(min, left);
        left = Math.min(total - min, left);
        splitRatio = left / total;
        workspace.style.setProperty("--left-pane",  left + "px");
        workspace.style.setProperty("--right-pane", (total - left) + "px");
      }

      function up() {
        resizer.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup",   up);
      }

      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup",   up);
    }
  );
}

setupPaneResize();

function setupInnerPaneResize() {
  document
    .querySelectorAll(".pane-splitter")
    .forEach(splitter => {
      splitter.addEventListener(
        "mousedown",
        (e) => {
          e.preventDefault();
          const pane =
            splitter.closest(".pane");
          if (!pane) return;
          const startX =
            e.clientX;
          const startTree =
            pane.querySelector(".tree-panel")
                .getBoundingClientRect()
                .width;
          const paneWidth =
            pane.getBoundingClientRect()
                .width;
          splitter.classList.add("dragging");
          
		  function move(ev) {
            const dx =
              ev.clientX - startX;
            let treeWidth =
              startTree + dx;
            const minTree = 0;
            const minResults = 0;
            treeWidth = Math.max(minTree, treeWidth);
            treeWidth = Math.min(paneWidth - minResults - 6, treeWidth);
            pane.style.setProperty(
              "--tree-width",
              treeWidth + "px"
            );
          }

          function up() {
            splitter.classList.remove(
              "dragging"
            );
            document.removeEventListener(
              "mousemove",
              move
            );
            document.removeEventListener(
              "mouseup",
              up
            );
          }
          document.addEventListener(
            "mousemove",
            move
          );
          document.addEventListener(
            "mouseup",
            up
          );
        }
      );
    });
}

setupInnerPaneResize();
(function() {
  const movePopup  = document.getElementById("move-popup");
  const btnLeft    = document.getElementById("move-popup-left");
  const btnRight   = document.getElementById("move-popup-right");
  const SZ_W = 28;
  const SZ_H = 28;
  const SZ_GAP = 4;
  const TOTAL_H = SZ_H * 2 + SZ_GAP;
  let _visible = false;
  let _hideTimeout = null;
  let _pinnedPos = null;

  function calcAutoPos() {
    const resizer = document.getElementById("panel-resizer");
    if (resizer) {
      const r = resizer.getBoundingClientRect();
      return {
        left: r.left + (r.width  - SZ_W) / 2,
        top:  r.top  + (r.height - TOTAL_H) / 2
      };
    }
    return {
      left: window.innerWidth  / 2 - SZ_W / 2,
      top:  window.innerHeight / 2 - TOTAL_H / 2
    };
  }

  function clamp(pos) {
    return {
      left: Math.max(4, Math.min(pos.left, window.innerWidth  - SZ_W - 4)),
      top:  Math.max(4, Math.min(pos.top,  window.innerHeight - TOTAL_H - 4))
    };
  }

  function position() {
    if (!movePopup) return;
    const pos = clamp(_pinnedPos || calcAutoPos());
    movePopup.style.left = pos.left + "px";
    movePopup.style.top  = pos.top  + "px";
  }

  function canMove(sourceSide) {
    const p = panes[sourceSide];
    if (!p || p.selection.results.size === 0) return false;

    const targetSide = sourceSide === "left" ? "right" : "left";
    const targetPane = panes[targetSide];

    const selIds = Array.from(p.selection.results);
    const rootSelected = p.currentFolderId === null && !p.isSearchMode && selIds.some(id => {
      const ff = flatFolders.find(f => String(f.id) === String(id));
      return ff && ff.depth === 0;
    });
    if (rootSelected) return false;
    if (!targetPane || targetPane.currentFolderId === null) return false;

    const items = selIds.map(id => p.currentResults.find(x => String(x.id) === String(id))).filter(Boolean);
    if (items.length && items.every(item => String(item.parentId) === String(targetPane.currentFolderId))) return false;

    if (items.length) {
      const targetFolderId = String(targetPane.currentFolderId);
      const folderItems = items.filter(item => item.isFolder);
      if (folderItems.some(item => String(item.id) === targetFolderId)) return false;
    }

    if (selIds.length && targetPane.currentFolderId) {
      const targetFolderNode = flatFolders.find(f => String(f.id) === String(targetPane.currentFolderId));
      if (targetFolderNode) {
        const folderSelIds = selIds.filter(id => {
          const item = p.currentResults.find(x => String(x.id) === String(id));
          return item && item.isFolder;
        });
        let ancestor = targetFolderNode;
        while (ancestor) {
          if (folderSelIds.includes(String(ancestor.id))) return false;
          ancestor = ancestor.parentId ? flatFolders.find(f => String(f.id) === String(ancestor.parentId)) : null;
        }
      }
    }
    return true;
  }

  function doMove(sourceSide) {
    const targetSide = sourceSide === "left" ? "right" : "left";
    const sourcePane = panes[sourceSide];
    const targetPane = panes[targetSide];
    const selIds = Array.from(sourcePane.selection.results);
    const selectedTreeIndex = Array.from(targetPane.selection.tree)[0];
    let targetFolderId = targetPane.currentFolderId;
    if (selectedTreeIndex !== undefined) {
      targetFolderId = flatFolders[selectedTreeIndex].id;
    }
    if (!targetFolderId) return;
    moveItems(selIds, targetFolderId, sourceSide, targetSide);
  }

  function update() {
    if (!movePopup) return;

    const aboutOverlay = document.getElementById("about-overlay");
    const aboutOpen = aboutOverlay && aboutOverlay.style.display === "flex";

    const leftOk  = !aboutOpen && canMove("left");
    const rightOk = !aboutOpen && canMove("right");

    if (btnLeft)  btnLeft.disabled  = !leftOk;
    if (btnRight) btnRight.disabled = !rightOk;

    if (leftOk || rightOk) {
      show();
    } else {
      hide();
    }
  }

  function show() {
    if (_hideTimeout) { clearTimeout(_hideTimeout); _hideTimeout = null; }
    movePopup.style.display = "flex";
    movePopup.offsetHeight;
    movePopup.classList.add("visible");
    _visible = true;
    requestAnimationFrame(() => requestAnimationFrame(() => position()));
  }

  function hide() {
    if (!_visible) return;
    movePopup.classList.remove("visible");
    _visible = false;
    _hideTimeout = setTimeout(() => { movePopup.style.display = "none"; _hideTimeout = null; }, 180);
  }

  function addDragSupport(btn) {
    let _wasDragged = false;
    btn.addEventListener("click", (e) => {
      if (_wasDragged) { _wasDragged = false; e.stopImmediatePropagation(); }
    }, true);
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;
      const popRect = movePopup.getBoundingClientRect();
      const startPopLeft = popRect.left;
      const startPopTop  = popRect.top;
      let moved = false;

      function onMove(ev) {
        const dx = ev.clientX - startMouseX;
        const dy = ev.clientY - startMouseY;
        if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        moved = true;
        movePopup.classList.add("dragging");
        _pinnedPos = { left: startPopLeft + dx, top: startPopTop + dy };
        const clamped = clamp(_pinnedPos);
        movePopup.style.left = clamped.left + "px";
        movePopup.style.top  = clamped.top  + "px";
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        movePopup.classList.remove("dragging");
        if (moved) _wasDragged = true;
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
    return () => _wasDragged;
  }

  const isLeftDragged  = addDragSupport(btnLeft);
  const isRightDragged = addDragSupport(btnRight);

  if (btnLeft) btnLeft.addEventListener("click", () => {
    if (isLeftDragged()) return;
    doMove("left");
  });
  if (btnRight) btnRight.addEventListener("click", () => {
    if (isRightDragged()) return;
    doMove("right");
  });

  const _origUpdate = window.updateSelectionUI;
  window.updateSelectionUI = function(side) {
    if (_origUpdate) _origUpdate.apply(this, arguments);
    requestAnimationFrame(() => update());
  };

  ["left","right"].forEach(s => {
    const rc = document.getElementById(`results-list-${s}`);
    if (rc) rc.addEventListener("scroll", () => { if (_visible) position(); }, { passive: true });
  });
  document.getElementById("workspace")?.addEventListener("scroll", () => { if (_visible) position(); }, { passive: true, capture: true });
  window.addEventListener("resize", () => { if (_visible) position(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && _visible) requestAnimationFrame(() => update()); });
})();

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "y" || e.key === "Y" || e.code === "KeyY")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    document.getElementById("tb-redo")?.click();
    return;
  }
}, true);

["left", "right"].forEach(side => {
  const btn = document.getElementById(`reload-${side}`);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const svg = btn.querySelector("svg");
    if (svg) {
      svg.style.transition = "transform 0.4s ease";
      svg.style.transform  = "rotate(360deg)";
      setTimeout(() => {
        svg.style.transition = "none";
        svg.style.transform  = "";
      }, 420);
    }
    await loadBookmarks();
    const pane = panes[side];
    if (pane.isSearchMode) {
      const inp = document.getElementById(`search-${side}`);
      if (inp) inp.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (pane.currentFolderId) {
      const f = flatFolders.find(x => String(x.id) === String(pane.currentFolderId));
      if (f) await browseFolder({ id: f.id, title: f.title }, side);
      else renderVirtual(side);
    } else {
      setAllBookmarks(side);
    }
  });
});