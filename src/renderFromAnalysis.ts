#!/usr/bin/env node
/**
 * renderFromAnalysis.ts
 *
 * Reads a DocxAnalysis JSON (produced by llmAnalyzeDocx.ts) and renders
 * a DOCX file — either a placeholder preview (CLI) or a real resume
 * mapped from a JsonResume object (pipeline integration).
 */

import fs from 'fs';
import path from 'path';
import {
    Document, Packer, Paragraph, TextRun,
    Table, TableRow, TableCell,
    WidthType, BorderStyle, TableLayoutType,
    convertInchesToTwip,
} from 'docx';
import type { DocxAnalysis, FieldDef, SectionDef, CellBorders, CellBorder } from './llmAnalyzeDocx.js';
import type { JsonResume } from './types.js';

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------
const FALLBACK_FONT = 'Calibri';  // Only used if analysis has no font data
const DEFAULT_MARGIN = convertInchesToTwip(0.5);
const DEFAULT_PAGE_W = convertInchesToTwip(7.5);   // 8.5" − 2×0.5" margins

/**
 * Extract the most commonly used font from the analysis.
 * Checks header fields and section headings to determine the template's primary font.
 */
function extractDefaultFont(analysis: DocxAnalysis): string {
    const fontCounts: Record<string, number> = {};

    // Count fonts in header
    [...analysis.header.left, ...analysis.header.right].forEach(f => {
        if (f.fontFamily) fontCounts[f.fontFamily] = (fontCounts[f.fontFamily] || 0) + 1;
    });

    // Count fonts in section headings and content
    analysis.sections.forEach(s => {
        if (s.headingFontFamily) fontCounts[s.headingFontFamily] = (fontCounts[s.headingFontFamily] || 0) + 2;
        if (s.contentFontFamily) fontCounts[s.contentFontFamily] = (fontCounts[s.contentFontFamily] || 0) + 1;
    });

    // Find most common font
    const entries = Object.entries(fontCounts);
    if (entries.length === 0) return FALLBACK_FONT;

    const [font] = entries.reduce((a, b) => a[1] > b[1] ? a : b);
    return font;
}

/**
 * Convert alignment value from analysis format to docx library format.
 * Maps 'justify' to 'both' since the docx library uses 'both' for justified text.
 */
function normalizeAlignment(alignment?: 'left' | 'center' | 'right' | 'justify' | 'both' | 'distribute'): 'left' | 'center' | 'right' | 'both' | 'distribute' | undefined {
    if (alignment === 'justify') return 'both';
    return alignment as 'left' | 'center' | 'right' | 'both' | 'distribute' | undefined;
}

const BORDER_SOLID = {
    top: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    left: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    right: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
};

const BORDER_NONE = {
    top: { style: BorderStyle.NONE, size: 0 },
    bottom: { style: BorderStyle.NONE, size: 0 },
    left: { style: BorderStyle.NONE, size: 0 },
    right: { style: BorderStyle.NONE, size: 0 },
};

function createBorders(borderStyle: string, color?: string, widthPt?: number) {
    const sz = widthPt ? Math.round(widthPt * 8) : 6;
    const col = color || '000000';
    const border = { style: BorderStyle.SINGLE, size: sz, color: col };

    switch (borderStyle) {
        case 'all':
            return {
                top: border,
                bottom: border,
                left: border,
                right: border,
            };
        case 'horizontal':
            return {
                top: border,
                bottom: border,
                left: { style: BorderStyle.NONE, size: 0 },
                right: { style: BorderStyle.NONE, size: 0 },
            };
        case 'vertical':
            return {
                top: { style: BorderStyle.NONE, size: 0 },
                bottom: { style: BorderStyle.NONE, size: 0 },
                left: border,
                right: border,
            };
        default:
            return BORDER_NONE;
    }
}

// ---------------------------------------------------------------------------
// Placeholder content by semantic role / section key
// ---------------------------------------------------------------------------
const ROLE_PLACEHOLDER: Record<string, string> = {
    name: 'Alex Smith',
    title: 'Backend Developer',
    technologies: 'Node.js · TypeScript · AWS · Docker · PostgreSQL',
    location: 'Melbourne, VIC',
    residency: 'Australian Citizen',
    email: 'alex.smith@placeholder.io',
    phone: '+61 400 111 222',
    linkedin: 'linkedin.com/in/alexsmith',
    github: 'github.com/alexsmith',
    portfolio: 'alexsmith.dev',
    unknown: '—',
};

