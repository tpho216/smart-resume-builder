#!/usr/bin/env node
/**
 * testDocxStructure.ts — Inspect the raw OOXML structure of a DOCX file to
 * understand its visual layout: page columns, tables, paragraph styles,
 * heading positions, indentation, tab stops, font sizes, and bold runs.
 *
 * This is a diagnostic/exploratory script, NOT part of the production pipeline.
 *
 * Usage:
 *   tsx src/testDocxStructure.ts [path/to/resume.docx]
 *   npm run test:docx
 *
 * Requires: pizzip, fast-xml-parser
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StyleDef {
    id: string;
    name: string;
    type: string; // 'paragraph' | 'character' | 'table' | 'numbering'
    basedOn?: string;
}

interface TabStop {
    pos: number;    // in twips
    val: string;    // 'left' | 'right' | 'center' | 'decimal' | 'bar'
    leader?: string;
}

interface RunInfo {
    text: string;
    bold: boolean;
    italic: boolean;
    fontSize?: number; // half-points (sz), divide by 2 for pt
    color?: string;
    highlight?: string;
}

interface ParagraphInfo {
    index: number;
    style: string;          // resolved style name
    rawStyleId: string;
    alignment: string;      // 'left' | 'center' | 'right' | 'both' | 'distribute'
    indentLeft?: number;    // twips
    indentHanging?: number; // twips
    spacingBefore?: number; // twips (20ths of a pt)
    spacingAfter?: number;
    tabs: TabStop[];
    runs: RunInfo[];
    text: string;           // concatenated plain text
    isEmpty: boolean;
}

interface CellInfo {
    paragraphCount: number;
    paragraphs: ParagraphInfo[];
    width?: number; // twips
    gridSpan?: number;
    verticalMerge?: string;
}

interface RowInfo {
    cells: CellInfo[];
    isHeader?: boolean;
    height?: number; // twips
}

interface TableInfo {
    index: number;
    rows: RowInfo[];
    rowCount: number;
    maxCols: number;
    hasBorders: boolean;
    tableWidth?: number;
    colWidths: number[];  // widths from tblGrid
    indent?: number;      // tblInd
    alignment?: string;   // tblpPr or jc
}

interface PageLayout {
    widthTwips: number;
    heightTwips: number;
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
    columns: number;
    columnWidths: number[];
    columnSpacing: number;
    orientation: string;
}

interface DocStructure {
    pageLayout: PageLayout;
    tables: TableInfo[];
    paragraphs: ParagraphInfo[];    // only top-level paragraphs (outside tables)
    allParagraphs: ParagraphInfo[]; // every paragraph including those inside tables
    styleMap: Map<string, StyleDef>;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function parseXml(xmlStr: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        allowBooleanAttributes: true,
        parseAttributeValue: false, // keep as strings for twip values
        isArray: (tagName: string) => {
            // Force these to always be arrays so we can safely iterate them
            return [
                'w:p', 'w:r', 'w:tr', 'w:tc', 'w:pStyle', 'w:tab',
                'w:style', 'w:col', 'w:tblGrid', 'w:gridCol',
                'w:ins', 'w:del', 'w:hyperlink', 'w:bookmarkStart',
                'w:bookmarkEnd', 'w:fldChar', 'w:instrText', 'w:t',
                'w:tbl',
            ].includes(tagName);
        },
    });
    return parser.parse(xmlStr);
}

function arr<T>(val: T | T[] | undefined): T[] {
    if (val === undefined || val === null) return [];
    return Array.isArray(val) ? val : [val];
}

function attr(node: any, name: string): string | undefined {
    if (!node) return undefined;
    return node[`@_w:${name}`] ?? node[`@_${name}`];
}

function numAttr(node: any, name: string): number | undefined {
    const v = attr(node, name);
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Style map
// ---------------------------------------------------------------------------

function buildStyleMap(stylesXml: string): Map<string, StyleDef> {
    const map = new Map<string, StyleDef>();
    try {
        const doc = parseXml(stylesXml);
        const styles = doc?.['w:styles']?.['w:style'];
        for (const style of arr(styles)) {
            const id = attr(style, 'styleId') ?? '';
            const type = attr(style, 'type') ?? '';
            const nameNode = style?.['w:name'];
            const name = (typeof nameNode === 'object' ? attr(nameNode, 'val') : nameNode) ?? id;
            const basedOnNode = style?.['w:basedOn'];
            const basedOn = basedOnNode ? attr(basedOnNode, 'val') : undefined;
            if (id) {
                map.set(id, { id, name, type, basedOn });
            }
        }
    } catch {
        // ignore parse errors in styles — style names will fall back to ids
    }
    return map;
}

function resolveStyleName(id: string | undefined, styleMap: Map<string, StyleDef>): string {
    if (!id) return 'Normal';
    return styleMap.get(id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// Paragraph parsing
// ---------------------------------------------------------------------------

function extractRunInfo(run: any): RunInfo {
    const rPr = run?.['w:rPr'];
    const bold = !!(rPr?.['w:b'] !== undefined || rPr?.['w:b']?.['@_w:val'] !== '0');
    const boldNode = rPr?.['w:b'];
    const isBold = boldNode !== undefined && attr(boldNode, 'val') !== '0';
    const italic = rPr?.['w:i'] !== undefined && attr(rPr?.['w:i'], 'val') !== '0';
    const szNode = rPr?.['w:sz'];
    const fontSize = szNode ? numAttr(szNode, 'val') : undefined;
    const colorNode = rPr?.['w:color'];
    const color = colorNode ? attr(colorNode, 'val') : undefined;
    const highlightNode = rPr?.['w:highlight'];
    const highlight = highlightNode ? attr(highlightNode, 'val') : undefined;

    // Text can be w:t (plain) or inside w:ins (tracked insert)
    let text = '';
    for (const t of arr(run?.['w:t'])) {
        text += typeof t === 'string' ? t : (t?.['#text'] ?? '');
    }
    for (const ins of arr(run?.['w:ins'])) {
        for (const r of arr(ins?.['w:r'])) {
            for (const t of arr(r?.['w:t'])) {
                text += typeof t === 'string' ? t : (t?.['#text'] ?? '');
            }
        }
    }

    return { text, bold: isBold, italic, fontSize, color, highlight };
}

function parseParagraph(p: any, index: number, styleMap: Map<string, StyleDef>): ParagraphInfo {
    const pPr = p?.['w:pPr'];
    const pStyle = pPr?.['w:pStyle'];
    const rawStyleId = pStyle ? (attr(pStyle, 'val') ?? 'Normal') : 'Normal';
    const styleName = resolveStyleName(rawStyleId, styleMap);

    const jc = pPr?.['w:jc'];
    const alignment = jc ? (attr(jc, 'val') ?? 'left') : 'left';

    const ind = pPr?.['w:ind'];
    const indentLeft = ind ? numAttr(ind, 'left') : undefined;
    const indentHanging = ind ? numAttr(ind, 'hanging') : undefined;

    const spacing = pPr?.['w:spacing'];
    const spacingBefore = spacing ? numAttr(spacing, 'before') : undefined;
    const spacingAfter = spacing ? numAttr(spacing, 'after') : undefined;

    // Tab stops
    const tabs: TabStop[] = [];
    const tabsNode = pPr?.['w:tabs'];
    if (tabsNode) {
        for (const tab of arr(tabsNode?.['w:tab'])) {
            const pos = numAttr(tab, 'pos');
            const val = attr(tab, 'val') ?? 'left';
            const leader = attr(tab, 'leader');
            if (pos !== undefined) tabs.push({ pos, val, leader });
        }
    }

    // Runs (also check w:hyperlink which wraps runs)
    const runs: RunInfo[] = [];
    for (const run of arr(p?.['w:r'])) {
        runs.push(extractRunInfo(run));
    }
    for (const hl of arr(p?.['w:hyperlink'])) {
        for (const run of arr(hl?.['w:r'])) {
            runs.push(extractRunInfo(run));
        }
    }
    // Also check w:ins at paragraph level
    for (const ins of arr(p?.['w:ins'])) {
        for (const run of arr(ins?.['w:r'])) {
            runs.push(extractRunInfo(run));
        }
    }

    const text = runs.map(r => r.text).join('');

    return {
        index,
        style: styleName,
        rawStyleId,
        alignment,
        indentLeft,
        indentHanging,
        spacingBefore,
        spacingAfter,
        tabs,
        runs,
        text,
        isEmpty: text.trim() === '',
    };
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

function parseTable(tbl: any, tableIndex: number, styleMap: Map<string, StyleDef>, globalParaIndex: { n: number }): TableInfo {
    const tblPr = tbl?.['w:tblPr'];
    const tblW = tblPr?.['w:tblW'];
    const tableWidth = tblW ? numAttr(tblW, 'w') : undefined;

    const tblInd = tblPr?.['w:tblInd'];
    const indent = tblInd ? numAttr(tblInd, 'w') : undefined;

    const jc = tblPr?.['w:jc'];
    const alignment = jc ? attr(jc, 'val') : undefined;

    // Detect borders — if any border is 'nil' or absent we treat as borderless
    const tblBorders = tblPr?.['w:tblBorders'];
    let hasBorders = false;
    if (tblBorders) {
        for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
            const sideNode = tblBorders?.[`w:${side}`];
            if (sideNode) {
                const val = attr(sideNode, 'val');
                if (val && val !== 'nil' && val !== 'none') {
                    hasBorders = true;
                    break;
                }
            }
        }
    }

    // Column widths from tblGrid
    const colWidths: number[] = [];
    const tblGrid = tbl?.['w:tblGrid'];
    for (const gridCol of arr(tblGrid?.['w:gridCol'])) {
        const w = numAttr(gridCol, 'w');
        if (w !== undefined) colWidths.push(w);
    }

    const rows: RowInfo[] = [];
    for (const tr of arr(tbl?.['w:tr'])) {
        const trPr = tr?.['w:trPr'];
        const isHeader = !!(trPr?.['w:tblHeader']);
        const tblCellSpacing = trPr?.['w:cantSplit'];
        const tblRowHeight = trPr?.['w:trHeight'];
        const height = tblRowHeight ? numAttr(tblRowHeight, 'val') : undefined;

        const cells: CellInfo[] = [];
        for (const tc of arr(tr?.['w:tc'])) {
            const tcPr = tc?.['w:tcPr'];
            const tcW = tcPr?.['w:tcW'];
            const width = tcW ? numAttr(tcW, 'w') : undefined;
            const gridSpanNode = tcPr?.['w:gridSpan'];
            const gridSpan = gridSpanNode ? numAttr(gridSpanNode, 'val') : undefined;
            const vMergeNode = tcPr?.['w:vMerge'];
            const verticalMerge = vMergeNode ? (attr(vMergeNode, 'val') ?? 'continue') : undefined;

            const cellParas: ParagraphInfo[] = [];
            for (const p of arr(tc?.['w:p'])) {
                cellParas.push(parseParagraph(p, globalParaIndex.n++, styleMap));
            }
            cells.push({
                paragraphCount: cellParas.length,
                paragraphs: cellParas,
                width,
                gridSpan,
                verticalMerge,
            });
        }

        rows.push({ cells, isHeader, height });
    }

    const maxCols = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);

    return {
        index: tableIndex,
        rows,
        rowCount: rows.length,
        maxCols,
        hasBorders,
        tableWidth,
        colWidths,
        indent,
        alignment,
    };
}

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

function parsePageLayout(sectPr: any): PageLayout {
    const pgSz = sectPr?.['w:pgSz'];
    const widthTwips = numAttr(pgSz, 'w') ?? 12240;
    const heightTwips = numAttr(pgSz, 'h') ?? 15840;
    const orient = attr(pgSz, 'orient') ?? (heightTwips > widthTwips ? 'portrait' : 'landscape');

    const pgMar = sectPr?.['w:pgMar'];
    const marginTop = numAttr(pgMar, 'top') ?? 1440;
    const marginRight = numAttr(pgMar, 'right') ?? 1440;
    const marginBottom = numAttr(pgMar, 'bottom') ?? 1440;
    const marginLeft = numAttr(pgMar, 'left') ?? 1440;

    const cols = sectPr?.['w:cols'];
    const numCols = cols ? (numAttr(cols, 'num') ?? 1) : 1;
    const colSpaceDefault = cols ? (numAttr(cols, 'space') ?? 720) : 720;
    const colWidths: number[] = [];
    for (const col of arr(cols?.['w:col'])) {
        const w = numAttr(col, 'w');
        if (w !== undefined) colWidths.push(w);
    }

    return {
        widthTwips,
        heightTwips,
        marginTop,
        marginRight,
        marginBottom,
        marginLeft,
        columns: numCols,
        columnWidths: colWidths,
        columnSpacing: colSpaceDefault,
        orientation: orient,
    };
}

// ---------------------------------------------------------------------------
// Full document parse
// ---------------------------------------------------------------------------

function parseDocStructure(documentXml: string, stylesXml: string): DocStructure {
    const styleMap = buildStyleMap(stylesXml);
    const doc = parseXml(documentXml);
    const body = doc?.['w:document']?.['w:body'];

    if (!body) throw new Error('Could not find w:body in document.xml');

    const topLevelParas: ParagraphInfo[] = [];
    const allParagraphs: ParagraphInfo[] = [];
    const tables: TableInfo[] = [];
    const globalParaIndex = { n: 0 };

    // Walk direct children of body in order
    // fast-xml-parser merges same-name siblings, so we need to handle interleaved
    // w:p and w:tbl by using the raw parsed object key order.
    // We'll iterate body's keys to preserve document order.
    const bodyKeys = Object.keys(body).filter(k => k !== '@_' && !k.startsWith('@_'));

    // Build ordered sequence of {type, node} preserving DOM order
    // fast-xml-parser unfortunately loses inter-sibling ordering when tag names
    // differ, but within each tag type the array order is preserved.
    // We'll process w:p and w:tbl pools independently then merge by index is not
    // possible without custom parser. Instead we parse them separately and note
    // the interleaving is best-effort.
    const rawParas = arr(body?.['w:p']);
    const rawTables = arr(body?.['w:tbl']);

    // Parse all top-level paragraphs
    for (const p of rawParas) {
        const info = parseParagraph(p, globalParaIndex.n++, styleMap);
        topLevelParas.push(info);
        allParagraphs.push(info);
    }

    // Parse all tables and collect their paragraphs too
    let tableIdx = 0;
    for (const tbl of rawTables) {
        const tblInfo = parseTable(tbl, tableIdx++, styleMap, globalParaIndex);
        tables.push(tblInfo);
        for (const row of tblInfo.rows) {
            for (const cell of row.cells) {
                allParagraphs.push(...cell.paragraphs);
            }
        }
    }

    // Page layout comes from the last sectPr in body (or a nested one)
    const sectPr = body?.['w:sectPr'];
    const pageLayout = parsePageLayout(sectPr ?? {});

    return { pageLayout, tables, paragraphs: topLevelParas, allParagraphs, styleMap };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const TWIPS_PER_INCH = 1440;
const TWIPS_PER_PT = 20;

function twipsToInches(t: number): string {
    return (t / TWIPS_PER_INCH).toFixed(2) + '"';
}

function twipsToPt(t: number): string {
    return (t / TWIPS_PER_PT).toFixed(1) + 'pt';
}

function halfPtToPt(hp: number): string {
    return (hp / 2).toFixed(1) + 'pt';
}

function printStructureReport(struct: DocStructure, filePath: string): void {
    const { pageLayout, tables, paragraphs, allParagraphs, styleMap } = struct;
    const sep = '─'.repeat(70);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  DOCX STRUCTURE REPORT`);
    console.log(`  File: ${filePath}`);
    console.log(`${'═'.repeat(70)}\n`);

    // ── Page Layout ──────────────────────────────────────────────────────────
    console.log('┌─ PAGE LAYOUT ──────────────────────────────────────────────────────');
    const pl = pageLayout;
    console.log(`│  Page size:    ${twipsToInches(pl.widthTwips)} × ${twipsToInches(pl.heightTwips)}  (${pl.orientation})`);
    console.log(`│  Margins:      top=${twipsToInches(pl.marginTop)}  right=${twipsToInches(pl.marginRight)}  bottom=${twipsToInches(pl.marginBottom)}  left=${twipsToInches(pl.marginLeft)}`);
    if (pl.columns > 1) {
        console.log(`│  *** MULTI-COLUMN: ${pl.columns} columns  default-space=${twipsToInches(pl.columnSpacing)} ***`);
        if (pl.columnWidths.length > 0) {
            console.log(`│  Column widths: ${pl.columnWidths.map(twipsToInches).join(', ')}`);
        }
    } else {
        console.log(`│  Columns:      1 (single-column page)`);
    }
    console.log(`└${'─'.repeat(69)}\n`);

    // ── Style Map (custom styles only) ───────────────────────────────────────
    const customStyles = [...styleMap.values()].filter(
        s => s.type === 'paragraph' && !['Normal', 'DefaultParagraphFont', 'TableNormal', 'NormalTable'].includes(s.name)
    );
    console.log(`┌─ PARAGRAPH STYLES DEFINED IN DOCUMENT (${customStyles.length} custom) ────────────────`);
    for (const s of customStyles.slice(0, 30)) {
        const base = s.basedOn ? ` (based on: ${styleMap.get(s.basedOn)?.name ?? s.basedOn})` : '';
        console.log(`│  [${s.id.padEnd(22)}]  "${s.name}"${base}`);
    }
    if (customStyles.length > 30) console.log(`│  ... and ${customStyles.length - 30} more`);
    console.log(`└${'─'.repeat(69)}\n`);

    // ── Table Structure ───────────────────────────────────────────────────────
    if (tables.length === 0) {
        console.log('┌─ TABLES ───────────────────────────────────────────────────────────');
        console.log('│  No tables found — layout is single-flow (no multi-column table trick)');
        console.log(`└${'─'.repeat(69)}\n`);
    } else {
        console.log(`┌─ TABLES (${tables.length} found) ────────────────────────────────────────────────`);
        for (const tbl of tables) {
            console.log(`│`);
            console.log(`│  Table ${tbl.index + 1}: ${tbl.rowCount} rows × ${tbl.maxCols} cols  borders=${tbl.hasBorders ? 'YES' : 'none (layout table)'}${tbl.tableWidth ? `  width=${twipsToInches(tbl.tableWidth)}` : ''}`);
            if (tbl.colWidths.length > 0) {
                console.log(`│    Grid columns: ${tbl.colWidths.map(twipsToInches).join('  |  ')}`);
            }
            for (const [ri, row] of tbl.rows.entries()) {
                const cellSummaries = row.cells.map((c, ci) => {
                    const nonEmpty = c.paragraphs.filter(p => !p.isEmpty);
                    const widthStr = c.width ? twipsToInches(c.width) : '?';
                    return `Cell[${ci + 1}] ${widthStr} — ${nonEmpty.length} non-empty paras`;
                }).join('  |  ');
                if (tbl.rowCount <= 10 || ri < 3 || ri >= tbl.rowCount - 2) {
                    console.log(`│    Row ${ri + 1}: ${cellSummaries}`);
                } else if (ri === 3) {
                    console.log(`│    ... (${tbl.rowCount - 5} more rows) ...`);
                }
            }
            // Show heading-style paragraphs found inside the table
            const headingParas = tbl.rows.flatMap(r =>
                r.cells.flatMap(c =>
                    c.paragraphs.filter(p => !p.isEmpty && (
                        p.style.toLowerCase().includes('heading') ||
                        p.style.toLowerCase().includes('section') ||
                        p.style.toLowerCase().includes('title') ||
                        p.runs.some(r => r.bold && r.text.trim().length > 2 && p.text.trim().length < 60)
                    ))
                )
            ).slice(0, 20);
            if (headingParas.length > 0) {
                console.log(`│    Likely headings inside table:`);
                for (const p of headingParas) {
                    const sz = p.runs[0]?.fontSize ? ` sz=${halfPtToPt(p.runs[0].fontSize)}` : '';
                    const bold = p.runs.some(r => r.bold) ? ' BOLD' : '';
                    console.log(`│      [${p.style.padEnd(20)}]${bold}${sz}  "${p.text.slice(0, 60)}"`);
                }
            }
        }
        console.log(`└${'─'.repeat(69)}\n`);
    }

    // ── Paragraph Inventory (all paragraphs) ─────────────────────────────────
    const nonEmptyAll = allParagraphs.filter(p => !p.isEmpty);
    console.log(`┌─ PARAGRAPH INVENTORY (${nonEmptyAll.length} non-empty of ${allParagraphs.length} total) ─────────────────────────`);
    console.log(`│  Format: [style_name] (bold?) align sz  "text preview"`);
    console.log(`│  ${sep}`);

    let prevStyle = '';
    for (const p of nonEmptyAll) {
        const bold = p.runs.some(r => r.bold) ? ' B' : '  ';
        const sz = p.runs[0]?.fontSize ? halfPtToPt(p.runs[0].fontSize) : '   ';
        const align = p.alignment.padEnd(8);
        const styleLabel = p.style.padEnd(24);
        const indent = p.indentLeft ? ` ind=${twipsToPt(p.indentLeft)}` : '';
        const preview = p.text.replace(/\s+/g, ' ').slice(0, 65);

        // Insert a blank separator line when style category changes significantly
        if (p.style !== prevStyle && !p.isEmpty) {
            console.log(`│`);
        }
        prevStyle = p.style;

        console.log(`│  [${styleLabel}]${bold} ${align} ${sz.padEnd(7)}${indent}  "${preview}"`);
    }
    console.log(`└${'─'.repeat(69)}\n`);

    // ── Section Detection Summary ─────────────────────────────────────────────
    console.log('┌─ DETECTED SECTION HEADINGS ────────────────────────────────────────');
    const sectionPatterns: Array<{ key: string; re: RegExp }> = [
        { key: 'contact', re: /contact|address|phone|email/i },
        { key: 'summary', re: /summary|objective|profile|about|overview/i },
        { key: 'experience', re: /experience|employment|work history|career/i },
        { key: 'education', re: /education|academic|qualification|degree/i },
        { key: 'skills', re: /skill|expertise|competenc|technolog|proficienc/i },
        { key: 'projects', re: /project|portfolio/i },
        { key: 'awards', re: /award|honor|honour|achievement|recognition/i },
        { key: 'certificates', re: /certif|licen|accredit/i },
        { key: 'languages', re: /language|linguistic/i },
        { key: 'volunteer', re: /volunteer|community|social/i },
        { key: 'references', re: /reference|referee/i },
        { key: 'publications', re: /publication|research|paper/i },
        { key: 'interests', re: /interest|hobby|hobbies|activit/i },
    ];

    const detectedSections: Array<{ key: string; text: string; style: string; bold: boolean; paraIndex: number }> = [];
    for (const p of nonEmptyAll) {
        const trimmed = p.text.trim();
        const isBold = p.runs.some(r => r.bold);
        const isShort = trimmed.length < 70;
        const looksLikeHeading =
            p.style.toLowerCase().includes('heading') ||
            p.style.toLowerCase().includes('section') ||
            p.style.toLowerCase().includes('title') ||
            (isBold && isShort) ||
            (trimmed === trimmed.toUpperCase() && isShort && trimmed.length > 2);

        if (looksLikeHeading) {
            for (const { key, re } of sectionPatterns) {
                if (re.test(trimmed)) {
                    detectedSections.push({ key, text: trimmed, style: p.style, bold: isBold, paraIndex: p.index });
                    break;
                }
            }
        }
    }

    if (detectedSections.length === 0) {
        console.log('│  None detected — may need to refine heading detection patterns');
    } else {
        for (const s of detectedSections) {
            const bold = s.bold ? ' (bold)' : '';
            console.log(`│  [${s.key.padEnd(14)}]  style="${s.style}"${bold}  "${s.text.slice(0, 50)}"`);
        }
    }
    console.log(`└${'─'.repeat(69)}\n`);

    // ── Tab Stop Summary ─────────────────────────────────────────────────────
    const parasWithTabs = nonEmptyAll.filter(p => p.tabs.length > 0);
    if (parasWithTabs.length > 0) {
        console.log(`┌─ TAB STOPS (${parasWithTabs.length} paragraphs use custom tabs) ─────────────────────────────`);
        const tabPositions = new Map<number, number>();
        for (const p of parasWithTabs) {
            for (const t of p.tabs) {
                tabPositions.set(t.pos, (tabPositions.get(t.pos) ?? 0) + 1);
            }
        }
        const sorted = [...tabPositions.entries()].sort((a, b) => b[1] - a[1]);
        for (const [pos, count] of sorted.slice(0, 10)) {
            console.log(`│  pos=${twipsToInches(pos)} (${pos} twips)  used by ${count} paras`);
        }
        console.log(`└${'─'.repeat(69)}\n`);
    }

    // ── Font Size Distribution ────────────────────────────────────────────────
    const sizeFreq = new Map<number, number>();
    for (const p of nonEmptyAll) {
        for (const r of p.runs) {
            if (r.fontSize) {
                sizeFreq.set(r.fontSize, (sizeFreq.get(r.fontSize) ?? 0) + 1);
            }
        }
    }
    if (sizeFreq.size > 0) {
        console.log('┌─ FONT SIZE DISTRIBUTION ───────────────────────────────────────────');
        const sortedSizes = [...sizeFreq.entries()].sort((a, b) => b[1] - a[1]);
        for (const [sz, count] of sortedSizes.slice(0, 10)) {
            const bar = '█'.repeat(Math.min(30, Math.round(count / 2)));
            console.log(`│  ${halfPtToPt(sz).padEnd(8)}  (sz=${String(sz).padEnd(4)})  ${bar}  ${count} runs`);
        }
        console.log(`└${'─'.repeat(69)}\n`);
    }

    console.log(`${'═'.repeat(70)}`);
    console.log(`  SUMMARY`);
    console.log(`  Top-level (outside tables): ${paragraphs.length} paras`);
    console.log(`  Inside tables:              ${allParagraphs.length - paragraphs.length} paras`);
    console.log(`  Tables:                     ${tables.length}${tables.length > 0 ? ` (${tables.map(t => `${t.maxCols}-col`).join(', ')})` : ''}`);
    console.log(`  Page columns (sectPr):      ${pageLayout.columns}`);
    console.log(`  Detected sections:          ${detectedSections.map(s => s.key).join(', ') || 'none'}`);
    console.log(`${'═'.repeat(70)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const docxPath = argv.find(a => !a.startsWith('-')) ??
        path.resolve(process.cwd(), 'inputs/job_templates/resume_template_1.docx');

    if (!fs.existsSync(docxPath)) {
        console.error(`File not found: ${docxPath}`);
        process.exit(1);
    }

    let PizZip: new (data: Buffer | string, options?: Record<string, unknown>) => any;
    try {
        PizZip = require('pizzip');
    } catch {
        console.error('pizzip not installed. Run: npm install pizzip fast-xml-parser');
        process.exit(1);
    }

    console.log(`Loading: ${docxPath}`);
    const content = fs.readFileSync(docxPath, 'binary');
    const zip = new PizZip(content, { base64: false });

    const documentXml = zip.files['word/document.xml']?.asText();
    const stylesXml = zip.files['word/styles.xml']?.asText();

    if (!documentXml) throw new Error('word/document.xml not found in DOCX');
    if (!stylesXml) console.warn('word/styles.xml not found — style names will be raw IDs');

    const struct = parseDocStructure(documentXml, stylesXml ?? '<w:styles/>');
    printStructureReport(struct, docxPath);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
