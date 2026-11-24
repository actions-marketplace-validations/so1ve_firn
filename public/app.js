(() => {
  const TOKEN_KEY = "firn_admin_token";
  const MAX_UI_GC_ROUNDS = 200;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);
  const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";
  const errMsg = (e) => (e instanceof Error ? e.message : String(e));

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null) {
          if (
            k === "className" ||
            k === "hidden" ||
            k === "colSpan" ||
            k === "type" ||
            k === "href" ||
            k === "target" ||
            k === "rel" ||
            k === "title"
          ) {
            el[k] = v;
          } else {
            el.setAttribute(k, v);
          }
        }
      }
    }
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) {
        el.append(child);
      }
    }

    return el;
  }

  function setAdminUi(unlocked) {
    for (const el of $$(".admin-only")) {
      el.hidden = !unlocked;
    }
    const toggleBtn = $("#admin-toggle-btn");
    const loginForm = $("#admin-login-form");
    const activeControls = $("#admin-active-controls");
    if (toggleBtn) {
      toggleBtn.hidden = unlocked;
      toggleBtn.setAttribute("aria-expanded", "false");
    }
    if (loginForm) {
      loginForm.hidden = true;
    }
    if (activeControls) {
      activeControls.hidden = !unlocked;
    }
  }

  function showNotice(id, text, kind) {
    const el = $(`#${id}`);
    if (el) {
      el.hidden = !text;
      el.textContent = text;
      el.className = `notice${kind ? ` ${kind}` : ""}`;
    }
  }

  async function adminFetch(url, method) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }

    return res.json();
  }

  function armConfirm(btn, confirmLabel, idleLabel) {
    if (btn.getAttribute("data-armed") === "true") {
      return true;
    }
    btn.setAttribute("data-armed", "true");
    btn.textContent = confirmLabel;
    setTimeout(() => {
      if (btn.isConnected && btn.getAttribute("data-armed") === "true") {
        btn.removeAttribute("data-armed");
        btn.textContent = idleLabel;
      }
    }, 4000);

    return false;
  }

  function formatBytes(bytes) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i + 1 < units.length) {
      v /= 1024;
      i += 1;
    }

    return i === 0 ? `${bytes} B` : `${v.toFixed(2)} ${units[i]}`;
  }

  function formatAge(ts) {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (d < 60) {
      return `${d}s ago`;
    }
    if (d < 3600) {
      return `${Math.floor(d / 60)}m ago`;
    }
    if (d < 86_400) {
      return `${Math.floor(d / 3600)}h ago`;
    }

    return `${Math.floor(d / 86_400)}d ago`;
  }

  function splitStorePath(storePath) {
    const base = storePath.startsWith("/nix/store/")
      ? storePath.slice(11)
      : storePath;

    return base.length > 33 && base[32] === "-"
      ? { hash: base.slice(0, 32), name: base.slice(33) }
      : { hash: "", name: base };
  }

  const extLink = (href, text, className) =>
    h(
      "a",
      { href, target: "_blank", rel: "noopener noreferrer", className },
      text,
    );

  // Copy buttons
  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-copy]");
    if (!btn) {
      return;
    }
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy") || "");
      const prev = btn.textContent;
      btn.textContent = prev === prev.toLowerCase() ? "copied" : "Copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      btn.textContent = "failed";
    }
  });

  // Snippet tabs
  const snippetCopyBtn = $("#snippet-copy-btn");
  for (const btn of $$(".tab-btn")) {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      for (const other of $$(".tab-btn")) {
        other.setAttribute("aria-selected", String(other === btn));
      }
      for (const panel of $$("[data-panel]")) {
        const active = panel.getAttribute("data-panel") === target;
        panel.hidden = !active;
        const pre = panel.querySelector("pre");
        if (active && snippetCopyBtn && pre) {
          snippetCopyBtn.setAttribute("data-copy", pre.textContent || "");
        }
      }
    });
  }

  // Live store paths filter & sort
  const searchInput = $("#filter-q");
  const ownerSelect = $("#filter-owner");
  const scopeSelect = $("#filter-scope");
  const limitSelect = $("#filter-limit");
  const deleteMatchingBtn = $("#delete-matching-btn");
  const sortButtons = $$(".sort-btn[data-sort]");
  const pathsBody = $("#paths-body");
  const pathsStatus = $("#paths-status");

  let currentSort = "accessed";
  let filterTimer = null;
  let activeController = null;

  function buildFilterParams() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) {
      params.set("q", searchInput.value.trim());
    }
    if (ownerSelect.value) {
      params.set("owner", ownerSelect.value);
    }
    if (scopeSelect.value) {
      params.set("scope", scopeSelect.value);
    }

    return params;
  }

  function syncDeleteMatchingState() {
    if (!deleteMatchingBtn) {
      return;
    }
    const hasFilter = Boolean(
      searchInput.value.trim() || ownerSelect.value || scopeSelect.value,
    );
    deleteMatchingBtn.disabled = !hasFilter;
    if (!hasFilter && deleteMatchingBtn.getAttribute("data-armed") === "true") {
      deleteMatchingBtn.removeAttribute("data-armed");
      deleteMatchingBtn.textContent = "Delete matching";
    }
  }

  async function refreshOverview() {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) {
        return;
      }
      const doc = new DOMParser().parseFromString(
        await res.text(),
        "text/html",
      );
      for (const selector of [
        ".summary-line",
        'section[aria-labelledby="prs-heading"]',
        'section[aria-labelledby="owners-heading"]',
      ]) {
        const cur = $(selector);
        const next = $(selector, doc);
        if (cur && next) {
          cur.replaceWith(next);
        }
      }
      if (getToken()) {
        for (const el of $$(".admin-only")) {
          el.hidden = false;
        }
      }
      const nextScope = $("#filter-scope", doc);
      if (scopeSelect && nextScope) {
        const selected = scopeSelect.value;
        scopeSelect.replaceChildren(...nextScope.children);
        scopeSelect.value = selected;
        if (scopeSelect.value !== selected) {
          scopeSelect.value = "";
        }
        syncDeleteMatchingState();
      }
    } catch {
      // Ignore transient refresh failures; primary action already succeeded.
    }
  }

  async function refreshPaths() {
    if (activeController) {
      activeController.abort();
    }
    activeController = new AbortController();

    const params = buildFilterParams();
    if (limitSelect.value) {
      params.set("limit", limitSelect.value);
    }
    params.set("sort", currentSort);

    pathsStatus.textContent = "loading…";
    showNotice("paths-error", "", "");

    try {
      const res = await fetch(`/api/v1/public/paths?${params.toString()}`, {
        signal: activeController.signal,
      });
      if (!res.ok) {
        throw new Error(`Failed to load paths (${res.status})`);
      }
      const items = await res.json();

      if (items.length === 0) {
        pathsBody.replaceChildren(
          h(
            "tr",
            null,
            h(
              "td",
              { colSpan: 5, className: "empty-cell" },
              "No matching store paths.",
            ),
          ),
        );
      } else {
        const rows = items.map((item) => {
          const parts = splitStorePath(item.store_path);
          const pr = /^pr:([^:]+):([^:]+):(\d+)$/.exec(item.scope);
          const href = pr
            ? `/pr/${encodeURIComponent(pr[1])}/${encodeURIComponent(pr[2])}/${pr[3]}/${parts.hash}.narinfo`
            : `/${parts.hash}.narinfo`;

          return h(
            "tr",
            null,
            h(
              "td",
              null,
              h(
                "div",
                { className: "path-cell" },
                h(
                  "a",
                  {
                    className: "path-text mono",
                    href,
                    title: `${item.store_path} (open .narinfo)`,
                  },
                  h(
                    "span",
                    { className: "hash-prefix" },
                    `${parts.hash.slice(0, 8)}…-`,
                  ),
                  h("span", { className: "pkg-name" }, parts.name),
                ),
                h(
                  "span",
                  { className: "path-actions" },
                  h(
                    "button",
                    {
                      "type": "button",
                      "className": "link-btn row-action",
                      "data-copy": item.store_path,
                    },
                    "copy",
                  ),
                  Boolean(deleteMatchingBtn) &&
                    h(
                      "button",
                      {
                        "type": "button",
                        "className": "link-btn danger row-action admin-only",
                        "hidden": !getToken(),
                        "data-delete-path": `${item.scope}\t${parts.hash}`,
                      },
                      "remove",
                    ),
                ),
              ),
            ),
            h(
              "td",
              { className: "mono muted" },
              h(
                "span",
                { className: "scope-label", title: item.scope },
                h("span", {
                  "className": `dot ${item.scope === "main" ? "main" : "pr"}`,
                  "aria-hidden": "true",
                }),
                pr
                  ? extLink(
                      `https://github.com/${encodeURIComponent(pr[1])}/${encodeURIComponent(pr[2])}/pull/${pr[3]}`,
                      item.scope,
                      "scope-text",
                    )
                  : h("span", { className: "scope-text" }, item.scope),
              ),
            ),
            h(
              "td",
              { className: "mono muted" },
              extLink(
                `https://github.com/${encodeURIComponent(item.owner_id)}`,
                item.owner_id,
              ),
            ),
            h("td", { className: "num mono" }, formatBytes(item.file_size)),
            h(
              "td",
              {
                className: "num muted",
                title: new Date(item.last_accessed_at * 1000).toISOString(),
              },
              formatAge(item.last_accessed_at),
            ),
          );
        });
        pathsBody.replaceChildren(...rows);
      }
      pathsStatus.textContent = `${items.length} shown`;
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
      pathsStatus.textContent = "";
      showNotice("paths-error", errMsg(error), "error");
    }
  }

  searchInput.addEventListener("input", () => {
    syncDeleteMatchingState();
    clearTimeout(filterTimer);
    filterTimer = setTimeout(refreshPaths, 180);
  });
  for (const el of [ownerSelect, scopeSelect, limitSelect]) {
    el.addEventListener("change", () => {
      syncDeleteMatchingState();
      refreshPaths();
    });
  }
  syncDeleteMatchingState();

  if (deleteMatchingBtn) {
    deleteMatchingBtn.addEventListener("click", async () => {
      if (
        !armConfirm(deleteMatchingBtn, "Confirm delete?", "Delete matching") ||
        !getToken()
      ) {
        return;
      }
      deleteMatchingBtn.disabled = true;
      deleteMatchingBtn.removeAttribute("data-armed");
      deleteMatchingBtn.textContent = "Deleting…";
      try {
        const data = await adminFetch(
          `/api/v1/admin/paths?${buildFilterParams().toString()}`,
          "DELETE",
        );
        showNotice(
          "admin-notice",
          `Removed ${data.removed} store paths. Run GC to delete unreferenced GHCR blobs.`,
          "ok",
        );
        await Promise.all([refreshPaths(), refreshOverview()]);
      } catch (error) {
        showNotice("admin-notice", errMsg(error), "error");
      } finally {
        deleteMatchingBtn.textContent = "Delete matching";
        syncDeleteMatchingState();
      }
    });
  }

  for (const btn of sortButtons) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-sort");
      if (!next || next === currentSort) {
        return;
      }
      currentSort = next;
      for (const other of sortButtons) {
        const active = other.getAttribute("data-sort") === currentSort;
        other.classList.toggle("active", active);
        const th = other.closest("th");
        if (th) {
          th.setAttribute("aria-sort", active ? "descending" : "none");
        }
      }
      refreshPaths();
    });
  }

  // Row-level admin delete (paths & PR overlays)
  document.addEventListener("click", async (event) => {
    const pathBtn = event.target.closest("[data-delete-path]");
    if (pathBtn) {
      if (!armConfirm(pathBtn, "confirm?", "remove") || !getToken()) {
        return;
      }
      const raw = pathBtn.getAttribute("data-delete-path") || "";
      const sep = raw.indexOf("\t");
      pathBtn.disabled = true;
      try {
        const params = new URLSearchParams({
          scope: raw.slice(0, sep),
          hash: raw.slice(sep + 1),
        });
        const data = await adminFetch(
          `/api/v1/admin/paths?${params.toString()}`,
          "DELETE",
        );
        pathBtn.closest("tr")?.remove();
        showNotice(
          "admin-notice",
          `Removed ${data.removed} store path. Run GC to delete unreferenced GHCR blobs.`,
          "ok",
        );
        refreshOverview();
      } catch (error) {
        pathBtn.disabled = false;
        pathBtn.removeAttribute("data-armed");
        pathBtn.textContent = "remove";
        showNotice("admin-notice", errMsg(error), "error");
      }

      return;
    }

    const prBtn = event.target.closest("[data-delete-pr]");
    if (prBtn) {
      if (!armConfirm(prBtn, "confirm?", "remove") || !getToken()) {
        return;
      }
      const target = prBtn.getAttribute("data-delete-pr");
      prBtn.disabled = true;
      try {
        const data = await adminFetch(`/api/v1/admin/prs/${target}`, "DELETE");
        showNotice(
          "admin-notice",
          `Removed PR overlay ${target} (${data.removed} paths deleted)`,
          "ok",
        );
        await Promise.all([refreshPaths(), refreshOverview()]);
      } catch (error) {
        prBtn.disabled = false;
        prBtn.removeAttribute("data-armed");
        prBtn.textContent = "remove";
        showNotice("admin-notice", errMsg(error), "error");
      }
    }
  });

  // Admin drawer toggle / unlock / lock
  const toggleBtn = $("#admin-toggle-btn");
  const loginForm = $("#admin-login-form");
  const tokenInput = $("#admin-token-input");
  const lockBtn = $("#admin-lock-btn");

  if (toggleBtn && loginForm) {
    toggleBtn.addEventListener("click", () => {
      const opening = loginForm.hidden;
      loginForm.hidden = !opening;
      toggleBtn.setAttribute("aria-expanded", String(opening));
      if (opening && tokenInput) {
        tokenInput.focus();
      }
    });
  }

  if (loginForm && tokenInput) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = tokenInput.value.trim();
      if (!token) {
        return;
      }
      const submitBtn = $('button[type="submit"]', loginForm);
      if (submitBtn) {
        submitBtn.disabled = true;
      }
      showNotice("admin-notice", "", "");
      try {
        const res = await fetch("/api/v1/admin/status", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          showNotice(
            "admin-notice",
            `Invalid admin token (${res.status})`,
            "error",
          );

          return;
        }
        sessionStorage.setItem(TOKEN_KEY, token);
        tokenInput.value = "";
        setAdminUi(true);
      } catch (error) {
        showNotice("admin-notice", errMsg(error), "error");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
        }
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
  const dryRunBtn = $("#gc-dry-run-btn");
  const gcBtn = $("#gc-run-btn");

  async function triggerGc(dryRun) {
    if (!getToken()) {
      return;
    }
    if (dryRunBtn) {
      dryRunBtn.disabled = true;
    }
    if (gcBtn) {
      gcBtn.disabled = true;
    }
    showNotice(
      "admin-notice",
      dryRun ? "Running dry-run GC…" : "Running GC…",
      "",
    );

    try {
      const totals = {
        pr_paths_removed: 0,
        main_paths_removed: 0,
        blobs_deleted: 0,
        blobs_blocked: 0,
        blobs_skipped: 0,
        blob_errors: 0,
        last_error: "",
      };
      const url = dryRun ? "/api/v1/admin/gc?dry_run=true" : "/api/v1/admin/gc";
      let rounds = 0;

      while (rounds < MAX_UI_GC_ROUNDS) {
        rounds += 1;
        const r = await adminFetch(url, "POST");
        totals.pr_paths_removed += r.pr_paths_removed;
        totals.main_paths_removed += r.main_paths_removed;
        totals.blobs_deleted += r.blobs_deleted;
        totals.blobs_blocked += r.blobs_blocked;
        totals.blobs_skipped = r.blobs_skipped;
        totals.blob_errors += r.blob_errors;
        if (r.last_error) {
          totals.last_error = r.last_error;
        }

        const madeProgress =
          r.blobs_deleted > 0 ||
          r.blobs_blocked > 0 ||
          r.pr_paths_removed > 0 ||
          r.main_paths_removed > 0;
        if (
          dryRun ||
          r.blobs_skipped === 0 ||
          !madeProgress ||
          rounds >= MAX_UI_GC_ROUNDS
        ) {
          break;
        }

        showNotice(
          "admin-notice",
          `Running GC (round ${rounds + 1})… ${totals.blobs_deleted} blobs deleted${totals.blob_errors > 0 ? `, ${totals.blob_errors} errors` : ""}`,
          "",
        );
        await refreshOverview();
      }

      const prefix = dryRun
        ? "Dry-run GC"
        : `GC complete${rounds > 1 ? ` (${rounds} rounds)` : ""}`;
      showNotice(
        "admin-notice",
        `${prefix}: pr_removed=${totals.pr_paths_removed}, main_removed=${totals.main_paths_removed}, blobs_deleted=${totals.blobs_deleted}, blocked=${totals.blobs_blocked}, skipped=${totals.blobs_skipped}, errors=${totals.blob_errors}${totals.last_error ? ` — ${totals.last_error}` : ""}`,
        totals.blob_errors > 0 ? "error" : "ok",
      );
      if (!dryRun) {
        await Promise.all([refreshPaths(), refreshOverview()]);
      }
    } catch (error) {
      showNotice("admin-notice", errMsg(error), "error");
    } finally {
      if (dryRunBtn) {
        dryRunBtn.disabled = false;
      }
      if (gcBtn) {
        gcBtn.disabled = false;
      }
    }
  }

  if (dryRunBtn) {
    dryRunBtn.addEventListener("click", () => triggerGc(true));
  }
  if (gcBtn) {
    gcBtn.addEventListener("click", () => triggerGc(false));
  }

  if (getToken()) {
    setAdminUi(true);
  }
})();
