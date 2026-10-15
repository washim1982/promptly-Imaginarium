// MS-Studio: reading and writing Office documents.
//
// Spreadsheets are the only one of the three where editing round-trips
// honestly, so they get the most care here: an edit **loads the original
// workbook and changes the cells in place**, then writes it back. Regenerating
// a workbook from the grid would throw away every style, formula, merge and
// chart the file came with.
//
// Word and PowerPoint are read here and rendered in the renderer. Saving them
// is not implemented, and the UI says so rather than pretending.

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DocKind = 'sheet' | 'word' | 'slides' | 'other';

/** Formats saved before 2007 are a different file format, not just an extension. */
const LEGACY = new Set(['.doc', '.xls', '.ppt']);
const KIND: Record<string, DocKind> = {
  '.xlsx': 'sheet', '.xlsm': 'sheet', '.xls': 'sheet', '.csv': 'sheet',
  '.docx': 'word', '.doc': 'word', '.rtf': 'word',
  '.pptx': 'slides', '.ppt': 'slides',
};

export const kindOf = (file: string): DocKind => KIND[path.extname(file).toLowerCase()] ?? 'other';
export const isLegacy = (file: string) => LEGACY.has(path.extname(file).toLowerCase());

export interface TreeNode {
  name: string;
  /** Relative to the workspace root, forward slashes. */
  path: string;
  isDir: boolean;
  kind: DocKind;
  legacy: boolean;
  size: number;
  children?: TreeNode[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_ENTRIES = 4000;

/** The folder tree, with only Office documents among the files. */
export async function buildTree(root: string): Promise<TreeNode[]> {
  let budget = MAX_ENTRIES;

  async function walk(dir: string, rel: string, depth: number): Promise<TreeNode[]> {
    if (depth > 8 || budget <= 0) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (budget-- <= 0) break;
      if (e.name.startsWith('~$') || e.name.startsWith('.')) continue; // Office lock files
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const children = await walk(abs, relPath, depth + 1);
        // A folder with no documents anywhere inside it is noise.
        if (children.length) {
          out.push({ name: e.name, path: relPath, isDir: true, kind: 'other', legacy: false, size: 0, children });
        }
        continue;
      }
      const kind = kindOf(e.name);
      if (kind === 'other') continue;
      const st = await stat(abs).catch(() => null);
      out.push({
        name: e.name,
        path: relPath,
        isDir: false,
        kind,
        legacy: isLegacy(e.name),
        size: st?.size ?? 0,
      });
    }
    out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return out;
  }

  return walk(root, '', 0);
}

// ---- spreadsheets -----------------------------------------------------------------

export interface SheetCell {
  /** Displayed text. */
  text: string;
  /** The formula, without '=', when the cell has one. */
  formula?: string;
  /** Right-align numbers and dates the way a spreadsheet does. */
  numeric?: boolean;
}

export interface SheetData {
  name: string;
  rows: SheetCell[][];
  columnWidths: number[];
  rowCount: number;
  columnCount: number;
  /** "A1:C3" ranges. */
  merges: string[];
  /** True when the sheet was clipped to the view limit. */
  truncated: boolean;
}

export interface WorkbookData {
  sheets: SheetData[];
  /** Set when the file is a pre-2007 .xls that was read but cannot be written. */
  readOnlyReason?: string;
}

const MAX_ROWS = 2000;
const MAX_COLS = 60;

function cellText(cell: ExcelJS.Cell): SheetCell {
  const v = cell.value;
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'number') return { text: String(v), numeric: true };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (v instanceof Date) return { text: v.toISOString().slice(0, 10), numeric: true };
  if (typeof v === 'object') {
    const o = v as ExcelJS.CellFormulaValue & ExcelJS.CellRichTextValue & ExcelJS.CellHyperlinkValue & { error?: string };
    if (o.formula !== undefined) {
      const result = o.result;
      return {
        text: result === null || result === undefined ? '' : String(typeof result === 'object' ? '' : result),
        formula: o.formula,
        numeric: typeof result === 'number',
      };
    }
    if (o.richText) return { text: o.richText.map((r) => r.text).join('') };
    if (o.text) return { text: String(o.text) };
    if (o.error) return { text: String(o.error) };
  }
  return { text: String(v) };
}