const SECTION_PLACEHOLDER: Record<string, string[]> = {
    summary: [
        'Results-driven backend developer with 3+ years shipping high-throughput REST APIs.',
        'Strong ownership mindset — rewrote a legacy billing service solo, cutting p99 latency 2s → 180ms.',
        'Passionate about clean architecture, observability, and developer experience.',
    ],
    skills: [
        ['Expert', 'TypeScript, Python, PostgreSQL, Node.js, REST APIs, Docker, Git, GitHub Actions'],
        ['Proficient', 'React, Next.js, Redis, Terraform, AWS Lambda & ECS, Jest, OpenTelemetry'],
        ['Familiar', 'Go, Kubernetes, MongoDB, GraphQL, Azure, Datadog, Ansible'],
    ] as unknown as string[],
    experience: [
        'Placeholder Tech  –  Backend Engineer  •  Jan 2023 – PRESENT',
        'Rewrote legacy billing service in TypeScript, cutting p99 latency from 2s to 180ms.',
        'Designed self-serve onboarding API adopted by 12 enterprise clients.',
        'Introduced contract testing (Pact), reducing CI integration failures by 60%.',
        'Built real-time webhook delivery with exponential back-off and dead-letter queues.',
    ],
    education: [
        'BSc, Computer Science  (GPA 6.8 / 7.0)  2018 – 2021',
        'Placeholder University',
        'Graduated with distinction; Dean\'s List 2019–2021.',
    ],
    certifications: [
        ['Completed in 2024:', 'Completed in 2025:'],
        ['AWS Solutions Architect – Associate', 'AWS Developer – Associate'],
        ['Node.js: The Complete Guide (Udemy)', 'Terraform: Getting Started'],
        ['Docker & Kubernetes: The Practical Guide', 'Advanced TypeScript (Frontend Masters)'],
    ] as unknown as string[],
    interests: [
        'Reading technical books — recent favourite: Designing Data-Intensive Applications.',
        'Open-source contributions; maintain a small CLI for local AWS Lambda testing.',
        'Brazilian jiu-jitsu (blue belt), trail running, and recreational rock climbing.',
    ],
};

function fallback(key: string): string[] {
    return [`[Placeholder content for section: ${key}]`];
}

// ---------------------------------------------------------------------------
// Low-level builders (fixed-table pattern)
// ---------------------------------------------------------------------------

/** Remove any HTML tags the LLM may have accidentally injected (e.g. <p>…</p>). */
function stripHtml(s: string): string {
    return s.replace(/<[^>]*>/g, '').replace(/\n+/g, ' ').trim();
}

interface ParagraphOptions {
    text: string;
    bold?: boolean;
    sizePt?: number;
    indentTwip?: number;
    font?: string | null;  // null means use default from analysis
    color?: string | null;  // null means use default black
    alignment?: 'left' | 'center' | 'right' | 'justify' | 'both' | 'distribute';  // Accept both analysis and docx formats
    spacingBefore?: number;
    spacingAfter?: number;
    lineSpacing?: number;
    defaultFont?: string;  // Template's default font from analysis
}

function p(text: string, bold?: boolean, sizePt?: number, indentTwip?: number): Paragraph;
function p(opts: ParagraphOptions): Paragraph;
function p(
    textOrOpts: string | ParagraphOptions,
    bold = false,
    sizePt = 11,
    indentTwip = 0
): Paragraph {
    let opts: ParagraphOptions;
    if (typeof textOrOpts === 'string') {
        opts = { text: textOrOpts, bold, sizePt, indentTwip };
    } else {
        opts = textOrOpts;
    }

    const spacing: any = {
        before: opts.spacingBefore !== undefined ? Math.round(opts.spacingBefore * 20) : 0,
        after: opts.spacingAfter !== undefined ? Math.round(opts.spacingAfter * 20) : 60,
    };
    if (opts.lineSpacing) {
        spacing.line = Math.round(opts.lineSpacing * 240);
        spacing.lineRule = 'auto';
    }

    // Use font from options, or default from analysis, or fallback
    const font = opts.font === null ? (opts.defaultFont || FALLBACK_FONT) : (opts.font || opts.defaultFont || FALLBACK_FONT);
    // Use color from options; null means default black
    const color = opts.color === null ? undefined : opts.color;

    return new Paragraph({
        indent: opts.indentTwip ? { left: opts.indentTwip } : undefined,
        alignment: normalizeAlignment(opts.alignment),
        spacing,
        children: [new TextRun({
            text: stripHtml(opts.text),
            font,
            size: (opts.sizePt || 11) * 2,
            bold: opts.bold || false,
            color,
        })],
    });
}

