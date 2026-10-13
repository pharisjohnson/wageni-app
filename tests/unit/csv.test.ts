import { describe, expect, test } from "vitest";
import { CSV_BOM, escapeCsvCell, neutralizeFormula, toCsv } from "@/lib/csv";

describe("escapeCsvCell", () => {
  test("plain values pass through", () => {
    expect(escapeCsvCell("hello")).toBe("hello");
    expect(escapeCsvCell(42)).toBe("42");
    expect(escapeCsvCell(1.5)).toBe("1.5");
    expect(escapeCsvCell(true)).toBe("true");
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(Number.NaN)).toBe("");
  });

  test("quotes fields with commas, quotes and newlines", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  test.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd", "=HYPERLINK(\"http://x\",\"y\")"])(
    "neutralises formula cell %j",
    (cell) => {
      const out = escapeCsvCell(cell);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(cell);
    },
  );

  test("negative numbers stay numbers, negative-looking text is neutralised", () => {
    expect(escapeCsvCell(-5)).toBe("-5");
    expect(escapeCsvCell("-5")).toBe("'-5");
  });

  test("only a leading character triggers neutralising", () => {
    expect(neutralizeFormula("a=b")).toBe("a=b");
    expect(neutralizeFormula("")).toBe("");
  });
});

describe("toCsv", () => {
  test("adds a BOM, CRLF row breaks and a trailing newline", () => {
    const csv = toCsv(["Name", "Note"], [["Jane", "a,b"], ["=evil", 3]]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1)).toBe('Name,Note\r\nJane,"a,b"\r\n\'=evil,3\r\n');
  });

  test("headers are escaped too and the BOM can be omitted", () => {
    expect(toCsv(["=x"], [], { bom: false })).toBe("'=x\r\n");
  });
});
