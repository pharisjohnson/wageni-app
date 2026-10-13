/**
 * CSV generation for report exports.
 *
 * - RFC 4180 quoting (fields containing comma, quote, CR or LF are quoted;
 *   quotes are doubled), CRLF row separators.
 * - CSV/formula-injection protection: a text cell that begins with = + - @
 *   tab or carriage return is prefixed with a single quote so spreadsheet
 *   apps show it as text instead of evaluating it. Numbers are emitted as
 *   numbers and are never altered.
 * - UTF-8 BOM so Excel detects the encoding.
 */
export const CSV_BOM = "﻿";

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralise spreadsheet formulas in a text value. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  const text = neutralizeFormula(cell);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvCell[])[],
  { bom = true }: { bom?: boolean } = {},
): string {
  const lines = [headers, ...rows].map((r) => r.map(escapeCsvCell).join(","));
  return (bom ? CSV_BOM : "") + lines.join("\r\n") + "\r\n";
}
