import { stripVTControlCharacters } from "node:util";

import type { Theme } from "clerc";

import { splitStorePath } from "../shared/format.ts";

export {
  formatAge,
  formatBytes,
  formatDurationMs,
  formatRemainingTtl,
} from "../shared/format.ts";

export interface TableColumn<T> {
  header: string;
  align?: "left" | "right";
  value: (row: T) => string;
}

export const col = <T>(
  header: string,
  value: (row: T) => string,
  align?: "left" | "right",
): TableColumn<T> => ({ header, value, align });

export function formatStorePath(theme: Theme, storePath: string): string {
  const { hash, name } = splitStorePath(storePath);
  if (!hash) {
    return storePath;
  }
  const prefix = storePath.startsWith("/nix/store/") ? "/nix/store/" : "";

  return `${theme.muted(`${prefix}${hash}-`)}${name}`;
}

export const formatScope = (theme: Theme, scope: string): string =>
  scope === "main" ? theme.success(scope) : theme.accent(scope);

const visibleLength = (text: string): number =>
  stripVTControlCharacters(text).length;

function padCell(
  text: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const spaces = " ".repeat(Math.max(0, width - visibleLength(text)));

  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

export const renderBanner = (
  theme: Theme,
  title: string,
  subtitle?: string,
): string =>
  subtitle
    ? `${theme.brand("◆")} ${theme.bold(title)}  ${theme.muted(subtitle)}`
    : `${theme.brand("◆")} ${theme.bold(title)}`;

export const renderSection = (
  theme: Theme,
  title: string,
  subtitle?: string,
): string =>
  subtitle
    ? `\n${theme.heading(title.toUpperCase())} ${theme.muted(subtitle)}`
    : `\n${theme.heading(title.toUpperCase())}`;

export function renderKv(
  theme: Theme,
  entries: readonly [label: string, value: string][],
  indent = "  ",
): string {
  const maxLabel = Math.max(
    ...entries.map(([label]) => visibleLength(label)),
    0,
  );

  return entries
    .map(
      ([label, value]) =>
        `${indent}${theme.muted(padCell(label, maxLabel + 2))}${value}`,
    )
    .join("\n");
}

export function renderTable<T>(
  theme: Theme,
  columns: readonly TableColumn<T>[],
  rows: readonly T[],
  indent = "  ",
): string {
  const renderedRows = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(
      visibleLength(col.header),
      ...renderedRows.map((row) => visibleLength(row[i])),
    ),
  );
  const lastCol = columns.length - 1;
  const formatCell = (
    text: string,
    idx: number,
    align?: "left" | "right",
  ): string =>
    idx === lastCol && align !== "right"
      ? text
      : padCell(text, widths[idx], align);

  return [
    `${indent}${columns.map((col, i) => theme.muted(formatCell(col.header, i, col.align))).join("  ")}`,
    `${indent}${theme.muted(widths.map((w) => "─".repeat(w)).join("  "))}`,
    ...renderedRows.map(
      (row) =>
        `${indent}${row.map((cell, i) => formatCell(cell, i, columns[i].align)).join("  ")}`,
    ),
  ].join("\n");
}
