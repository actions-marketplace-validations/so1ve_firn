import { html } from "hono/html";

import manifest from "../../../package.json" with { type: "json" };
import {
  formatAge,
  formatBytes,
  formatRemainingTtl,
  splitStorePath,
} from "../../shared/format.ts";
import { CACHE_PRIORITY } from "../../shared/nix-format.ts";
import type {
  OwnerStatusSummary,
  PrScopeSummary,
  StorePathSummary,
} from "../../shared/protocol.ts";

export interface DashboardData {
  publicBaseUrl: string;
  mainPublicKey: string;
  prPublicKey: string;
  adminEnabled: boolean;
  gc: {
    prTtlDays: number;
    mainLruDays: number;
  };
  mainPaths: number;
  prPaths: number;
  activePrs: number;
  owners: OwnerStatusSummary[];
  prs: PrScopeSummary[];
  paths: StorePathSummary[];
  now: number;
}

function parsePrScope(
  scope: string,
): { owner: string; repo: string; number: string } | null {
  const match = /^pr:([^:]+):([^:]+):(\d+)$/.exec(scope);

  return match ? { owner: match[1], repo: match[2], number: match[3] } : null;
}

function narinfoHref(scope: string, storeHash: string): string {
  const pr = parsePrScope(scope);
  if (pr) {
    return `/pr/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${pr.number}/${storeHash}.narinfo`;
  }

  return `/${storeHash}.narinfo`;
}

