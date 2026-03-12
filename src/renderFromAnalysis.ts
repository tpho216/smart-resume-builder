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
import type { DocxAnalysis, FieldDef, SectionDef } from './llmAnalyzeDocx.js';
import type { JsonResume } from './types.js';

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------
const FONT = 'Calibri';
const MARGIN = convertInchesToTwip(0.5);
const PAGE_W = convertInchesToTwip(7.5);   // 8.5" − 2×0.5" margins

const BORDER_SOLID = {
    top: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    left: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    right: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
};

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

function p(text: string, bold = false, sizePt = 11, indentTwip = 0): Paragraph {
    return new Paragraph({
        indent: indentTwip ? { left: indentTwip } : undefined,
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: stripHtml(text), font: FONT, size: sizePt * 2, bold })],
    });
}

function sectionHeading(text: string, fontSize = 14): Paragraph {
    return new Paragraph({
        spacing: { before: 160, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2563EB' } },
        children: [new TextRun({ text, font: FONT, size: fontSize * 2, bold: true, color: '2563EB' })],
    });
}

function empty(): Paragraph {
    return new Paragraph({ children: [new TextRun({ text: '', font: FONT, size: 22 })] });
}

function fixedTable(colWidths: number[], rowsData: Paragraph[][]): Table {
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    return new Table({
        width: { size: totalW, type: WidthType.DXA },
        columnWidths: colWidths,
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({
            children: colWidths.map((w, i) =>
                new TableCell({
                    borders: BORDER_SOLID,
                    width: { size: w, type: WidthType.DXA },
                    children: rowsData[i] ?? [p('')],
                })
            ),
        })],
    });
}

function multiRowFixedTable(colWidths: number[], rowsData: Paragraph[][][]): Table {
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    return new Table({
        width: { size: totalW, type: WidthType.DXA },
        columnWidths: colWidths,
        layout: TableLayoutType.FIXED,
        rows: rowsData.map(rowCells =>
            new TableRow({
                children: colWidths.map((w, i) =>
                    new TableCell({
                        borders: BORDER_SOLID,
                        width: { size: w, type: WidthType.DXA },
                        children: rowCells[i] ?? [p('')],
                    })
                ),
            })
        ),
    });
}

// ---------------------------------------------------------------------------
// Build header table from DocxAnalysis.header
// ---------------------------------------------------------------------------
function buildHeader(header: DocxAnalysis['header']): Table {
    const lw = convertInchesToTwip(4.5);
    const rw = PAGE_W - lw;

    function fieldPara(f: FieldDef): Paragraph {
        const text = ROLE_PLACEHOLDER[f.semanticRole] ?? ROLE_PLACEHOLDER['unknown'];
        const sz = f.fontSize ?? 11;
        return p(text, f.bold, sz);
    }

    if (header.layout === 'two-column-table') {
        return fixedTable([lw, rw], [
            header.left.map(fieldPara),
            header.right.map(fieldPara),
        ]);
    }

    // single-column fallback
    const allFields = [...header.left, ...header.right];
    const lw2 = PAGE_W;
    return new Table({
        width: { size: lw2, type: WidthType.DXA },
        columnWidths: [lw2],
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({
            children: [new TableCell({
                borders: BORDER_SOLID,
                width: { size: lw2, type: WidthType.DXA },
                children: allFields.map(fieldPara),
            })],
        })],
    });
}

