import { stripVTControlCharacters, styleText } from "node:util";

import { splitStorePath } from "../shared/format.ts";

export {
  formatAge,
  formatBytes,
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
    bold: (text: string) => paint("bold", text),
    dim: (text: string) => paint("dim", text),
    cyan: (text: string) => paint("cyan", text),
    boldCyan: (text: string) => paint(["bold", "cyan"], text),
    green: (text: string) => paint("green", text),
    boldGreen: (text: string) => paint(["bold", "green"], text),
    yellow: (text: string) => paint("yellow", text),
    boldYellow: (text: string) => paint(["bold", "yellow"], text),
    red: (text: string) => paint("red", text),
    boldRed: (text: string) => paint(["bold", "red"], text),
  };
}

export const out = createStyler(process.stdout);
export const err = createStyler(process.stderr);

export function formatStorePath(storePath: string): string {
  const { hash, name } = splitStorePath(storePath);
  if (hash) {
    const prefix = storePath.startsWith("/nix/store/") ? "/nix/store/" : "";

    return `${out.dim(`${prefix}${hash}-`)}${name}`;
  }

  return storePath;
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
  const gap = Math.max(0, width - visibleLength(text));
  const spaces = " ".repeat(gap);

  return align === "right" ? `${spaces}${text}` : `${text}${spaces}`;
}

export function renderBanner(title: string, subtitle?: string): string {
  const head = `${out.boldCyan("◆")} ${out.bold(title)}`;

  return subtitle ? `${head}  ${out.dim(subtitle)}` : head;
}

export function renderSection(title: string, subtitle?: string): string {
  const label = `${out.cyan("▸")} ${out.bold(title)}`;

  return subtitle ? `\n${label} ${out.dim(subtitle)}` : `\n${label}`;
}

export function renderKv(
  entries: readonly [label: string, value: string][],
  indent = "  ",
): string {
  const maxLabel = Math.max(
    ...entries.map(([label]) => visibleLength(label)),
    0,
  );

  return entries
    .map(([label, value]) => {
      const padded = padCell(label, maxLabel + 2);
      const styled =
        visibleLength(label) === label.length ? out.dim(padded) : padded;

      return `${indent}${styled}${value}`;
    })
    .join("\n");
}

export function renderTable<T>(
  columns: readonly TableColumn<T>[],
  rows: readonly T[],
  indent = "  ",
): string {
  const renderedRows = rows.map((row) =>
    columns.map((column) => column.value(row)),
  );
  const widths = columns.map((column, colIndex) =>
    Math.max(
      visibleLength(column.header),
      ...renderedRows.map((row) => visibleLength(row[colIndex])),
    ),
  );
  const lastCol = columns.length - 1;

  const formatCell = (
    text: string,
    idx: number,
    align: "left" | "right" | undefined,
  ): string =>
    idx === lastCol && align !== "right"
      ? text
      : padCell(text, widths[idx], align);

  const headerLine = columns
    .map((column, idx) => out.dim(formatCell(column.header, idx, column.align)))
    .join("  ");
  const ruleLine = out.dim(widths.map((width) => "─".repeat(width)).join("  "));
  const bodyLines = renderedRows.map((row) =>
    row
      .map((cell, idx) => formatCell(cell, idx, columns[idx].align))
      .join("  "),
  );

  return [
    `${indent}${headerLine}`,
    `${indent}${ruleLine}`,
    ...bodyLines.map((line) => `${indent}${line}`),
  ].join("\n");
}
