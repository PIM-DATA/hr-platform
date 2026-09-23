import ExcelJS from 'exceljs';
import {
  EMPLOYMENT_TYPES, ONBOARDING_COLUMNS, ONBOARDING_LIMITS, ONBOARDING_META_SHEET, ONBOARDING_SHEETS, ONBOARDING_SHEET_ORDER, ONBOARDING_TEMPLATE_VERSION,
  type ColumnSpec, type OnboardingIssue, type OnboardingSheet,
} from '@hr/shared';
import { AppError } from '../../lib/errors';

/**
 * Workbook generation and parsing for customer onboarding.
 *
 * Parsing is deliberately strict and literal:
 *  - only the known sheets and the exact template headers are accepted (no fuzzy matching — a mis-mapped column would
 *    silently import wrong data);
 *  - cell values must be literals: a formula is rejected rather than trusted, so an import cannot depend on what the
 *    workbook computed or on evaluating anything;
 *  - dates must be `YYYY-MM-DD` text or a real Excel date, read from its calendar parts so no timezone can shift a day;
 *  - values are trimmed, and that is all — no case changes, no fuzzy matching of master data, no guessing.
 *
 * Nothing here touches the database; this layer turns a file into rows plus structural issues.
 */

export interface ParsedRow {
  /** 1-based row number as shown in Excel (header is row 1) — error messages must match what the user sees. */
  excelRow: number;
  values: Record<string, string | undefined>;
}
export interface ParsedWorkbook {
  templateVersion: number;
  sheets: Record<OnboardingSheet, ParsedRow[]>;
  issues: OnboardingIssue[];
}

const issue = (sheet: string, row: number, code: string, message: string, field?: string): OnboardingIssue => ({ sheet, row, field, code, message });

/** Cell → trimmed string. Formulas, rich text and unexpected shapes are handled explicitly. */
function cellToString(cell: ExcelJS.Cell, sheet: string, row: number, header: string): { value?: string; issue?: OnboardingIssue } {
  const raw = cell.value;
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && raw !== null && 'formula' in raw) {
    return { issue: issue(sheet, row, 'ONBOARDING_FORMULA_NOT_ALLOWED', 'Formulas are not allowed in import data — paste values instead', header) };
  }
  if (typeof raw === 'object' && raw !== null && 'error' in raw) {
    return { issue: issue(sheet, row, 'ONBOARDING_CELL_ERROR', 'This cell contains an Excel error value', header) };
  }
  if (raw instanceof Date) {
    // Excel dates are read from their calendar parts (UTC accessors match how ExcelJS stores them), never formatted
    // through a local timezone, so a date can never shift by a day.
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return { value: `${y}-${m}-${d}` };
  }
  if (typeof raw === 'object' && raw !== null && 'richText' in raw) {
    return { value: (raw as ExcelJS.RichText[] | { richText: ExcelJS.RichText[] } as { richText: ExcelJS.RichText[] }).richText.map((t) => t.text).join('').trim() };
  }
  if (typeof raw === 'object' && raw !== null && 'text' in raw) return { value: String((raw as { text: unknown }).text).trim() };
  if (typeof raw === 'number' || typeof raw === 'boolean') return { value: String(raw).trim() };
  return { value: String(raw).trim() };
}

/** Header row must match the template exactly (after trimming). Unknown named columns are a warning, not a mapping. */
function readHeaders(worksheet: ExcelJS.Worksheet, sheet: OnboardingSheet, specs: ColumnSpec[], issues: OnboardingIssue[]): Map<string, number> {
  const headerRow = worksheet.getRow(1);
  const byHeader = new Map<string, number>();
  const seen = new Set<string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const name = String(cell.value ?? '').trim();
    if (!name) return;
    if (seen.has(name)) {
      issues.push(issue(sheet, 1, 'ONBOARDING_DUPLICATE_COLUMN', `Column "${name}" appears more than once`, name));
      return;
    }
    seen.add(name);
    if (specs.some((s) => s.header === name)) byHeader.set(name, colNumber);
    else issues.push(issue(sheet, 1, 'ONBOARDING_UNKNOWN_COLUMN', `Column "${name}" is not part of the template and was ignored`, name));
  });
  for (const spec of specs) {
    if (spec.required && !byHeader.has(spec.header)) {
      issues.push(issue(sheet, 1, 'ONBOARDING_MISSING_COLUMN', `Required column "${spec.header}" is missing — do not rename template headers`, spec.header));
    }
  }
  return byHeader;
}

