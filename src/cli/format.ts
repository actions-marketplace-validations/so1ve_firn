import { stripVTControlCharacters, styleText } from "node:util";

import { splitStorePath } from "../shared/format.ts";

export {
  formatAge,
  formatBytes,
  formatDurationMs,
  formatRemainingTtl,
} from "../shared/format.ts";

type TextStyle = Parameters<typeof styleText>[0];

export interface TableColumn<T> {
  header: string;
  align?: "left" | "right";
  value: (row: T) => string;
}

export function createStyler(stream: NodeJS.WriteStream = process.stdout) {
  const paint = (style: TextStyle, text: string): string =>
    styleText(style, text, { stream });

  return {
    bold: (t: string) => paint("bold", t),
    dim: (t: string) => paint("dim", t),
    cyan: (t: string) => paint("cyan", t),
    boldCyan: (t: string) => paint(["bold", "cyan"], t),
    green: (t: string) => paint("green", t),
    boldGreen: (t: string) => paint(["bold", "green"], t),
    yellow: (t: string) => paint("yellow", t),
    boldYellow: (t: string) => paint(["bold", "yellow"], t),
    red: (t: string) => paint("red", t),
    boldRed: (t: string) => paint(["bold", "red"], t),
  };
}

export const out = createStyler(process.stdout);
export const err = createStyler(process.stderr);

export function formatStorePath(storePath: string, styler = out): string {
  const { hash, name } = splitStorePath(storePath);
  if (!hash) {
    return storePath;
  }
  const prefix = storePath.startsWith("/nix/store/") ? "/nix/store/" : "";

  return `${styler.dim(`${prefix}${hash}-`)}${name}`;
}

export const formatScope = (scope: string): string =>
  scope === "main" ? out.green(scope) : out.cyan(scope);

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

export const renderBanner = (title: string, subtitle?: string): string =>
  subtitle
    ? `${out.boldCyan("◆")} ${out.bold(title)}  ${out.dim(subtitle)}`
    : `${out.boldCyan("◆")} ${out.bold(title)}`;

export const renderSection = (title: string, subtitle?: string): string =>
  subtitle
    ? `\n${out.cyan("▸")} ${out.bold(title)} ${out.dim(subtitle)}`
    : `\n${out.cyan("▸")} ${out.bold(title)}`;

export function renderKv(
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
        `${indent}${out.dim(padCell(label, maxLabel + 2))}${value}`,
    )
    .join("\n");
}

export function renderTable<T>(
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
    `${indent}${columns.map((col, i) => out.dim(formatCell(col.header, i, col.align))).join("  ")}`,
    `${indent}${out.dim(widths.map((w) => "─".repeat(w)).join("  "))}`,
    ...renderedRows.map(
      (row) =>
        `${indent}${row.map((cell, i) => formatCell(cell, i, columns[i].align)).join("  ")}`,
    ),
  ].join("\n");
}
