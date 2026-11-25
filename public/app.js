(() => {
  const TOKEN_KEY = "firn_admin_token";
  const MAX_UI_GC_ROUNDS = 200;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);
  const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";
  const errMsg = (e) => (e instanceof Error ? e.message : String(e));

  function syncAdminVisibility(root = document) {
    const unlocked = Boolean(getToken());
    for (const el of $$(".admin-only", root)) {
      el.hidden = !unlocked;
    }
  }

  function setAdminUi(unlocked) {
    syncAdminVisibility();
    const toggleBtn = $("#admin-toggle-btn");
    if (toggleBtn) {
      toggleBtn.hidden = unlocked;
      toggleBtn.setAttribute("aria-expanded", "false");
    }
    const loginForm = $("#admin-login-form");
    if (loginForm) {
      loginForm.hidden = true;
    }
    const activeControls = $("#admin-active-controls");
    if (activeControls) {
      activeControls.hidden = !unlocked;
    }
  }

  function showNotice(id, text, kind = "") {
    const el = $(`#${id}`);
    if (!el) {
      return;
    }
    el.hidden = !text;
    el.textContent = text;
    el.className = `notice${kind ? ` ${kind}` : ""}`;
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

  function resetArm(btn, idleLabel) {
    btn.removeAttribute("data-armed");
    btn.textContent = idleLabel;
  }

  function armConfirm(btn, confirmLabel, idleLabel) {
    if (btn.getAttribute("data-armed") === "true") {
      return true;
    }
    btn.setAttribute("data-armed", "true");
    btn.textContent = confirmLabel;
    setTimeout(() => {
      if (btn.isConnected && btn.getAttribute("data-armed") === "true") {
        resetArm(btn, idleLabel);
      }
    }, 4000);

    return false;
  }

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
        const pre = $("pre", panel);
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
      resetArm(deleteMatchingBtn, "Delete matching");
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
      syncAdminVisibility();
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
    activeController?.abort();
    activeController = new AbortController();

    const params = buildFilterParams();
    if (limitSelect.value) {
      params.set("limit", limitSelect.value);
    }
    params.set("sort", currentSort);

    pathsStatus.textContent = "loading…";
    showNotice("paths-error", "");

    try {
      const res = await fetch(`/api/v1/public/paths?${params}`, {
        headers: { Accept: "text/html" },
        signal: activeController.signal,
      });
      if (!res.ok) {
        throw new Error(`Failed to load paths (${res.status})`);
      }
      pathsBody.innerHTML = await res.text();
      syncAdminVisibility(pathsBody);
      pathsStatus.textContent = `${res.headers.get("X-Firn-Count") ?? 0} shown`;
    } catch (error) {
      if (error?.name === "AbortError") {
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

  deleteMatchingBtn?.addEventListener("click", async () => {
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
        `/api/v1/admin/paths?${buildFilterParams()}`,
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
        other
          .closest("th")
          ?.setAttribute("aria-sort", active ? "descending" : "none");
      }
      refreshPaths();
    });
  }

  async function runRowDelete(btn, url, onSuccess) {
    if (!armConfirm(btn, "confirm?", "remove") || !getToken()) {
      return;
    }
    btn.disabled = true;
    try {
      await onSuccess(await adminFetch(url, "DELETE"));
    } catch (error) {
      btn.disabled = false;
      resetArm(btn, "remove");
      showNotice("admin-notice", errMsg(error), "error");
    }
  }

  // Row-level admin delete (paths & PR overlays)
  document.addEventListener("click", async (event) => {
    const pathBtn = event.target.closest("[data-delete-path]");
    if (pathBtn) {
      const raw = pathBtn.getAttribute("data-delete-path") || "";
      const sep = raw.indexOf("\t");
      const params = new URLSearchParams({
        scope: raw.slice(0, sep),
        hash: raw.slice(sep + 1),
      });
      await runRowDelete(pathBtn, `/api/v1/admin/paths?${params}`, (data) => {
        pathBtn.closest("tr")?.remove();
        showNotice(
          "admin-notice",
          `Removed ${data.removed} store path. Run GC to delete unreferenced GHCR blobs.`,
          "ok",
        );
        refreshOverview();
      });

      return;
    }

    const prBtn = event.target.closest("[data-delete-pr]");
    if (prBtn) {
      const target = prBtn.getAttribute("data-delete-pr");
      await runRowDelete(prBtn, `/api/v1/admin/prs/${target}`, async (data) => {
        showNotice(
          "admin-notice",
          `Removed PR overlay ${target} (${data.removed} paths deleted)`,
          "ok",
        );
        await Promise.all([refreshPaths(), refreshOverview()]);
      });
    }
  });

  // Admin drawer toggle / unlock / lock
  const toggleBtn = $("#admin-toggle-btn");
  const loginForm = $("#admin-login-form");
  const tokenInput = $("#admin-token-input");

  if (toggleBtn && loginForm) {
    toggleBtn.addEventListener("click", () => {
      const opening = loginForm.hidden;
      loginForm.hidden = !opening;
      toggleBtn.setAttribute("aria-expanded", String(opening));
      if (opening) {
        tokenInput?.focus();
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
      showNotice("admin-notice", "");
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

  $("#admin-lock-btn")?.addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setAdminUi(false);
    showNotice("admin-notice", "");
  });

  // Admin GC buttons
  const dryRunBtn = $("#gc-dry-run-btn");
  const gcBtn = $("#gc-run-btn");

  async function triggerGc(dryRun) {
    if (!getToken()) {
      return;
    }
    function setGcDisabled(disabled) {
      for (const btn of [dryRunBtn, gcBtn]) {
        if (btn) {
          btn.disabled = disabled;
        }
      }
    }
    setGcDisabled(true);
    showNotice("admin-notice", dryRun ? "Running dry-run GC…" : "Running GC…");

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
        const step = await adminFetch(url, "POST");
        totals.pr_paths_removed += step.pr_paths_removed;
        totals.main_paths_removed += step.main_paths_removed;
        totals.blobs_deleted += step.blobs_deleted;
        totals.blobs_blocked += step.blobs_blocked;
        totals.blobs_skipped = step.blobs_skipped;
        totals.blob_errors += step.blob_errors;
        if (step.last_error) {
          totals.last_error = step.last_error;
        }

        const madeProgress =
          step.blobs_deleted > 0 ||
          step.blobs_blocked > 0 ||
          step.pr_paths_removed > 0 ||
          step.main_paths_removed > 0;
        if (
          dryRun ||
          step.blobs_skipped === 0 ||
          !madeProgress ||
          rounds >= MAX_UI_GC_ROUNDS
        ) {
          break;
        }

        showNotice(
          "admin-notice",
          `Running GC (round ${rounds + 1})… ${totals.blobs_deleted} blobs deleted${totals.blob_errors > 0 ? `, ${totals.blob_errors} errors` : ""}`,
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
      setGcDisabled(false);
    }
  }

  dryRunBtn?.addEventListener("click", () => triggerGc(true));
  gcBtn?.addEventListener("click", () => triggerGc(false));

  if (getToken()) {
    setAdminUi(true);
  }
})();