interface SectionHeadingOptions {
    text: string;
    fontSize?: number;
    font?: string | null;  // null means use default from analysis
    color?: string | null;  // null means use default
    bold?: boolean;
    alignment?: 'left' | 'center' | 'right' | 'justify' | 'both' | 'distribute';  // Accept both analysis and docx formats
    spacingBefore?: number;
    spacingAfter?: number;
    defaultFont?: string;  // Template's default font from analysis
}

function sectionHeading(text: string, fontSize?: number): Paragraph;
function sectionHeading(opts: SectionHeadingOptions): Paragraph;
function sectionHeading(
    textOrOpts: string | SectionHeadingOptions,
    fontSize = 14
): Paragraph {
    let opts: SectionHeadingOptions;
    if (typeof textOrOpts === 'string') {
        opts = { text: textOrOpts, fontSize };
    } else {
        opts = textOrOpts;
    }

    const color = opts.color === null ? '2563EB' : (opts.color || '2563EB');
    const spaceBefore = opts.spacingBefore !== undefined ? Math.round(opts.spacingBefore * 20) : 160;
    const spaceAfter = opts.spacingAfter !== undefined ? Math.round(opts.spacingAfter * 20) : 80;

    // Use font from options, or default from analysis, or fallback
    const font = opts.font === null ? (opts.defaultFont || FALLBACK_FONT) : (opts.font || opts.defaultFont || FALLBACK_FONT);

    return new Paragraph({
        alignment: normalizeAlignment(opts.alignment),
        spacing: { before: spaceBefore, after: spaceAfter },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color } },
        children: [new TextRun({
            text: opts.text,
            font,
            size: (opts.fontSize || 14) * 2,
            bold: opts.bold !== undefined ? opts.bold : true,
            color,
        })],
    });
}

function empty(defaultFont?: string): Paragraph {
    return new Paragraph({ children: [new TextRun({ text: '', font: defaultFont || FALLBACK_FONT, size: 20 })] });
}

interface TableStyleOptions {
    borders?: string;
    borderColor?: string;
    borderWidthPt?: number;
    cellPaddingPt?: number;
    shading?: string;
    /** Per-column explicit cell borders from analysis; takes priority over table-level `borders` */
    perCellBorders?: Array<CellBorders | undefined>;
}

/** Convert a single CellBorder side from the analysis to a docx border entry */
function cellBorderSideToDocx(side: CellBorder | undefined): { style: any; size: number; color?: string } {
    if (!side || side.val === 'nil' || side.val === 'none') {
        return { style: BorderStyle.NONE, size: 0 };
    }
    if (side.color === 'ffffff') {
        return { style: BorderStyle.NONE, size: 0 };
    }
    return {
        style: BorderStyle.SINGLE,
        size: side.widthPt ? Math.round(side.widthPt * 8) : 6,
        color: side.color || '000000',
    };
}

/** Convert a full CellBorders (T/R/B/L) from the analysis to a docx borders map */
function cellBordersToDocx(cb: CellBorders): { top: any; bottom: any; left: any; right: any } {
    return {
        top: cellBorderSideToDocx(cb.top),
        bottom: cellBorderSideToDocx(cb.bottom),
        left: cellBorderSideToDocx(cb.left),
        right: cellBorderSideToDocx(cb.right),
    };
}