// ---------------------------------------------------------------------------
// Build body blocks from a SectionDef
// ---------------------------------------------------------------------------
function buildSection(sec: SectionDef): Array<Paragraph | Table> {
    const result: Array<Paragraph | Table> = [];
    result.push(empty());
    result.push(sectionHeading(sec.heading, sec.headingFontSize ?? 14));

    const indTwip = sec.indentPt ? Math.round(sec.indentPt * 20) : 0;
    const bold = sec.contentBold ?? false;
    const raw = SECTION_PLACEHOLDER[sec.key];

    switch (sec.contentLayout) {
        // ── flat paragraphs ─────────────────────────────────────────────
        case 'flat-paragraphs': {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            lines.forEach(line => result.push(p(line, bold, 11, indTwip)));
            break;
        }

        // ── indented bullets ────────────────────────────────────────────
        case 'indented-bullets': {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            // First item may be a job/role heading (not indented)
            lines.forEach((line, i) => {
                const isHeading = i === 0 && /–|•/.test(line);
                result.push(p(line, isHeading || bold, 11, isHeading ? 0 : indTwip));
            });
            break;
        }

        // ── two-column table ────────────────────────────────────────────
        case 'two-column-table': {
            const cols = sec.table?.columns ?? [{ widthPct: 50 }, { widthPct: 50 }];
            const total = cols.reduce((s, c) => s + (c.widthPct ?? 50), 0) || 100;
            const colWidths = cols.map(c => Math.round(PAGE_W * ((c.widthPct ?? 50) / total)));
            // Fix rounding drift
            const diff = PAGE_W - colWidths.reduce((a, b) => a + b, 0);
            colWidths[colWidths.length - 1] += diff;

            // Skills: array of [label, skills] tuples
            if (sec.key === 'skills') {
                const rows = SECTION_PLACEHOLDER.skills as unknown as [string, string][];
                result.push(multiRowFixedTable(colWidths, rows.map(([l, s]) => [
                    [p(l, true, 11)],
                    [p(s, false, 11)],
                ])));
            }
            // Certifications: array of parallel column items
            else if (sec.key === 'certifications') {
                const colItems = SECTION_PLACEHOLDER.certifications as unknown as string[][];
                // colItems[0] = headers row, rest = data rows
                const colParas: Paragraph[][] = colWidths.map((_, ci) =>
                    colItems.map((row, ri) => p(row[ci] ?? '', ri === 0, 11))
                );
                result.push(fixedTable(colWidths, colParas));
            }
            // Generic: split sample items across columns
            else {
                const items = (raw as string[] | undefined) ?? fallback(sec.key);
                const mid = Math.ceil(items.length / colWidths.length);
                const colParas = colWidths.map((_, ci) =>
                    items.slice(ci * mid, (ci + 1) * mid).map(t => p(t, bold, 11))
                );
                result.push(fixedTable(colWidths, colParas));
            }
            break;
        }

        default: {
            const lines = (raw as string[] | undefined) ?? fallback(sec.key);
            lines.forEach(line => result.push(p(line, bold, 11)));
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
function buildSectionFromResume(sec: SectionDef, resume: JsonResume): Array<Paragraph | Table> {
    const result: Array<Paragraph | Table> = [];
    result.push(empty());
    result.push(sectionHeading(sec.heading, sec.headingFontSize ?? 14));

    const indTwip = sec.indentPt ? Math.round(sec.indentPt * 20) : 0;
    const bold = sec.contentBold ?? false;
    const key = sec.key.toLowerCase();

    switch (sec.contentLayout) {
        case 'flat-paragraphs': {
            flatLines(key, resume).forEach(line => result.push(p(line, bold, 11, indTwip)));
            break;
        }
        case 'indented-bullets': {
            bulletItems(key, resume).forEach((item, i) => {
                const isHeading = i === 0 || /[–•]/.test(item.charAt(0)) === false && (resume.work ?? []).some(w => item.startsWith(w.name));
                result.push(p(item, isHeading || bold, 11, isHeading ? 0 : indTwip));
            });
            break;
        }
        case 'two-column-table': {
            const cols = sec.table?.columns ?? [{ widthPct: 50 }, { widthPct: 50 }];
            const total = cols.reduce((s, c) => s + (c.widthPct ?? 50), 0) || 100;
            const colW = cols.map(c => Math.round(PAGE_W * ((c.widthPct ?? 50) / total)));
            colW[colW.length - 1] += PAGE_W - colW.reduce((a, b) => a + b, 0); // fix rounding

            if (key === 'skills' || key === 'core skills') {
                const skillRows = (resume.skills ?? []).map(s =>
                    [[p(s.name, true, 11)], [p(s.keywords.join(', '), false, 11)]] as [Paragraph[], Paragraph[]]
                );
                result.push(multiRowFixedTable(colW, skillRows));
            } else if (/certif|courses/.test(key)) {
                const certs = (resume.certificates ?? []).map(c =>
                    `${c.name}${c.issuer ? ` (${c.issuer}${c.date ? `, ${c.date}` : ''})` : ''}`
                );
                const mid = Math.ceil(certs.length / 2);
                result.push(fixedTable(colW, [
                    certs.slice(0, mid).map(t => p(t, false, 11)),
                    certs.slice(mid).map(t => p(t, false, 11)),
                ]));
            } else {
                const items = SECTION_PLACEHOLDER[key] ?? fallback(key);
                const mid = Math.ceil(items.length / 2);
                result.push(fixedTable(colW, [
                    items.slice(0, mid).map(t => p(t, bold, 11)),
                    items.slice(mid).map(t => p(t, bold, 11)),
                ]));
            }
            break;
        }
        default: {
            flatLines(key, resume).forEach(line => result.push(p(line, bold, 11)));
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
    // Header
    const lw = convertInchesToTwip(4.5);
    const rw = PAGE_W - lw;

    function fieldPara(f: FieldDef): Paragraph {
        const text = (resumeFieldForRole(f.semanticRole, resume) || ROLE_PLACEHOLDER[f.semanticRole]) ?? '—';
        return p(text, f.bold, f.fontSize ?? 11);
    }

    let headerEl: Table | Paragraph[];
    if (analysis.header.layout === 'two-column-table') {
        headerEl = fixedTable([lw, rw], [
            analysis.header.left.map(fieldPara),
            analysis.header.right.map(fieldPara),
        ]);
    } else {
        headerEl = [...analysis.header.left, ...analysis.header.right].map(fieldPara);
    }

    const children: Array<Paragraph | Table> = Array.isArray(headerEl)
        ? [...headerEl]
        : [headerEl];

    for (const sec of analysis.sections) {
        children.push(...buildSectionFromResume(sec, resume));
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: {
                        width: convertInchesToTwip(analysis.pageLayout?.widthIn ?? 8.5),
                        height: convertInchesToTwip(analysis.pageLayout?.heightIn ?? 11),
                    },
                    margin: {
                        top: convertInchesToTwip(analysis.pageLayout?.marginsIn?.top ?? 0.5),
                        right: convertInchesToTwip(analysis.pageLayout?.marginsIn?.right ?? 0.5),
                        bottom: convertInchesToTwip(analysis.pageLayout?.marginsIn?.bottom ?? 0.5),
                        left: convertInchesToTwip(analysis.pageLayout?.marginsIn?.left ?? 0.5),
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

    const children: Array<Paragraph | Table> = [
        buildHeader(analysis.header),
        ...analysis.sections.flatMap(sec => buildSection(sec)),
    ];

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: {
                        width: convertInchesToTwip(analysis.pageLayout?.widthIn ?? 8.5),
                        height: convertInchesToTwip(analysis.pageLayout?.heightIn ?? 11),
                    },
                    margin: {
                        top: convertInchesToTwip(analysis.pageLayout?.marginsIn?.top ?? 0.5),
                        right: convertInchesToTwip(analysis.pageLayout?.marginsIn?.right ?? 0.5),
                        bottom: convertInchesToTwip(analysis.pageLayout?.marginsIn?.bottom ?? 0.5),
                        left: convertInchesToTwip(analysis.pageLayout?.marginsIn?.left ?? 0.5),
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
