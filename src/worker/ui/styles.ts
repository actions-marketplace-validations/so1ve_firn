export const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f7f6f2;
  --raised: #fdfcf9;
  --text: #1a1917;
  --muted: #66645e;
  --faint: #9c988f;
  --border: #e4e1d8;
  --border-strong: #cfcbb9;
  --accent: #256870;
  --accent-hover: #1b5057;
  --ok: #266b47;
  --warn: #a65912;
  --danger: #b42318;
  --bar-track: #ebe8df;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131413;
    --raised: #1a1b1a;
    --text: #e7e5de;
    --muted: #96938b;
    --faint: #67655e;
    --border: #2a2b28;
    --border-strong: #3c3e39;
    --accent: #5cb4bc;
    --accent-hover: #7ec9d0;
    --ok: #5bb982;
    --warn: #e0a458;
    --danger: #e56b6f;
    --bar-track: #222320;
  }
}

*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::selection {
  background: var(--accent);
  color: var(--bg);
}

a {
  color: inherit;
  text-decoration: none;
  transition: color 0.12s;
}
a:hover {
  color: var(--accent);
}
button, input, select { font: inherit; color: inherit; }

code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.warn-text { color: var(--warn); }
.danger-text { color: var(--danger); }
.ok-text { color: var(--ok); }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

[hidden] { display: none !important; }

:focus-visible {
  outline: 1.5px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}

input:focus,
select:focus {
  outline: none;
  border-color: var(--accent);
}

.wrap {
  width: min(100% - 2.5rem, 58rem);
  margin-inline: auto;
  padding-block: clamp(1.75rem, 5vh, 3rem) 4rem;
}

/* Header */
.head {
  display: grid;
  gap: 0.5rem;
}

.head-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1.25rem;
}

.brand {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.55rem;
}

.brand-mark {
  display: block;
  width: 22px;
  height: 22px;
  flex: none;
}

.brand h1 {
  margin: 0;
  font-size: 1.375rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.1;
}

.brand-url {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12.5px;
}

.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1.25rem;
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.summary-line strong {
  color: var(--text);
  font-weight: 600;
}

.row-actions {
  display: inline-flex;
  align-items: baseline;
  gap: 0.75rem;
}

/* Quiet text actions & admin drawer */
.head-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.875rem;
}

.link-btn {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 0.28em;
  text-decoration-thickness: 1.5px;
  transition: color 0.12s, text-decoration-color 0.12s;
  white-space: nowrap;
}

.link-btn:hover:not(:disabled) {
  color: var(--text);
  text-decoration-color: var(--border-strong);
}

.link-btn.accent { color: var(--accent); }
.link-btn.accent:hover:not(:disabled) { color: var(--accent-hover); text-decoration-color: var(--accent); }
.link-btn.danger { color: var(--danger); }
.link-btn.danger:hover:not(:disabled) { text-decoration-color: var(--danger); }
.link-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.admin-drawer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.375rem;
  padding-top: 0.625rem;
  border-top: 1px dashed var(--border);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--raised);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s, color 0.12s;
}

.btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.btn:disabled { opacity: 0.5; cursor: not-allowed; }

input[type="search"],
input[type="password"],
select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--raised);
  color: var(--text);
  font-size: 12.5px;
  transition: border-color 0.12s;
}

input[type="search"]:hover,
input[type="password"]:hover,
select:hover {
  border-color: var(--border-strong);
}

input[type="search"] { width: 190px; }
input[type="password"] { width: 200px; }

.notice {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 2px solid var(--border-strong);
  background: var(--raised);
  font-size: 12.5px;
  color: var(--muted);
}

.notice.error { border-left-color: var(--danger); color: var(--danger); }
.notice.ok { border-left-color: var(--ok); color: var(--ok); }

/* Sections */
section {
  margin-top: 2.5rem;
}

.sec-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.75rem;
}

.sec-title {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
}

