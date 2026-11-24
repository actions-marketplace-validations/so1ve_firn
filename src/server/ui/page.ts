import { html } from "hono/html";

import manifest from "../../../package.json" with { type: "json" };
import {
  MAIN_SCOPE,
  formatAge,
  formatBytes,
  formatRemainingTtl,
  parsePrScope,
  prScope,
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
  gc: { prTtlDays: number; mainLruDays: number };
  mainPaths: number;
  prPaths: number;
  activePrs: number;
  owners: OwnerStatusSummary[];
  prs: PrScopeSummary[];
  paths: StorePathSummary[];
  now: number;
}

const ghLink = (path: string, content: unknown, cls = "") =>
  html`<a${
    cls
      ? html`
          class="${cls}"
        `
      : ""
  } href="${`https://github.com/${path}`}" target="_blank" rel="noopener noreferrer">${content}</a>`;

function narinfoHref(scope: string, storeHash: string): string {
  const pr = parsePrScope(scope);

  return pr
    ? `/pr/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${pr.number}/${storeHash}.narinfo`
    : `/${storeHash}.narinfo`;
}

export function renderDashboardPage(data: DashboardData) {
  let totalBlobs = 0;
  let totalBytes = 0;
  let totalUnref = 0;
  let totalBlocked = 0;
  let maxOwnerBytes = 1;
  for (const o of data.owners) {
    totalBlobs += o.total_blobs;
    totalBytes += o.total_bytes;
    totalUnref += o.unreferenced_blobs;
    totalBlocked += o.blocked_blobs.length;
    if (o.total_bytes > maxOwnerBytes) {
      maxOwnerBytes = o.total_bytes;
    }
  }

  const host = new URL(data.publicBaseUrl).host;
  const snippets = [
    {
      id: "nix",
      label: "nix.conf",
      code: `extra-substituters = ${data.publicBaseUrl}\nextra-trusted-public-keys = ${data.mainPublicKey}`,
    },
    {
      id: "gha",
      label: "GitHub Actions",
      code: `- uses: so1ve/firn@v1\n  with:\n    server: ${data.publicBaseUrl}`,
    },
    {
      id: "pr",
      label: "PR Overlay",
      code: `extra-substituters = ${data.publicBaseUrl}/pr/<owner>/<repo>/<number>\nextra-trusted-public-keys = ${data.mainPublicKey} ${data.prPublicKey}`,
    },
  ];
  const scopeOptions = [
    MAIN_SCOPE,
    ...data.prs.map((pr) => prScope(pr.owner_id, pr.repo, pr.pr_number)),
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
          const pr = parsePrScope(item.scope);
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
                    pr
                      ? ghLink(
                          `${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pull/${pr.number}`,
                          item.scope,
                          "scope-text",
                        )
                      : html`
                          <span class="scope-text">${item.scope}</span>
                        `
                  }
                </span>
              </td>
              <td class="mono muted">
                ${ghLink(encodeURIComponent(item.owner_id), item.owner_id)}
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
                  const repoPath = `${encodeURIComponent(pr.owner_id)}/${encodeURIComponent(pr.repo)}`;

                  return html`
                    <tr>
                      <td class="mono">
                        ${ghLink(
                          repoPath,
                          html`
                            <span class="muted">${pr.owner_id}/</span>
                            <strong>${pr.repo}</strong>
                          `,
                        )}
                        ${ghLink(`${repoPath}/pull/${pr.pr_number}`, `#${pr.pr_number}`, "muted")}
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
                                    data-delete-pr="${`${repoPath}/${pr.pr_number}`}"
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
                  const pkgPrefix = `${owner.owner_type === "org" ? "orgs" : "users"}/${encodeURIComponent(owner.name)}/packages/container/package`;
                  const hasBlocked = owner.blocked_blobs.length > 0;

                  return html`
                    <tr class="${hasBlocked ? "owner-has-blocked" : ""}">
                      <td class="mono">
                        <span class="owner-name">
                          ${ghLink(
                            encodeURIComponent(owner.name),
                            html`
                              <strong>${owner.name}</strong>
                            `,
                          )}
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
                        class="num mono ${owner.unreferenced_blobs > 0 ? "muted" : "faint"}"
                      >
                        ${owner.unreferenced_blobs}
                      </td>
                      <td
                        class="num mono ${owner.active_prs > 0 ? "muted" : "faint"}"
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
                                        ${ghLink(`${pkgPrefix}/${encodeURIComponent(b.ghcr_package)}`, b.ghcr_package)}
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
                  ${snippets.map(
                    (s, i) => html`
                      <button
                        type="button"
                        class="tab-btn"
                        role="tab"
                        aria-selected="${i === 0 ? "true" : "false"}"
                        data-tab="${s.id}"
                      >
                        ${s.label}
                      </button>
                    `,
                  )}
                </div>
                <button
                  type="button"
                  id="snippet-copy-btn"
                  class="link-btn accent"
                  data-copy="${snippets[0].code}"
                >
                  Copy
                </button>
              </div>
              ${snippets.map(
                (s, i) => html`
                  <div
                    class="code-block"
                    data-panel="${s.id}"
                    ${i === 0 ? "" : "hidden"}
                  >
                    <pre>${s.code}</pre>
                  </div>
                `,
              )}
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
              ${ghLink("so1ve/firn", "Firn")}
              <span class="mono faint">v${manifest.version}</span>
            </div>
            <nav class="foot-links" aria-label="Cache endpoints and links">
              <a class="mono" href="/nix-cache-info">nix-cache-info</a>
              <a class="mono" href="/api/v1/public-keys">public-keys</a>
              ${ghLink("so1ve/firn", "GitHub")}
            </nav>
          </footer>
        </div>
        <script src="/app.js" defer></script>
      </body>
    </html>
  `;
}