function fixedTable(
    colWidths: number[],
    rowsData: Paragraph[][],
    styleOpts?: TableStyleOptions
): Table {
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const borders = styleOpts?.borders
        ? createBorders(styleOpts.borders, styleOpts.borderColor, styleOpts.borderWidthPt)
        : BORDER_NONE;  // Default to no borders to match clean resume templates
    const cellPadding = styleOpts?.cellPaddingPt
        ? Math.round(styleOpts.cellPaddingPt * 20)
        : undefined;

    return new Table({
        width: { size: totalW, type: WidthType.DXA },
        columnWidths: colWidths,
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({
            children: colWidths.map((w, i) => {
                const perCell = styleOpts?.perCellBorders?.[i];
                const cellBorders = perCell ? cellBordersToDocx(perCell) : borders;
                const cellOpts: any = {
                    borders: cellBorders,
                    width: { size: w, type: WidthType.DXA },
                    children: rowsData[i] ?? [p('')],
                };
                if (cellPadding) {
                    cellOpts.margins = {
                        top: cellPadding,
                        bottom: cellPadding,
                        left: cellPadding,
                        right: cellPadding,
                    };
                }
                if (styleOpts?.shading) {
                    cellOpts.shading = { fill: styleOpts.shading };
                }
                return new TableCell(cellOpts);
            }),
        })],
    });
}

function multiRowFixedTable(
    colWidths: number[],
    rowsData: Paragraph[][][],
    styleOpts?: TableStyleOptions
): Table {
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const borders = styleOpts?.borders
        ? createBorders(styleOpts.borders, styleOpts.borderColor, styleOpts.borderWidthPt)
        : BORDER_NONE;  // Default to no borders to match clean resume templates
    const cellPadding = styleOpts?.cellPaddingPt
        ? Math.round(styleOpts.cellPaddingPt * 20)
        : undefined;

    return new Table({
        width: { size: totalW, type: WidthType.DXA },
        columnWidths: colWidths,
        layout: TableLayoutType.FIXED,
        rows: rowsData.map(rowCells =>
            new TableRow({
                children: colWidths.map((w, i) => {
                    const perCell = styleOpts?.perCellBorders?.[i];
                    const cellBorders = perCell ? cellBordersToDocx(perCell) : borders;
                    const cellOpts: any = {
                        borders: cellBorders,
                        width: { size: w, type: WidthType.DXA },
                        children: rowCells[i] ?? [p('')],
                    };
                    if (cellPadding) {
                        cellOpts.margins = {
                            top: cellPadding,
                            bottom: cellPadding,
                            left: cellPadding,
                            right: cellPadding,
                        };
                    }
                    if (styleOpts?.shading) {
                        cellOpts.shading = { fill: styleOpts.shading };
                    }
                    return new TableCell(cellOpts);
                }),
            })
        ),
    });
}

// ---------------------------------------------------------------------------
// Build header table from DocxAnalysis.header
// ---------------------------------------------------------------------------
function buildHeader(header: DocxAnalysis['header'], pageWidth: number = DEFAULT_PAGE_W, defaultFont?: string): Table {
    // Calculate column widths
    let lw: number, rw: number;
    if (header.table?.columnWidthsPct && header.table.columnWidthsPct.length >= 2) {
        const total = header.table.columnWidthsPct[0] + header.table.columnWidthsPct[1];
        lw = Math.round(pageWidth * (header.table.columnWidthsPct[0] / total));
        rw = pageWidth - lw;
    } else {
        lw = convertInchesToTwip(4.5);
        rw = pageWidth - lw;
    }

    function fieldPara(f: FieldDef): Paragraph {
        const text = ROLE_PLACEHOLDER[f.semanticRole] ?? ROLE_PLACEHOLDER['unknown'];
        return p({
            text,
            bold: f.bold,
            sizePt: f.fontSize ?? 10,
            font: f.fontFamily,
            color: f.color,
            defaultFont,
        });
    }

    const tableStyle = header.table?.style;

    if (header.layout === 'two-column-table') {
        return fixedTable(
            [lw, rw],
            [
                header.left.map(fieldPara),
                header.right.map(fieldPara),
            ],
            tableStyle
        );
    }

    // single-column fallback
    const allFields = [...header.left, ...header.right];
    return fixedTable([pageWidth], [allFields.map(fieldPara)], tableStyle);
}