/** Reads the workbook into rows. Throws AppError for whole-file problems; per-row problems become issues. */
export async function parseWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  if (buffer.length > ONBOARDING_LIMITS.maxFileBytes) {
    throw new AppError(413, 'ONBOARDING_FILE_TOO_LARGE', `The workbook exceeds the ${Math.round(ONBOARDING_LIMITS.maxFileBytes / 1024 / 1024)} MB limit`);
  }
  // A .xlsx is a ZIP: a file that is not one (or is a macro-enabled workbook the parser cannot read) fails here.
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new AppError(400, 'ONBOARDING_INVALID_WORKBOOK', 'The file could not be read as an .xlsx workbook');
  }

  const issues: OnboardingIssue[] = [];
  const meta = workbook.getWorksheet(ONBOARDING_META_SHEET);
  const declaredVersion = Number(String(meta?.getCell('B1').value ?? '').trim() || NaN);
  if (!meta || !Number.isInteger(declaredVersion)) {
    throw new AppError(400, 'ONBOARDING_TEMPLATE_VERSION_UNSUPPORTED', 'This workbook has no template version. Download a fresh template and copy your data into it.');
  }
  if (declaredVersion !== ONBOARDING_TEMPLATE_VERSION) {
    throw new AppError(400, 'ONBOARDING_TEMPLATE_VERSION_UNSUPPORTED', `Template version ${declaredVersion} is not supported by this system (expected ${ONBOARDING_TEMPLATE_VERSION})`);
  }

  const sheets = {} as Record<OnboardingSheet, ParsedRow[]>;
  let totalRows = 0;
  for (const sheetName of ONBOARDING_SHEET_ORDER) {
    const specs = ONBOARDING_COLUMNS[sheetName];
    const worksheet = workbook.getWorksheet(sheetName);
    sheets[sheetName] = [];
    if (!worksheet) {
      issues.push(issue(sheetName, 0, 'ONBOARDING_MISSING_SHEET', `Sheet "${sheetName}" is missing — do not rename or delete template sheets`));
      continue;
    }
    const headers = readHeaders(worksheet, sheetName, specs, issues);

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const values: Record<string, string | undefined> = {};
      let hasValue = false;
      for (const spec of specs) {
        const col = headers.get(spec.header);
        if (!col) continue;
        const { value, issue: cellIssue } = cellToString(row.getCell(col), sheetName, rowNumber, spec.header);
        if (cellIssue) { issues.push(cellIssue); hasValue = true; continue; }
        if (value !== undefined && value !== '') { values[spec.header] = value; hasValue = true; }
      }
      if (!hasValue) return; // fully blank row: ignored, not counted
      totalRows += 1;
      sheets[sheetName].push({ excelRow: rowNumber, values });
    });
  }

  if (totalRows > ONBOARDING_LIMITS.maxTotalRows) {
    throw new AppError(413, 'ONBOARDING_TOO_MANY_ROWS', `The workbook has ${totalRows} data rows; the limit is ${ONBOARDING_LIMITS.maxTotalRows}`);
  }
  return { templateVersion: declaredVersion, sheets, issues };
}

/**
 * Builds the onboarding template. Generated on demand rather than stored in the repository, so it can never drift
 * from ONBOARDING_COLUMNS. Code columns are formatted as text so `00123` survives, and enum columns get a dropdown —
 * convenience only: the server validates everything again.
 */
export async function buildTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'HR Enterprise Platform';
  workbook.created = new Date();

  const instructions = workbook.addWorksheet('Instructions');
  instructions.columns = [{ width: 4 }, { width: 110 }];
  const lines: string[] = [
    'Customer onboarding workbook',
    '',
    'How to use this file',
    '1. Fill in the sheets in order: Organizations → Departments → Jobs → Positions → Employees.',
    '2. Upload it on Administration → Onboarding and press Preview. Preview saves nothing.',
    '3. Fix any reported errors in this file and preview again.',
    '4. Press Import to create everything. The import is all-or-nothing: one error means nothing is created.',
    '',
    'Rules',
    '• Do not rename or delete sheets, and do not rename the header row.',
    '• Codes are text — keep leading zeros (00123). Codes are stored uppercase.',
    '• Dates use YYYY-MM-DD (for example 2026-01-31).',
    '• Do not use formulas in data cells; paste values instead.',
    '• A code that already exists in the system is rejected — this workbook creates new records, it never updates existing ones.',
    '• A department parent, a position, or an employee’s manager may appear later in the same workbook.',
    '• Leave optional fields blank; blank rows are ignored.',
    '• Importing employees does NOT create login accounts. Accounts are created separately in Administration → Users.',
    '• There is no undo. Review the preview summary before importing.',
    '',
    'Sheets and columns',
  ];
  for (const sheetName of ONBOARDING_SHEET_ORDER) {
    lines.push('', `${sheetName}`);
    for (const spec of ONBOARDING_COLUMNS[sheetName]) {
      lines.push(`   ${spec.header}${spec.required ? ' (required)' : ''}${spec.note ? ` — ${spec.note}` : ''}`);
    }
  }
  lines.forEach((text, i) => {
    const cell = instructions.getCell(`B${i + 1}`);
    cell.value = text;
    if (i === 0) cell.font = { bold: true, size: 14 };
    else if (['How to use this file', 'Rules', 'Sheets and columns'].includes(text) || ONBOARDING_SHEET_ORDER.includes(text as OnboardingSheet)) cell.font = { bold: true };
  });

  for (const sheetName of ONBOARDING_SHEET_ORDER) {
    const specs = ONBOARDING_COLUMNS[sheetName];
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = specs.map((spec) => ({ header: spec.header, key: spec.header, width: Math.max(16, spec.header.length + 4) }));
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    header.commit();

    specs.forEach((spec, index) => {
      const column = sheet.getColumn(index + 1);
      if (spec.kind === 'code' || spec.kind === 'date' || spec.kind === 'text') column.numFmt = '@'; // text: keeps 00123 and YYYY-MM-DD literal
      if (spec.kind === 'enum' && spec.enumValues?.length) {
        // Convenience dropdown for rows 2..1000; the server validates the value regardless.
        for (let row = 2; row <= 1000; row++) {
          sheet.getCell(row, index + 1).dataValidation = { type: 'list', allowBlank: !spec.required, formulae: [`"${spec.enumValues.join(',')}"`] };
        }
      }
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const meta = workbook.addWorksheet(ONBOARDING_META_SHEET);
  meta.getCell('A1').value = 'templateVersion';
  meta.getCell('B1').value = ONBOARDING_TEMPLATE_VERSION;
  meta.getCell('A2').value = 'generatedAt';
  meta.getCell('B2').value = new Date().toISOString();
  meta.state = 'veryHidden'; // not part of the data the user edits

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

export const EMPLOYMENT_TYPE_VALUES = EMPLOYMENT_TYPES;
export { ONBOARDING_SHEETS };