export async function readWorkbook(file: string): Promise<WorkbookData> {
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') await workbook.csv.readFile(file);
  else if (ext === '.xls') {
    throw new Error(
      'This is a pre-2007 .xls file. Save it as .xlsx in Excel first — the old binary format is not supported here.',
    );
  } else await workbook.xlsx.readFile(file);

  const sheets: SheetData[] = [];
  workbook.eachSheet((sheet) => {
    const rowCount = Math.min(sheet.rowCount || 0, MAX_ROWS);
    const columnCount = Math.min(Math.max(sheet.columnCount || 0, 1), MAX_COLS);
    const rows: SheetCell[][] = [];
    for (let r = 1; r <= rowCount; r++) {
      const row = sheet.getRow(r);
      const cells: SheetCell[] = [];
      for (let c = 1; c <= columnCount; c++) cells.push(cellText(row.getCell(c)));
      rows.push(cells);
    }
    const columnWidths: number[] = [];
    for (let c = 1; c <= columnCount; c++) columnWidths.push(Math.round((sheet.getColumn(c).width ?? 10) * 8));
    sheets.push({
      name: sheet.name,
      rows,
      columnWidths,
      rowCount,
      columnCount,
      merges: Object.keys((sheet as unknown as { _merges?: Record<string, unknown> })._merges ?? {}),
      truncated: (sheet.rowCount || 0) > MAX_ROWS || (sheet.columnCount || 0) > MAX_COLS,
    });
  });
  if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [], columnWidths: [], rowCount: 0, columnCount: 0, merges: [], truncated: false });
  return { sheets };
}

export interface CellEdit {
  sheet: string;
  /** 1-based, as the grid shows them. */
  row: number;
  column: number;
  value: string;
}

/**
 * Apply edits to the workbook as it exists on disk and save it again.
 *
 * Loading and mutating is what keeps the rest of the file intact — styles,
 * column widths, other sheets, charts. A value that starts with '=' is stored
 * as a formula; a value that parses as a number is stored as a number, so the
 * cell stays usable in arithmetic rather than becoming text.
 */
export async function writeWorkbookEdits(file: string, edits: CellEdit[]): Promise<number> {
  if (path.extname(file).toLowerCase() === '.xls') {
    throw new Error('Pre-2007 .xls files cannot be saved. Convert the file to .xlsx first.');
  }
  const workbook = new ExcelJS.Workbook();
  const isCsv = path.extname(file).toLowerCase() === '.csv';
  if (isCsv) await workbook.csv.readFile(file);
  else await workbook.xlsx.readFile(file);

  let applied = 0;
  for (const edit of edits) {
    const sheet = workbook.getWorksheet(edit.sheet);
    if (!sheet) continue;
    const cell = sheet.getRow(edit.row).getCell(edit.column);
    const raw = edit.value;
    if (raw === '') cell.value = null;
    else if (raw.startsWith('=')) cell.value = { formula: raw.slice(1), result: undefined } as ExcelJS.CellFormulaValue;
    else if (raw.trim() !== '' && Number.isFinite(Number(raw))) cell.value = Number(raw);
    else cell.value = raw;
    applied++;
  }

  if (isCsv) await workbook.csv.writeFile(file);
  else await workbook.xlsx.writeFile(file);
  return applied;
}

export async function createWorkbook(file: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.getCell('A1').value = null;
  await mkdir(path.dirname(file), { recursive: true });
  await workbook.xlsx.writeFile(file);
}

// ---- presentations ------------------------------------------------------------------

export interface SlideShape {
  text: string;
  /** EMU converted to a 0–100 share of the slide, so the renderer can scale. */
  x: number;
  y: number;
  w: number;
  h: number;
  bold: boolean;
  /** Rough point size, when the file states one. */
  size: number;
  title: boolean;
}

export interface SlideData {
  index: number;
  shapes: SlideShape[];
  notes: string;
}

const EMU_PER_INCH = 914400;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Enough of a .pptx to show what a slide says and roughly where.
 *
 * This reads the shape tree for text and geometry. It is a viewer, not a
 * renderer: themes, images, tables, charts and master layouts are not applied,
 * and the UI labels it a preview for that reason.
 */