// ---------------------------------------------------------------------------
// Build body blocks from a SectionDef
// ---------------------------------------------------------------------------
function buildSection(sec: SectionDef, pageWidth: number = DEFAULT_PAGE_W, defaultFont?: string): Array<Paragraph | Table> {
    const result: Array<Paragraph | Table> = [];
    result.push(empty(defaultFont));
    result.push(sectionHeading({
        text: sec.heading,
        fontSize: sec.headingFontSize,
        font: sec.headingFontFamily,
        color: sec.headingColor,
        bold: sec.headingBold,
        alignment: sec.headingAlignment,
        spacingBefore: sec.headingSpacingBeforePt,
        spacingAfter: sec.headingSpacingAfterPt,
        defaultFont,
    }));

    const indTwip = sec.indentPt ? Math.round(sec.indentPt * 20) : 0;
    const bold = sec.contentBold ?? false;
    const fontSize = sec.contentFontSize ?? 10;
    const font = sec.contentFontFamily;
    const color = sec.contentColor;
    const alignment = sec.contentAlignment;
    const spacingBefore = sec.contentSpacingBeforePt;
    const lineSpacing = sec.contentLineSpacingMultiple;
    const raw = SECTION_PLACEHOLDER[sec.key];

    // Helper to create content paragraph with section styling
    const contentP = (text: string, overrideBold?: boolean, overrideIndent?: number) => p({
        text,
        bold: overrideBold !== undefined ? overrideBold : bold,
        sizePt: fontSize,
        font,
        color,
        alignment,
        indentTwip: overrideIndent !== undefined ? overrideIndent : indTwip,
        spacingBefore,
        lineSpacing,
        defaultFont,
    });

    switch (sec.contentLayout) {
        // ── flat paragraphs ─────────────────────────────────────────────
        case 'flat-paragraphs': {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            lines.forEach(line => result.push(contentP(line)));
            break;
        }

        // ── indented bullets ────────────────────────────────────────────
        case 'indented-bullets': {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            // First item may be a job/role heading (not indented)
            lines.forEach((line, i) => {
                const isHeading = i === 0 && /–|•/.test(line);
                result.push(contentP(line, isHeading || bold, isHeading ? 0 : undefined));
            });
            break;
        }

        // ── two-column table ────────────────────────────────────────────
        case 'two-column-table': {
            const cols: import('./llmAnalyzeDocx.js').TableColDef[] =
                (sec.table?.columns ?? [{ widthPct: 50 }, { widthPct: 50 }]) as import('./llmAnalyzeDocx.js').TableColDef[];
            const total = cols.reduce((s, c) => s + (c.widthPct ?? 50), 0) || 100;
            const colWidths = cols.map(c => Math.round(pageWidth * ((c.widthPct ?? 50) / total)));
            // Fix rounding drift
            const diff = pageWidth - colWidths.reduce((a, b) => a + b, 0);
            colWidths[colWidths.length - 1] += diff;

            // Merge table-level style with per-column cellBorders from analysis
            const tableStyle: TableStyleOptions = {
                ...sec.table?.style,
                perCellBorders: cols.map(c => c.cellBorders),
            };

            // Skills: array of [label, skills] tuples
            if (sec.key === 'skills') {
                const rows = SECTION_PLACEHOLDER.skills as unknown as [string, string][];
                result.push(multiRowFixedTable(colWidths, rows.map(([l, s]) => [
                    [contentP(l, true)],
                    [contentP(s, false)],
                ]), tableStyle));
            }
            // Certifications: array of parallel column items
            else if (sec.key === 'certifications') {
                const colItems = SECTION_PLACEHOLDER.certifications as unknown as string[][];
                // colItems[0] = headers row, rest = data rows
                const colParas: Paragraph[][] = colWidths.map((_, ci) =>
                    colItems.map((row, ri) => contentP(row[ci] ?? '', ri === 0))
                );
                result.push(fixedTable(colWidths, colParas, tableStyle));
            }
            // Generic: split sample items across columns
            else {
                const items = (raw as string[] | undefined) ?? fallback(sec.key);
                const mid = Math.ceil(items.length / colWidths.length);
                const colParas = colWidths.map((_, ci) =>
                    items.slice(ci * mid, (ci + 1) * mid).map(t => contentP(t))
                );
                result.push(fixedTable(colWidths, colParas, tableStyle));
            }
            break;
        }

        default: {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            lines.forEach(line => result.push(contentP(line)));
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Real-resume renderer (exported for pipeline integration)
// ---------------------------------------------------------------------------

/** Maps a semantic header role to the real value from a JsonResume. */
function resumeFieldForRole(role: string, resume: JsonResume): string {
    const b = resume.basics;
    switch (role) {
        case 'name': return b?.name ?? '';
        case 'title': return b?.label ?? '';
        case 'technologies': return resume.skills?.slice(0, 5).map(s => s.name).join(' · ') ?? b?.label ?? '';
        case 'tagline': return b?.summary?.split('.')[0] ?? '';
        case 'location': return [b?.location?.city, b?.location?.region].filter(Boolean).join(', ');
        case 'residency': return b?.profiles?.find((pr: { network: string; username?: string }) => /residency|citizen|visa/i.test(pr.network))?.username ?? '';
        case 'email': return b?.email ?? '';
        case 'phone': return b?.phone ?? '';
        case 'linkedin': return b?.profiles?.find((pr: { network: string; url: string }) => /linkedin/i.test(pr.network))?.url ?? '';
        case 'github': return b?.profiles?.find((pr: { network: string; url: string }) => /github/i.test(pr.network))?.url ?? '';
        case 'portfolio': return b?.url ?? '';
        default: return '';
    }
}

/** Build flat paragraph lines for prose sections (summary, education). */
function flatLines(key: string, resume: JsonResume): string[] {
    if (key === 'summary') {
        const s = resume.basics?.summary ?? '';
        return s.split(/\.\s+/).filter(Boolean).map(l => l.endsWith('.') ? l : l + '.');
    }
    if (key === 'education') {
        const lines: string[] = [];
        for (const e of resume.education ?? []) {
            const dates = [e.startDate, e.endDate].filter(Boolean).join(' – ');
            const gpa = e.score ? `  (GPA ${e.score})` : '';
            lines.push(`${e.studyType ?? ''} ${e.area ?? ''}${gpa}  ${dates}`.trim());
            lines.push(e.institution);
        }
        return lines;
    }
    return SECTION_PLACEHOLDER[key] ?? fallback(key);
}

/** Build bullet items for experience / interests sections. */
function bulletItems(key: string, resume: JsonResume): string[] {
    if (key === 'experience' || key === 'relevant experience') {
        const items: string[] = [];
        for (const w of resume.work ?? []) {
            const dates = [w.startDate, w.endDate ?? 'PRESENT'].filter(Boolean).join(' – ');
            items.push(`${w.name}  –  ${w.position}  •  ${dates}`);
            if (w.summary) items.push(w.summary);
            for (const h of w.highlights ?? []) items.push(h);
        }
        return items;
    }
    if (key === 'interests' || key === 'hobbies and interests' || key === 'hobbies') {
        return (resume.interests ?? []).map(i =>
            i.keywords?.length ? `${i.name}: ${i.keywords.join(', ')}.` : i.name
        );
    }
    return SECTION_PLACEHOLDER[key] ?? fallback(key);
}

/** Build DOCX section children from a SectionDef using real resume data. */
function buildSectionFromResume(sec: SectionDef, resume: JsonResume, pageWidth: number = DEFAULT_PAGE_W, defaultFont?: string): Array<Paragraph | Table> {
    const result: Array<Paragraph | Table> = [];
    result.push(empty(defaultFont));
    result.push(sectionHeading({
        text: sec.heading,
        fontSize: sec.headingFontSize,
        font: sec.headingFontFamily,
        color: sec.headingColor,
        bold: sec.headingBold,
        alignment: sec.headingAlignment,
        spacingBefore: sec.headingSpacingBeforePt,
        spacingAfter: sec.headingSpacingAfterPt,
        defaultFont,
    }));

    const indTwip = sec.indentPt ? Math.round(sec.indentPt * 20) : 0;
    const bold = sec.contentBold ?? false;
    const fontSize = sec.contentFontSize ?? 10;
    const font = sec.contentFontFamily;
    const color = sec.contentColor;
    const alignment = sec.contentAlignment;
    const spacingBefore = sec.contentSpacingBeforePt;
    const lineSpacing = sec.contentLineSpacingMultiple;
    const key = sec.key.toLowerCase();

    // Helper to create content paragraph with section styling
    const contentP = (text: string, overrideBold?: boolean, overrideIndent?: number) => p({
        text,
        bold: overrideBold !== undefined ? overrideBold : bold,
        sizePt: fontSize,
        font,
        color,
        alignment,
        indentTwip: overrideIndent !== undefined ? overrideIndent : indTwip,
        spacingBefore,
        lineSpacing,
        defaultFont,
    });

    switch (sec.contentLayout) {
        case 'flat-paragraphs': {
            flatLines(key, resume).forEach(line => result.push(contentP(line)));
            break;
        }
        case 'indented-bullets': {
            bulletItems(key, resume).forEach((item, i) => {
                const isHeading = i === 0 || /[–•]/.test(item.charAt(0)) === false && (resume.work ?? []).some(w => item.startsWith(w.name));
                result.push(contentP(item, isHeading || bold, isHeading ? 0 : undefined));
            });
            break;
        }
        case 'two-column-table': {
            const cols: import('./llmAnalyzeDocx.js').TableColDef[] =
                (sec.table?.columns ?? [{ widthPct: 50 }, { widthPct: 50 }]) as import('./llmAnalyzeDocx.js').TableColDef[];
            const total = cols.reduce((s, c) => s + (c.widthPct ?? 50), 0) || 100;
            const colW = cols.map(c => Math.round(pageWidth * ((c.widthPct ?? 50) / total)));
            colW[colW.length - 1] += pageWidth - colW.reduce((a, b) => a + b, 0); // fix rounding

            // Merge table-level style with per-column cellBorders from analysis
            const tableStyle: TableStyleOptions = {
                ...sec.table?.style,
                perCellBorders: cols.map(c => c.cellBorders),
            };

            if (key === 'skills' || key === 'core skills') {
                const skillRows = (resume.skills ?? []).map(s =>
                    [[contentP(s.name, true)], [contentP(s.keywords.join(', '), false)]] as [Paragraph[], Paragraph[]]
                );
                result.push(multiRowFixedTable(colW, skillRows, tableStyle));
            } else if (/certif|courses/.test(key)) {
                const certs = (resume.certificates ?? []).map(c =>
                    `${c.name}${c.issuer ? ` (${c.issuer}${c.date ? `, ${c.date}` : ''})` : ''}`
                );
                const mid = Math.ceil(certs.length / 2);
                result.push(fixedTable(colW, [
                    certs.slice(0, mid).map(t => contentP(t)),
                    certs.slice(mid).map(t => contentP(t)),
                ], tableStyle));
            } else {
                const items = SECTION_PLACEHOLDER[key] ?? fallback(key);
                const mid = Math.ceil(items.length / 2);
                result.push(fixedTable(colW, [
                    items.slice(0, mid).map(t => contentP(t)),
                    items.slice(mid).map(t => contentP(t)),
                ], tableStyle));
            }
            break;
        }
        default: {
            flatLines(key, resume).forEach(line => result.push(contentP(line)));
        }
    }

    return result;
}

/**
 * Render a tailored JsonResume into a DOCX whose layout mirrors the structure
 * described by the DocxAnalysis (produced by llmAnalyzeDocx.ts).
 *
 * Tables use FIXED layout + explicit columnWidths so columns render at full
 * width in both Word and LibreOffice.
 *
 * @param analysis  DocxAnalysis JSON produced by analyzeDocxTemplate().
 * @param resume    Tailored JsonResume to embed as real content.
 * @param outPath   Absolute path for the output .docx file.
 */
export async function renderDocxFromAnalysis(
    analysis: DocxAnalysis,
    resume: JsonResume,
    outPath: string,
): Promise<void> {
    // Extract default font from analysis
    const defaultFont = extractDefaultFont(analysis);

    // Calculate page width from analysis
    const pageWidthIn = analysis.pageLayout?.widthIn ?? 8.5;
    const marginLeft = analysis.pageLayout?.marginsIn?.left ?? 0.5;
    const marginRight = analysis.pageLayout?.marginsIn?.right ?? 0.5;
    const contentWidth = pageWidthIn - marginLeft - marginRight;
    const pageWidth = convertInchesToTwip(contentWidth);

    // Build header with resume data
    function fieldPara(f: FieldDef): Paragraph {
        const text = (resumeFieldForRole(f.semanticRole, resume) || ROLE_PLACEHOLDER[f.semanticRole]) ?? '—';
        return p({
            text,
            bold: f.bold,
            sizePt: f.fontSize ?? 10,
            font: f.fontFamily,
            color: f.color,
            defaultFont,
        });
    }

    // Calculate column widths for header
    let lw: number, rw: number;
    if (analysis.header.table?.columnWidthsPct && analysis.header.table.columnWidthsPct.length >= 2) {
        const total = analysis.header.table.columnWidthsPct[0] + analysis.header.table.columnWidthsPct[1];
        lw = Math.round(pageWidth * (analysis.header.table.columnWidthsPct[0] / total));
        rw = pageWidth - lw;
    } else {
        lw = convertInchesToTwip(contentWidth * 0.6);
        rw = pageWidth - lw;
    }

    const tableStyle = analysis.header.table?.style;

    let headerEl: Table | Paragraph[];
    if (analysis.header.layout === 'two-column-table') {
        headerEl = fixedTable(
            [lw, rw],
            [
                analysis.header.left.map(fieldPara),
                analysis.header.right.map(fieldPara),
            ],
            tableStyle
        );
    } else {
        headerEl = [...analysis.header.left, ...analysis.header.right].map(fieldPara);
    }

    const children: Array<Paragraph | Table> = Array.isArray(headerEl)
        ? [...headerEl]
        : [headerEl];

    for (const sec of analysis.sections) {
        children.push(...buildSectionFromResume(sec, resume, pageWidth, defaultFont));
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: {
                        width: convertInchesToTwip(pageWidthIn),
                        height: convertInchesToTwip(analysis.pageLayout?.heightIn ?? 11),
                    },
                    margin: {
                        top: convertInchesToTwip(analysis.pageLayout?.marginsIn?.top ?? 0.5),
                        right: convertInchesToTwip(marginRight),
                        bottom: convertInchesToTwip(analysis.pageLayout?.marginsIn?.bottom ?? 0.5),
                        left: convertInchesToTwip(marginLeft),
                    },
                },
            },
            children,
        }],
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const buf = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buf);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const inPath = argv[0] ?? path.resolve(process.cwd(),
        'outputs/llm_docx_analysis/resume_template_2.analysis.json');
    const outPath = argv[1] ?? path.resolve(process.cwd(),
        `outputs/rendered_from_analysis/${path.basename(inPath, '.analysis.json')}.docx`);

    if (!fs.existsSync(inPath)) {
        console.error(`Analysis JSON not found: ${inPath}`);
        console.error('Run "npm run test:llm-docx" first to generate it.');
        process.exit(1);
    }

    const analysis: DocxAnalysis = JSON.parse(fs.readFileSync(inPath, 'utf8'));

    // Extract default font from analysis
    const defaultFont = extractDefaultFont(analysis);

    // Calculate page width from analysis
    const pageWidthIn = analysis.pageLayout?.widthIn ?? 8.5;
    const marginLeft = analysis.pageLayout?.marginsIn?.left ?? 0.5;
    const marginRight = analysis.pageLayout?.marginsIn?.right ?? 0.5;
    const contentWidth = pageWidthIn - marginLeft - marginRight;
    const pageWidth = convertInchesToTwip(contentWidth);

    const children: Array<Paragraph | Table> = [
        buildHeader(analysis.header, pageWidth, defaultFont),
        ...analysis.sections.flatMap(sec => buildSection(sec, pageWidth, defaultFont)),
    ];

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: {
                        width: convertInchesToTwip(pageWidthIn),
                        height: convertInchesToTwip(analysis.pageLayout?.heightIn ?? 11),
                    },
                    margin: {
                        top: convertInchesToTwip(analysis.pageLayout?.marginsIn?.top ?? 0.5),
                        right: convertInchesToTwip(marginRight),
                        bottom: convertInchesToTwip(analysis.pageLayout?.marginsIn?.bottom ?? 0.5),
                        left: convertInchesToTwip(marginLeft),
                    },
                },
            },
            children,
        }],
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const buf = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buf);
    console.log(`Analysis:  ${inPath}`);
    console.log(`Rendered:  ${outPath}`);
    console.log(`Sections:  ${analysis.sections.map(s => s.key).join(', ')}`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