export function renderDashboardPage(data: DashboardData) {
  const totalBlobs = data.owners.reduce((sum, o) => sum + o.total_blobs, 0);
  const totalBytes = data.owners.reduce((sum, o) => sum + o.total_bytes, 0);
  const totalUnref = data.owners.reduce(
    (sum, o) => sum + o.unreferenced_blobs,
    0,
  );
  const totalBlocked = data.owners.reduce(
    (sum, o) => sum + o.blocked_blobs.length,
    0,
  );
  const maxOwnerBytes = Math.max(...data.owners.map((o) => o.total_bytes), 1);

  const host = new URL(data.publicBaseUrl).host;

  const nixConfSnippet = [
    `extra-substituters = ${data.publicBaseUrl}`,
    `extra-trusted-public-keys = ${data.mainPublicKey}`,
  ].join("\n");

  const actionsSnippet = [
    "- uses: so1ve/firn@v1",
    "  with:",
    `    server: ${data.publicBaseUrl}`,
  ].join("\n");

  const prSnippet = [
    `extra-substituters = ${data.publicBaseUrl}/pr/<owner>/<repo>/<number>`,
    `extra-trusted-public-keys = ${data.mainPublicKey} ${data.prPublicKey}`,
  ].join("\n");

  const scopeOptions = [
    "main",
    ...data.prs.map((pr) => `pr:${pr.owner_id}:${pr.repo}:${pr.pr_number}`),
  ];

  const pathsRows =
    data.paths.length === 0
      ? html`
          <tr>
            <td class="empty-cell" colspan="5">
              No cached store paths yet. Push artifacts with GitHub Actions or
              <code>firn push</code>
              .
            </td>
          </tr>
        `
      : data.paths.map((item) => {
          const parts = splitStorePath(item.store_path);
          const prScope = parsePrScope(item.scope);
          const href = narinfoHref(item.scope, parts.hash);

          return html`
            <tr>
              <td>
                <div class="path-cell">
                  <a
                    class="path-text mono"
                    href="${href}"
                    title="${item.store_path} (open .narinfo)"
                  >
                    <span class="hash-prefix">${parts.hash.slice(0, 8)}…-</span>
                    <span class="pkg-name">${parts.name}</span>
                  </a>
                  <span class="path-actions">
                    <button
                      type="button"
                      class="link-btn row-action"
                      data-copy="${item.store_path}"
                    >
                      copy
                    </button>
                    ${
                      data.adminEnabled
                        ? html`
                            <button
                              type="button"
                              class="link-btn danger row-action admin-only"
                              hidden
                              data-delete-path="${`${item.scope}\t${parts.hash}`}"
                            >
                              remove
                            </button>
                          `
                        : ""
                    }
                  </span>
                </div>
              </td>
              <td class="mono muted">
                <span class="scope-label" title="${item.scope}">
                  <span
                    class="dot ${item.scope === "main" ? "main" : "pr"}"
                    aria-hidden="true"
                  ></span>
                  ${
                    prScope
                      ? html`
                          <a
                            class="scope-text"
                            href="${`https://github.com/${encodeURIComponent(prScope.owner)}/${encodeURIComponent(prScope.repo)}/pull/${prScope.number}`}"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            ${item.scope}
                          </a>
                        `
                      : html`
                          <span class="scope-text">${item.scope}</span>
                        `
                  }
                </span>
              </td>
              <td class="mono muted">
                <a
                  href="${`https://github.com/${encodeURIComponent(item.owner_id)}`}"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ${item.owner_id}
                </a>
              </td>
              <td class="num mono">${formatBytes(item.file_size)}</td>
              <td
                class="num muted"
                title="${new Date(item.last_accessed_at * 1000).toISOString()}"
              >
                ${formatAge(data.now, item.last_accessed_at)}
              </td>
            </tr>
          `;
        });

  const prsSectionBody =
    data.prs.length === 0
      ? html`
          <p class="empty-line">No active PR overlays.</p>
        `
      : html`
          <div class="table-scroll">
            <table class="prs-table">
              <colgroup>
                <col class="col-repo" />
                <col class="col-count" />
                <col class="col-time" />
                <col class="col-time" />
                <col class="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th class="num">Paths</th>
                  <th class="num">Updated</th>
                  <th class="num">TTL</th>
                  <th class="num" aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                ${data.prs.map((pr) => {
                  const overlayUrl = `${data.publicBaseUrl}/pr/${pr.owner_id}/${pr.repo}/${pr.pr_number}`;
                  const ttl = formatRemainingTtl(
                    data.now,
                    pr.updated_at,
                    data.gc.prTtlDays,
                  );
                  const ttlClass =
                    ttl.state === "expired"
                      ? "danger-text"
                      : ttl.state === "warn"
                        ? "warn-text"
                        : "muted";
                  const repoUrl = `https://github.com/${encodeURIComponent(pr.owner_id)}/${encodeURIComponent(pr.repo)}`;
                  const prUrl = `${repoUrl}/pull/${pr.pr_number}`;

                  return html`
                    <tr>
                      <td class="mono">
                        <a
                          href="${repoUrl}"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span class="muted">${pr.owner_id}/</span>
                          <strong>${pr.repo}</strong>
                        </a>
                        <a
                          class="muted"
                          href="${prUrl}"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          #${pr.pr_number}
                        </a>
                      </td>
                      <td class="num mono">${pr.path_count}</td>
                      <td
                        class="num muted"
                        title="${new Date(pr.updated_at * 1000).toISOString()}"
                      >
                        ${formatAge(data.now, pr.updated_at)}
                      </td>
                      <td class="num ${ttlClass}">${ttl.text}</td>
                      <td class="num">
                        <span class="row-actions">
                          <button
                            type="button"
                            class="link-btn"
                            data-copy="${overlayUrl}"
                          >
                            copy url
                          </button>
                          ${
                            data.adminEnabled
                              ? html`
                                  <button
                                    type="button"
                                    class="link-btn danger admin-only"
                                    hidden
                                    data-delete-pr="${`${encodeURIComponent(pr.owner_id)}/${encodeURIComponent(pr.repo)}/${pr.pr_number}`}"
                                  >
                                    remove
                                  </button>
                                `
                              : ""
                          }
                        </span>
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>
        `;

  const ownersSectionBody =
    data.owners.length === 0
      ? html`
          <p class="empty-line">No owners configured.</p>
        `
      : html`
          <div class="table-scroll">
            <table class="owners-table">
              <colgroup>
                <col class="col-owner-name" />
                <col class="col-share" />
                <col class="col-size" />
                <col class="col-count" />
                <col class="col-count" />
                <col class="col-count" />
              </colgroup>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th class="share-col" aria-label="Storage share"></th>
                  <th class="num">Size</th>
                  <th class="num">Blobs</th>
                  <th class="num">Unref</th>
                  <th class="num">PRs</th>
                </tr>
              </thead>
              <tbody>
                ${data.owners.map((owner) => {
                  const share =
                    owner.total_bytes > 0
                      ? Math.max(0.02, owner.total_bytes / maxOwnerBytes)
                      : 0;
                  const pkgBase =
                    owner.owner_type === "org"
                      ? `https://github.com/orgs/${encodeURIComponent(owner.name)}/packages/container/package`
                      : `https://github.com/users/${encodeURIComponent(owner.name)}/packages/container/package`;
                  const hasBlocked = owner.blocked_blobs.length > 0;

                  return html`
                    <tr class="${hasBlocked ? "owner-has-blocked" : ""}">
                      <td class="mono">
                        <span class="owner-name">
                          <a
                            href="${`https://github.com/${encodeURIComponent(owner.name)}`}"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <strong>${owner.name}</strong>
                          </a>
                          <span class="faint">${owner.owner_type}</span>
                        </span>
                      </td>
                      <td class="share-col">
                        <div
                          class="share-bar"
                          style="--share:${share.toFixed(4)}"
                          aria-hidden="true"
                        ></div>
                      </td>
                      <td class="num mono">
                        <strong>${formatBytes(owner.total_bytes)}</strong>
                      </td>
                      <td class="num mono muted">${owner.total_blobs}</td>
                      <td
                        class="num mono ${
                          owner.unreferenced_blobs > 0 ? "muted" : "faint"
                        }"
                      >
                        ${owner.unreferenced_blobs}
                      </td>
                      <td
                        class="num mono ${
                          owner.active_prs > 0 ? "muted" : "faint"
                        }"
                      >
                        ${owner.active_prs}
                      </td>
                    </tr>
                    ${
                      hasBlocked
                        ? html`
                            <tr class="blocked-row">
                              <td colspan="6">
                                <ul class="blocked-list mono">
                                  ${owner.blocked_blobs.map(
                                    (b) => html`
                                      <li>
                                        gc-blocked:
                                        <a
                                          href="${`${pkgBase}/${encodeURIComponent(b.ghcr_package)}`}"
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          ${b.ghcr_package}
                                        </a>
                                        ${b.manifest_digest.slice(0, 19)}…
                                      </li>
                                    `,
                                  )}
                                </ul>
                              </td>
                            </tr>
                          `
                        : ""
                    }
                  `;
                })}
              </tbody>
            </table>
          </div>
        `;

  return html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Firn - ${host}</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div class="wrap">
          <header class="head">
            <div class="head-top">
              <div class="brand">
                <img
                  class="brand-mark"
                  src="/favicon.svg"
                  alt=""
                  width="22"
                  height="22"
                />
                <h1>Firn</h1>
                <span class="brand-url">${host}</span>
              </div>

              ${
                data.adminEnabled
                  ? html`
                      <div class="head-actions">
                        <button
                          type="button"
                          id="admin-toggle-btn"
                          class="link-btn"
                          aria-expanded="false"
                          aria-controls="admin-login-form"
                        >
                          Admin
                        </button>
                        <div
                          id="admin-active-controls"
                          class="head-actions"
                          hidden
                        >
                          <button
                            type="button"
                            id="gc-dry-run-btn"
                            class="link-btn"
                          >
                            Dry-run GC
                          </button>
                          <button
                            type="button"
                            id="gc-run-btn"
                            class="link-btn accent"
                          >
                            Run GC
                          </button>
                          <button
                            type="button"
                            id="admin-lock-btn"
                            class="link-btn"
                          >
                            Lock
                          </button>
                        </div>
                      </div>
                    `
                  : ""
              }
            </div>

            <div class="summary-line" aria-label="Cache summary">
              <span>
                <strong>${data.mainPaths}</strong>
                main
              </span>
              <span>
                <strong>${data.prPaths}</strong>
                PR (${data.activePrs} active)
              </span>
              <span>
                <strong>${totalBlobs}</strong>
                blobs (${formatBytes(totalBytes)})
              </span>
              <span>priority ${CACHE_PRIORITY}</span>
              <span>
                PR ${data.gc.prTtlDays}d / LRU ${data.gc.mainLruDays}d
              </span>
              ${
                totalUnref > 0
                  ? html`
                      <span>${totalUnref} unreferenced</span>
                    `
                  : ""
              }
              ${
                totalBlocked > 0
                  ? html`
                      <span class="warn-text">${totalBlocked} gc-blocked</span>
                    `
                  : ""
              }
            </div>

            ${
              data.adminEnabled
                ? html`
                    <form id="admin-login-form" class="admin-drawer" hidden>
                      <label class="sr-only" for="admin-token-input">
                        Admin token
                      </label>
                      <input
                        id="admin-token-input"
                        type="password"
                        placeholder="Enter admin token"
                        autocomplete="off"
                      />
                      <button type="submit" class="btn">Unlock</button>
                    </form>
                  `
                : ""
            }
          </header>

          <main>
            <div id="admin-notice" class="notice" role="status" hidden></div>

            <section aria-labelledby="usage-heading">
              <div class="sec-head usage-head">
                <h2 id="usage-heading">Substituter</h2>
                <div
                  class="tabs"
                  role="tablist"
                  aria-label="Configuration format"
                >
                  <button
                    type="button"
                    class="tab-btn"
                    role="tab"
                    aria-selected="true"
                    data-tab="nix"
                  >
                    nix.conf
                  </button>
                  <button
                    type="button"
                    class="tab-btn"
                    role="tab"
                    aria-selected="false"
                    data-tab="gha"
                  >
                    GitHub Actions
                  </button>
                  <button
                    type="button"
                    class="tab-btn"
                    role="tab"
                    aria-selected="false"
                    data-tab="pr"
                  >
                    PR Overlay
                  </button>
                </div>
                <button
                  type="button"
                  id="snippet-copy-btn"
                  class="link-btn accent"
                  data-copy="${nixConfSnippet}"
                >
                  Copy
                </button>
              </div>

              <div
                class="code-block"
                data-panel="nix"
                data-snippet="${nixConfSnippet}"
              >
                <pre>${nixConfSnippet}</pre>
              </div>
              <div
                class="code-block"
                data-panel="gha"
                data-snippet="${actionsSnippet}"
                hidden
              >
                <pre>${actionsSnippet}</pre>
              </div>
              <div
                class="code-block"
                data-panel="pr"
                data-snippet="${prSnippet}"
                hidden
              >
                <pre>${prSnippet}</pre>
              </div>
            </section>

            <section aria-labelledby="paths-heading">
              <div class="sec-head">
                <div class="sec-title">
                  <h2 id="paths-heading">Store Paths</h2>
                  <span id="paths-status" class="sec-count">
                    ${data.paths.length} shown
                  </span>
                </div>
                <div class="toolbar">
                  <label class="sr-only" for="filter-q">
                    Filter store paths
                  </label>
                  <input
                    id="filter-q"
                    type="search"
                    placeholder="Filter paths…"
                  />
                  <label class="sr-only" for="filter-owner">
                    Filter by owner
                  </label>
                  <select id="filter-owner">
                    <option value="">All owners</option>
                    ${data.owners.map(
                      (owner) => html`
                        <option value="${owner.name}">${owner.name}</option>
                      `,
                    )}
                  </select>
                  <label class="sr-only" for="filter-scope">
                    Filter by scope
                  </label>
                  <select id="filter-scope">
                    <option value="">All scopes</option>
                    ${scopeOptions.map(
                      (scope) => html`
                        <option value="${scope}">${scope}</option>
                      `,
                    )}
                  </select>
                  <label class="sr-only" for="filter-limit">Result limit</label>
                  <select id="filter-limit">
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="200">200</option>
                  </select>
                  ${
                    data.adminEnabled
                      ? html`
                          <button
                            type="button"
                            id="delete-matching-btn"
                            class="btn danger admin-only"
                            hidden
                            disabled
                          >
                            Delete matching
                          </button>
                        `
                      : ""
                  }
                </div>
              </div>

              <div
                id="paths-error"
                class="notice error"
                role="alert"
                hidden
              ></div>

              <div class="table-scroll">
                <table class="paths-table">
                  <colgroup>
                    <col class="col-path" />
                    <col class="col-scope" />
                    <col class="col-owner" />
                    <col class="col-size" />
                    <col class="col-time" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Scope</th>
                      <th>Owner</th>
                      <th class="num" aria-sort="none">
                        <button type="button" class="sort-btn" data-sort="size">
                          <span class="sort-arrow" aria-hidden="true">↓</span>
                          Size
                        </button>
                      </th>
                      <th class="num" aria-sort="descending">
                        <button
                          type="button"
                          class="sort-btn active"
                          data-sort="accessed"
                        >
                          <span class="sort-arrow" aria-hidden="true">↓</span>
                          Accessed
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody id="paths-body">${pathsRows}</tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="prs-heading">
              <div class="sec-head">
                <div class="sec-title">
                  <h2 id="prs-heading">Active PR Overlays</h2>
                  <span class="sec-count">${data.prs.length}</span>
                </div>
              </div>

              ${prsSectionBody}
            </section>

            <section aria-labelledby="owners-heading">
              <div class="sec-head">
                <div class="sec-title">
                  <h2 id="owners-heading">Owners &amp; Storage</h2>
                  <span class="sec-count">${data.owners.length}</span>
                </div>
              </div>

              ${ownersSectionBody}
            </section>
          </main>

          <footer class="foot">
            <div class="foot-brand">
              <a
                href="https://github.com/so1ve/firn"
                target="_blank"
                rel="noopener noreferrer"
              >
                Firn
              </a>
              <span class="mono faint">v${manifest.version}</span>
            </div>
            <nav class="foot-links" aria-label="Cache endpoints and links">
              <a class="mono" href="/nix-cache-info">nix-cache-info</a>
              <a class="mono" href="/api/v1/public-keys">public-keys</a>
              <a
                href="https://github.com/so1ve/firn"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </nav>
          </footer>
        </div>
        <script src="/app.js" defer></script>
      </body>
    </html>
  `;
}