.sec-head h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.sec-count {
  font-size: 12.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* Substituter tabs + code block */
.tabs-row {
  display: flex;
  align-items: baseline;
  gap: 1rem;
}

.tabs {
  display: inline-flex;
  gap: 0.875rem;
}

.tab-btn {
  border: 0;
  padding: 0 0 2px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1.5px solid transparent;
  transition: color 0.12s, border-color 0.12s;
}

.tab-btn:hover { color: var(--text); }
.tab-btn[aria-selected="true"] {
  color: var(--text);
  font-weight: 550;
  border-bottom-color: var(--accent);
}

.code-block {
  background: var(--raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 0.9rem;
  overflow-x: auto;
}

.code-block pre {
  margin: 0;
  white-space: pre;
  line-height: 1.6;
}

/* Filters */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}

/* Flat hairline tables */
.table-scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.paths-table,
.prs-table,
.owners-table {
  table-layout: fixed;
}

.paths-table { min-width: 40rem; }
.prs-table { min-width: 34rem; }

.col-path, .col-repo, .col-share { width: auto; }
.col-scope { width: 11.5rem; }
.col-owner { width: 6.5rem; }
.col-owner-name { width: 10.5rem; }
.col-size { width: 6.5rem; }
.col-time { width: 6.25rem; }
.col-count { width: 4.75rem; }
.col-actions { width: 8rem; }

th {
  text-align: left;
  padding: 0.25rem 0.75rem 0.5rem 0;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--faint);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

th:last-child { padding-right: 0; }

.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: color 0.12s;
}

.sort-btn:hover { color: var(--text); }
.sort-btn.active { color: var(--text); font-weight: 600; }

.sort-arrow {
  display: inline-block;
  width: 0.75em;
  text-align: center;
  color: var(--accent);
  visibility: hidden;
}

.sort-btn.active .sort-arrow { visibility: visible; }
.sort-btn:hover:not(.active) .sort-arrow { visibility: visible; opacity: 0.45; }

td {
  padding: 0.5rem 0.75rem 0.5rem 0;
  border-bottom: 1px dashed var(--border);
  vertical-align: middle;
  white-space: nowrap;
}

td:last-child { padding-right: 0; }
tbody tr:last-child td { border-bottom: 0; }

.path-cell {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-width: 0;
}

.path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pkg-name { font-weight: 500; }
.hash-prefix { color: var(--faint); }

.row-action {
  color: var(--faint);
  font-size: 12px;
  min-width: 38px;
  text-align: right;
  text-decoration: none;
  flex: none;
}

tr:hover .row-action,
.row-action:focus-visible {
  color: var(--accent);
}

/* Subtle scope dot instead of pill soup */
.scope-label {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 100%;
  min-width: 0;
}

.scope-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--faint);
}

.dot.main { background: var(--ok); }
.dot.pr { background: var(--accent); }
.dot.warn { background: var(--warn); }

/* Owner storage table */
.owner-name {
  display: inline-flex;
  align-items: baseline;
  gap: 0.45rem;
  max-width: 100%;
  min-width: 0;
}

.owner-name strong {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.owners-table .share-col {
  padding-right: 1.25rem;
}

.share-bar {
  height: 5px;
  border-radius: 999px;
  background:
    linear-gradient(to right, var(--accent) calc(var(--share) * 100%), transparent 0),
    var(--bar-track);
}

.owners-table td strong {
  font-weight: 550;
}

.owner-has-blocked td {
  border-bottom: 0;
  padding-bottom: 0.2rem;
}

.blocked-row td {
  padding-top: 0;
}

.blocked-list {
  margin: 0;
  padding: 0 0 0 1rem;
  list-style: none;
  font-size: 12px;
  color: var(--warn);
}

.blocked-list li {
  margin-top: 0.15rem;
  white-space: normal;
}

.empty-line {
  margin: 0.25rem 0;
  color: var(--muted);
  font-size: 13px;
}

.empty-cell {
  padding: 1.25rem 0;
  color: var(--muted);
  font-size: 13px;
  white-space: normal;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}

@media (max-width: 680px) {
  .wrap { width: min(100% - 1.5rem, 58rem); }
  .owners-table .share-col,
  .owners-table .col-share { display: none; }
  input[type="search"] { width: 100%; }
}
`;