export async function readSlides(file: string): Promise<{ slides: SlideData[]; width: number; height: number }> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

  let width = 9144000;
  let height = 6858000;
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (presentationXml) {
    const size = parser.parse(presentationXml)?.['p:presentation']?.['p:sldSz'];
    if (size) {
      width = Number(size['@cx']) || width;
      height = Number(size['@cy']) || height;
    }
  }

  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));

  const slides: SlideData[] = [];
  for (const [i, name] of names.entries()) {
    const xml = await zip.file(name)!.async('string');
    const doc = parser.parse(xml);
    const tree = doc?.['p:sld']?.['p:cSld']?.['p:spTree'] ?? {};
    const shapes: SlideShape[] = [];

    for (const sp of asArray(tree['p:sp'] as Record<string, unknown> | Record<string, unknown>[])) {
      const nv = (sp['p:nvSpPr'] as Record<string, unknown>) ?? {};
      const placeholder = ((nv['p:nvPr'] as Record<string, unknown>)?.['p:ph'] ?? {}) as Record<string, string>;
      const xfrm = ((sp['p:spPr'] as Record<string, unknown>)?.['a:xfrm'] ?? {}) as Record<string, Record<string, string>>;
      const off = xfrm['a:off'] ?? {};
      const ext = xfrm['a:ext'] ?? {};

      const paragraphs = asArray((sp['p:txBody'] as Record<string, unknown>)?.['a:p'] as Record<string, unknown>[]);
      const lines: string[] = [];
      let bold = false;
      let size = 0;
      for (const p of paragraphs) {
        const runs = asArray(p['a:r'] as Record<string, unknown>[]);
        const text = runs
          .map((r) => {
            const props = (r['a:rPr'] ?? {}) as Record<string, string>;
            if (props['@b'] === '1') bold = true;
            if (props['@sz']) size = Math.max(size, Number(props['@sz']) / 100);
            const t = r['a:t'];
            return typeof t === 'object' ? '' : String(t ?? '');
          })
          .join('');
        if (text.trim()) lines.push(text);
      }
      if (!lines.length) continue;

      shapes.push({
        text: lines.join('\n'),
        x: (Number(off['@x']) || 0) / width * 100,
        y: (Number(off['@y']) || 0) / height * 100,
        w: (Number(ext['@cx']) || width / 2) / width * 100,
        h: (Number(ext['@cy']) || height / 8) / height * 100,
        bold,
        size: size || 18,
        title: /^(ctrTitle|title|subTitle)$/.test(String(placeholder['@type'] ?? '')),
      });
    }

    slides.push({ index: i + 1, shapes, notes: '' });
  }

  return { slides, width: width / EMU_PER_INCH, height: height / EMU_PER_INCH };
}

// ---- documents ----------------------------------------------------------------------

const UNESCAPE: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescapeXml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => UNESCAPE[m]);

/** The text of a .docx: every run, with paragraph breaks where Word has them. */
async function documentText(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return '';
  const paragraphs: string[] = [];
  // Each <w:p> is a paragraph; <w:t> holds the visible runs inside it.
  for (const p of xml.split('</w:p>')) {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1]));
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join('\n\n');
}

export interface DocumentText {
  kind: DocKind;
  text: string;
  /** Characters before clipping, so the panel can say how much the model saw. */
  fullLength: number;
  truncated: boolean;
}

/**
 * The open document as plain text for the local model.
 *
 * Shaped per format rather than dumped: a sheet becomes tab-separated rows
 * under a heading per sheet, a deck becomes one block per slide. Both read
 * far more cheaply in tokens than any markup would.
 */
export async function extractText(file: string, maxChars = 20000): Promise<DocumentText> {
  const kind = kindOf(file);
  let text = '';

  if (kind === 'sheet') {
    const book = await readWorkbook(file);
    const parts: string[] = [];
    for (const sheet of book.sheets) {
      const rows = sheet.rows
        .map((row) => row.map((c) => c.text).join('\t').replace(/\t+$/, ''))
        .filter((line) => line.trim());
      if (!rows.length) continue;
      parts.push(`## Sheet: ${sheet.name}\n${rows.join('\n')}`);
    }
    text = parts.join('\n\n');
  } else if (kind === 'word') {
    text = await documentText(file);
  } else if (kind === 'slides') {
    const deck = await readSlides(file);
    text = deck.slides
      .map((s) => `## Slide ${s.index}\n${s.shapes.map((sh) => sh.text).join('\n')}`)
      .join('\n\n');
  }

  const fullLength = text.length;
  const truncated = fullLength > maxChars;
  return {
    kind,
    text: truncated ? `${text.slice(0, maxChars)}\n\n[… clipped to fit the model's context …]` : text,
    fullLength,
    truncated,
  };
}

/** Raw bytes for the renderer, which renders .docx with docx-preview. */
export async function readBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(file));
}

/** A blank, valid .docx — the smallest set of parts Word will open. */
export async function createDocument(file: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t xml:space="preserve"></w:t></w:r></w:p></w:body></w:document>`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
}
