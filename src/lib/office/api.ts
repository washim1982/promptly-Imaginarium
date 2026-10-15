// MS-Studio: the typed bridge to electron/office/.

import { requireDesktop } from '../desktop';

export type DocKind = 'sheet' | 'word' | 'slides' | 'other';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  kind: DocKind;
  legacy: boolean;
  size: number;
  children?: TreeNode[];
}

export interface SheetCell {
  text: string;
  formula?: string;
  numeric?: boolean;
}

export interface SheetData {
  name: string;
  rows: SheetCell[][];
  columnWidths: number[];
  rowCount: number;
  columnCount: number;
  merges: string[];
  truncated: boolean;
}

export interface WorkbookData {
  sheets: SheetData[];
  readOnlyReason?: string;
}

export interface CellEdit {
  sheet: string;
  row: number;
  column: number;
  value: string;
}

export interface SlideShape {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bold: boolean;
  size: number;
  title: boolean;
}

export interface SlideDeck {
  slides: { index: number; shapes: SlideShape[]; notes: string }[];
  /** Slide size in inches, for the preview's aspect ratio. */
  width: number;
  height: number;
}

export interface DocumentText {
  kind: DocKind;
  text: string;
  fullLength: number;
  truncated: boolean;
}

export interface OfficeWorkspace {
  path: string;
  name: string;
}

interface OfficeBridge {
  getWorkspace(): Promise<OfficeWorkspace | null>;
  pickWorkspace(): Promise<OfficeWorkspace | null>;
  tree(): Promise<TreeNode[]>;
  readWorkbook(rel: string): Promise<WorkbookData>;
  saveWorkbook(rel: string, edits: CellEdit[]): Promise<{ applied: number }>;
  readSlides(rel: string): Promise<SlideDeck>;
  extractText(rel: string, maxChars?: number): Promise<DocumentText>;
  readBytes(rel: string): Promise<Uint8Array>;
  create(rel: string): Promise<{ path: string }>;
  reveal(rel: string): Promise<void>;
}

const bridge = () => (requireDesktop() as unknown as { office: OfficeBridge }).office;

export const officeApi: OfficeBridge = {
  getWorkspace: () => bridge().getWorkspace(),
  pickWorkspace: () => bridge().pickWorkspace(),
  tree: () => bridge().tree(),
  readWorkbook: (rel) => bridge().readWorkbook(rel),
  saveWorkbook: (rel, edits) => bridge().saveWorkbook(rel, edits),
  readSlides: (rel) => bridge().readSlides(rel),
  extractText: (rel, maxChars) => bridge().extractText(rel, maxChars),
  readBytes: (rel) => bridge().readBytes(rel),
  create: (rel) => bridge().create(rel),
  reveal: (rel) => bridge().reveal(rel),
};

/** A1, B7, AA3 — the label a spreadsheet puts on a column. */
export function columnLabel(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

export const cellRef = (row: number, column: number) => `${columnLabel(column)}${row}`;
