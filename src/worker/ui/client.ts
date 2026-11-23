export const CLIENT_SCRIPT = `
(() => {
  const TOKEN_KEY = "firn_admin_token";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function setAdminUi(unlocked) {
    document.querySelectorAll(".admin-only").forEach((el) => {
      el.hidden = !unlocked;
    });
    const toggleBtn = document.getElementById("admin-toggle-btn");
    const loginForm = document.getElementById("admin-login-form");
    const activeControls = document.getElementById("admin-active-controls");
    if (toggleBtn) {
      toggleBtn.hidden = unlocked;
      toggleBtn.setAttribute("aria-expanded", "false");
    }
    if (loginForm) loginForm.hidden = true;
    if (activeControls) activeControls.hidden = !unlocked;
  }

  function showNotice(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !text;
    el.textContent = text;
    el.className = "notice" + (kind ? " " + kind : "");
  }

  function formatBytes(bytes) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i + 1 < units.length) {
      v /= 1024;
      i += 1;
    }
    return i === 0 ? bytes + " B" : v.toFixed(2) + " " + units[i];
  }

  function formatAge(ts) {
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (delta < 60) return delta + "s ago";
    if (delta < 3600) return Math.floor(delta / 60) + "m ago";
    if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
    return Math.floor(delta / 86400) + "d ago";
  }

  function splitStorePath(storePath) {
    const base = storePath.startsWith("/nix/store/") ? storePath.slice(11) : storePath;
    if (base.length > 33 && base[32] === "-") {
      return { hash: base.slice(0, 32), name: base.slice(33) };
    }
    return { hash: "", name: base };
  }

  function parsePrScope(scope) {
    const match = /^pr:([^:]+):([^:]+):(\\d+)$/.exec(scope);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: match[3] };
  }

  function extLink(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    return a;
  }

  // Copy buttons
  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-copy]");
    if (!btn) return;
    const text = btn.getAttribute("data-copy") || "";
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = prev === prev.toLowerCase() ? "copied" : "Copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      btn.textContent = "failed";
    }
  });

  // Snippet tabs + shared Copy button
  const snippetCopyBtn = document.getElementById("snippet-copy-btn");
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-btn").forEach((other) => {
        other.setAttribute("aria-selected", String(other === btn));
      });
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        const active = panel.getAttribute("data-panel") === target;
        panel.hidden = !active;
        if (active && snippetCopyBtn) {
          snippetCopyBtn.setAttribute(
            "data-copy",
            panel.getAttribute("data-snippet") || "",
          );
        }
      });
    });
  });

  // Live store paths filter & sort
  const searchInput = document.getElementById("filter-q");
  const ownerSelect = document.getElementById("filter-owner");
  const scopeSelect = document.getElementById("filter-scope");
  const limitSelect = document.getElementById("filter-limit");
  const deleteMatchingBtn = document.getElementById("delete-matching-btn");
  const sortButtons = document.querySelectorAll(".sort-btn[data-sort]");
  const pathsBody = document.getElementById("paths-body");
  const pathsStatus = document.getElementById("paths-status");

  let currentSort = "accessed";
  let filterTimer = null;
  let activeController = null;

  function syncDeleteMatchingState() {
    if (!deleteMatchingBtn) return;
    const hasFilter = Boolean(
      searchInput.value.trim() || ownerSelect.value || scopeSelect.value,
    );
    deleteMatchingBtn.disabled = !hasFilter;
    if (!hasFilter && deleteMatchingBtn.getAttribute("data-armed") === "true") {
      deleteMatchingBtn.removeAttribute("data-armed");
      deleteMatchingBtn.textContent = "Delete matching";
    }
  }

  async function refreshPaths() {
    if (activeController) activeController.abort();
    activeController = new AbortController();

    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
    if (ownerSelect.value) params.set("owner", ownerSelect.value);
    if (scopeSelect.value) params.set("scope", scopeSelect.value);
    if (limitSelect.value) params.set("limit", limitSelect.value);
    params.set("sort", currentSort);

    pathsStatus.textContent = "loading…";
    showNotice("paths-error", "", "");

    try {
      const res = await fetch("/api/v1/public/paths?" + params.toString(), {
        signal: activeController.signal,
      });
      if (!res.ok) throw new Error("Failed to load paths (" + res.status + ")");
      const items = await res.json();

      pathsBody.replaceChildren();
      if (items.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.className = "empty-cell";
        td.textContent = "No matching store paths.";
        tr.appendChild(td);
        pathsBody.appendChild(tr);
      } else {
        for (const item of items) {
          const tr = document.createElement("tr");
          const parts = splitStorePath(item.store_path);
          const prScope = parsePrScope(item.scope);

          const tdPath = document.createElement("td");
          const wrap = document.createElement("div");
          wrap.className = "path-cell";
          const link = document.createElement("a");
          link.className = "path-text mono";
          link.href = prScope
            ? "/pr/" + encodeURIComponent(prScope.owner) + "/" + encodeURIComponent(prScope.repo) + "/" + prScope.number + "/" + parts.hash + ".narinfo"
            : "/" + parts.hash + ".narinfo";
          link.title = item.store_path + " (open .narinfo)";
          const h = document.createElement("span");
          h.className = "hash-prefix";
          h.textContent = parts.hash.slice(0, 8) + "…-";
          const n = document.createElement("span");
          n.className = "pkg-name";
          n.textContent = parts.name;
          link.append(h, n);
          const actions = document.createElement("span");
          actions.className = "path-actions";
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "link-btn row-action";
          copyBtn.textContent = "copy";
          copyBtn.setAttribute("data-copy", item.store_path);
          actions.append(copyBtn);
          if (deleteMatchingBtn) {
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "link-btn danger row-action admin-only";
            removeBtn.hidden = !getToken();
            removeBtn.textContent = "remove";
            removeBtn.setAttribute("data-delete-path", item.scope + "\\t" + parts.hash);
            actions.append(removeBtn);
          }
          wrap.append(link, actions);
          tdPath.appendChild(wrap);

          const tdScope = document.createElement("td");
          tdScope.className = "mono muted";
          const label = document.createElement("span");
          label.className = "scope-label";
          label.title = item.scope;
          const dot = document.createElement("span");
          dot.className = "dot " + (item.scope === "main" ? "main" : "pr");
          dot.setAttribute("aria-hidden", "true");
          let scopeNode;
          if (prScope) {
            scopeNode = extLink(
              "https://github.com/" + encodeURIComponent(prScope.owner) + "/" + encodeURIComponent(prScope.repo) + "/pull/" + prScope.number,
              item.scope,
            );
            scopeNode.className = "scope-text";
          } else {
            scopeNode = document.createElement("span");
            scopeNode.className = "scope-text";
            scopeNode.textContent = item.scope;
          }
          label.append(dot, scopeNode);
          tdScope.appendChild(label);

          const tdOwner = document.createElement("td");
          tdOwner.className = "mono muted";
          tdOwner.appendChild(
            extLink("https://github.com/" + encodeURIComponent(item.owner_id), item.owner_id),
          );

          const tdSize = document.createElement("td");
          tdSize.className = "num mono";
          tdSize.textContent = formatBytes(item.file_size);

          const tdAge = document.createElement("td");
          tdAge.className = "num muted";
          tdAge.title = new Date(item.last_accessed_at * 1000).toISOString();
          tdAge.textContent = formatAge(item.last_accessed_at);

          tr.append(tdPath, tdScope, tdOwner, tdSize, tdAge);
          pathsBody.appendChild(tr);
        }
      }
      pathsStatus.textContent = items.length + " shown";
    } catch (error) {
      if (error && error.name === "AbortError") return;
      pathsStatus.textContent = "";
      showNotice("paths-error", error instanceof Error ? error.message : String(error), "error");
    }
  }

  searchInput.addEventListener("input", () => {
    syncDeleteMatchingState();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refreshPaths, 180);
  });
  [ownerSelect, scopeSelect, limitSelect].forEach((el) => {
    el.addEventListener("change", () => {
      syncDeleteMatchingState();
      refreshPaths();
    });
  });
  syncDeleteMatchingState();

  if (deleteMatchingBtn) {
    deleteMatchingBtn.addEventListener("click", async () => {
      if (deleteMatchingBtn.getAttribute("data-armed") !== "true") {
        deleteMatchingBtn.setAttribute("data-armed", "true");
        deleteMatchingBtn.textContent = "Confirm delete?";
        setTimeout(() => {
          if (deleteMatchingBtn.getAttribute("data-armed") === "true") {
            deleteMatchingBtn.removeAttribute("data-armed");
            deleteMatchingBtn.textContent = "Delete matching";
          }
        }, 4000);
        return;
      }

      const token = getToken();
      if (!token) return;
      const params = new URLSearchParams();
      if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
      if (ownerSelect.value) params.set("owner", ownerSelect.value);
      if (scopeSelect.value) params.set("scope", scopeSelect.value);

      deleteMatchingBtn.disabled = true;
      deleteMatchingBtn.removeAttribute("data-armed");
      deleteMatchingBtn.textContent = "Deleting…";
      try {
        const res = await fetch("/api/v1/admin/paths?" + params.toString(), {
          method: "DELETE",
          headers: { Authorization: "Bearer " + token },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        showNotice(
          "admin-notice",
          "Removed " + data.removed + " store paths. Run GC to delete unreferenced GHCR blobs.",
          "ok",
        );
        refreshPaths();
      } catch (error) {
        showNotice("admin-notice", error instanceof Error ? error.message : String(error), "error");
      } finally {
        deleteMatchingBtn.textContent = "Delete matching";
        syncDeleteMatchingState();
      }
    });
  }

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-delete-path]");
    if (!btn) return;
    if (btn.getAttribute("data-armed") !== "true") {
      btn.setAttribute("data-armed", "true");
      btn.textContent = "confirm?";
      setTimeout(() => {
        if (btn.isConnected && btn.getAttribute("data-armed") === "true") {
          btn.removeAttribute("data-armed");
          btn.textContent = "remove";
        }
      }, 4000);
      return;
    }

    const token = getToken();
    if (!token) return;
    const raw = btn.getAttribute("data-delete-path") || "";
    const sep = raw.indexOf("\\t");
    const scope = raw.slice(0, sep);
    const hash = raw.slice(sep + 1);
    btn.disabled = true;
    try {
      const params = new URLSearchParams({ scope, hash });
      const res = await fetch("/api/v1/admin/paths?" + params.toString(), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const row = btn.closest("tr");
      if (row) row.remove();
      showNotice(
        "admin-notice",
        "Removed " + data.removed + " store path. Run GC to delete unreferenced GHCR blobs.",
        "ok",
      );
    } catch (error) {
      btn.disabled = false;
      btn.removeAttribute("data-armed");
      btn.textContent = "remove";
      showNotice("admin-notice", error instanceof Error ? error.message : String(error), "error");
    }
  });
  sortButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-sort");
      if (!next || next === currentSort) return;
      currentSort = next;
      sortButtons.forEach((other) => {
        const active = other.getAttribute("data-sort") === currentSort;
        other.classList.toggle("active", active);
        const th = other.closest("th");
        if (th) th.setAttribute("aria-sort", active ? "descending" : "none");
      });
      refreshPaths();
    });
  });

  // Admin drawer toggle / unlock / lock
  const toggleBtn = document.getElementById("admin-toggle-btn");
  const loginForm = document.getElementById("admin-login-form");
  const tokenInput = document.getElementById("admin-token-input");
  const lockBtn = document.getElementById("admin-lock-btn");

  if (toggleBtn && loginForm) {
    toggleBtn.addEventListener("click", () => {
      const opening = loginForm.hidden;
      loginForm.hidden = !opening;
      toggleBtn.setAttribute("aria-expanded", String(opening));
      if (opening && tokenInput) tokenInput.focus();
    });
  }

  if (loginForm && tokenInput) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = tokenInput.value.trim();
      if (!token) return;
      const submitBtn = loginForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      showNotice("admin-notice", "", "");
      try {
        const res = await fetch("/api/v1/admin/status", {
          headers: { Authorization: "Bearer " + token },
        });
        if (!res.ok) {
          showNotice("admin-notice", "Invalid admin token (" + res.status + ")", "error");
          return;
        }
        sessionStorage.setItem(TOKEN_KEY, token);
        tokenInput.value = "";
        setAdminUi(true);
      } catch (error) {
        showNotice("admin-notice", error instanceof Error ? error.message : String(error), "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if (lockBtn) {
    lockBtn.addEventListener("click", () => {
      sessionStorage.removeItem(TOKEN_KEY);
      setAdminUi(false);
      showNotice("admin-notice", "", "");
    });
  }

  // Admin GC buttons
  async function triggerGc(dryRun, btn) {
    const token = getToken();
    if (!token) return;
    btn.disabled = true;
    showNotice("admin-notice", dryRun ? "Running dry-run GC…" : "Running GC…", "");
    try {
      const res = await fetch("/api/v1/admin/gc" + (dryRun ? "?dry_run=true" : ""), {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error(await res.text());
      const r = await res.json();
      showNotice(
        "admin-notice",
        (dryRun ? "Dry-run GC: " : "GC complete: ") +
          "pr_removed=" + r.pr_paths_removed +
          ", main_removed=" + r.main_paths_removed +
          ", blobs_deleted=" + r.blobs_deleted +
          ", blocked=" + r.blobs_blocked +
          ", skipped=" + r.blobs_skipped +
          ", errors=" + r.blob_errors,
        r.blob_errors > 0 ? "error" : "ok",
      );
      if (!dryRun) refreshPaths();
    } catch (error) {
      showNotice("admin-notice", error instanceof Error ? error.message : String(error), "error");
    } finally {
      btn.disabled = false;
    }
  }

  const dryRunBtn = document.getElementById("gc-dry-run-btn");
  const gcBtn = document.getElementById("gc-run-btn");
  if (dryRunBtn) dryRunBtn.addEventListener("click", () => triggerGc(true, dryRunBtn));
  if (gcBtn) gcBtn.addEventListener("click", () => triggerGc(false, gcBtn));

  // Admin PR delete with inline confirm
  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-delete-pr]");
    if (!btn) return;
    if (btn.getAttribute("data-armed") !== "true") {
      btn.setAttribute("data-armed", "true");
      btn.textContent = "confirm?";
      setTimeout(() => {
        if (btn.isConnected && btn.getAttribute("data-armed") === "true") {
          btn.removeAttribute("data-armed");
          btn.textContent = "remove";
        }
      }, 4000);
      return;
    }

    const token = getToken();
    if (!token) return;
    const target = btn.getAttribute("data-delete-pr");
    btn.disabled = true;
    try {
      const res = await fetch("/api/v1/admin/prs/" + target, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const row = btn.closest("tr");
      const tbody = row ? row.parentElement : null;
      if (row) row.remove();
      if (tbody && tbody.children.length === 0) {
        const emptyTr = document.createElement("tr");
        const emptyTd = document.createElement("td");
        emptyTd.colSpan = 5;
        emptyTd.className = "empty-cell";
        emptyTd.textContent = "No active PR overlays.";
        emptyTr.appendChild(emptyTd);
        tbody.appendChild(emptyTr);
      }
      showNotice(
        "admin-notice",
        "Removed PR overlay " + target + " (" + data.removed + " paths deleted)",
        "ok",
      );
      refreshPaths();
    } catch (error) {
      btn.disabled = false;
      btn.removeAttribute("data-armed");
      btn.textContent = "remove";
      showNotice("admin-notice", error instanceof Error ? error.message : String(error), "error");
    }
  });

  if (getToken()) {
    setAdminUi(true);
  }
})();
`;
