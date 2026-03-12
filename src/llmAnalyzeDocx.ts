#!/usr/bin/env node
/**
 * llmAnalyzeDocx.ts — Use an LLM to semantically identify every structural
 * element in a DOCX resume: header fields, section types, layout patterns,
 * indentation, table column roles, font hierarchy, etc.
 *
 * This script is a diagnostic / development tool.  It produces:
 *   outputs/llm_docx_analysis/<basename>.analysis.json  — LLM structural JSON
 *   outputs/llm_docx_analysis/<basename>.replica.docx   — visual test replica
 *
 * Usage:
 *   tsx src/llmAnalyzeDocx.ts [path/to/template.docx] [--provider github-copilot]
 *   npm run test:llm-docx
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, BorderStyle,
} from 'docx';

// ---------------------------------------------------------------------------
// Types — LLM output schema
// ---------------------------------------------------------------------------

export interface FieldDef {
    semanticRole: string;   // name | title | technologies | location | residency |
    // email | phone | linkedin | github | portfolio | unknown
    bold: boolean;
    fontSize?: number;      // pt
    sample: string;         // text snippet from original
}

export interface TableColDef {
    role: string;           // e.g. "skill-level-label" | "skill-list" | "cert-year-group"
    widthPct?: number;
}

export interface SectionDef {
    key: string;            // summary | experience | education | skills | certifications | interests | …
    heading: string;        // exact heading text from doc
    headingBold: boolean;
    headingFontSize?: number;
    contentLayout:
    | 'indented-bullets'
    | 'two-column-table'
    | 'flat-paragraphs'
    | 'definition-list';
    indentPt?: number;
    contentBold?: boolean;
    table?: {
        rows: number;
        cols: number;
        columns: TableColDef[];
    };
    sampleItems: string[];
}

export interface DocxAnalysis {
    pageLayout: {
        widthIn: number;
        heightIn: number;
        marginsIn: { top: number; right: number; bottom: number; left: number };
        columns: number;
    };
    header: {
        layout: 'two-column-table' | 'single-column';
        left: FieldDef[];
        right: FieldDef[];
    };
    sections: SectionDef[];
    notes: string;   // LLM free-text observations
}

// ---------------------------------------------------------------------------
// DOCX XML extraction (pizzip)
// ---------------------------------------------------------------------------

function extractXmlText(docxPath: string): { paragraphSummary: string; tablesSummary: string; styleNames: string[] } {
    let PizZip: new (data: Buffer) => any;
    try { PizZip = require('pizzip'); }
    catch { throw new Error('pizzip not installed. Run: npm install pizzip fast-xml-parser'); }

    const { XMLParser } = require('fast-xml-parser');
    const zip = new PizZip(fs.readFileSync(docxPath));
    const documentXml: string = zip.files['word/document.xml'].asText();
    const stylesXml: string = zip.files['word/styles.xml']?.asText() ?? '';

    // ── Build style id → name map ─────────────────────────────────────────
    const styleMap = new Map<string, string>();
    if (stylesXml) {
        const sp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: () => false });
        const sd = sp.parse(stylesXml);
        const styles = sd?.['w:styles']?.['w:style'];
        for (const s of (Array.isArray(styles) ? styles : [styles]).filter(Boolean)) {
            const id = s?.['@_w:styleId'] ?? '';
            const nameNode = s?.['w:name'];
            const name = typeof nameNode === 'object' ? (nameNode?.['@_w:val'] ?? id) : (nameNode ?? id);
            if (id) styleMap.set(id, name);
        }
    }

    // ── Parse document body ───────────────────────────────────────────────
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (tag: string) => ['w:p', 'w:r', 'w:tr', 'w:tc', 'w:t', 'w:tbl', 'w:gridCol'].includes(tag),
    });
    const doc = parser.parse(documentXml);
    const body = doc?.['w:document']?.['w:body'];
    if (!body) throw new Error('Could not find w:body in document.xml');

    const styleNames: string[] = [...new Set(
        [...styleMap.values()].filter(n => !['Normal', 'DefaultParagraphFont', 'NormalTable', 'TableNormal'].includes(n))
    )];

    // ── Summarise a paragraph to one line ────────────────────────────────
    function summarisePara(p: any, prefix = ''): string {
        const pPr = p?.['w:pPr'];
        const styleId = pPr?.['w:pStyle']?.['@_w:val'] ?? '';
        const styleName = styleMap.get(styleId) ?? 'normal';
        const ind = pPr?.['w:ind'];
        const indLeft = ind ? (parseInt(ind?.['@_w:left'] ?? '0', 10) / 20).toFixed(0) : '0';
        const jc = pPr?.['w:jc']?.['@_w:val'] ?? 'left';
        const spacing = pPr?.['w:spacing'];
        const spaceBefore = spacing ? Math.round(parseInt(spacing?.['@_w:before'] ?? '0', 10) / 20) : 0;

        let text = '';
        let bold = false;
        let sz: number | undefined;
        for (const r of (Array.isArray(p?.['w:r']) ? p['w:r'] : [])) {
            const rPr = r?.['w:rPr'];
            if (rPr?.['w:b'] !== undefined) bold = true;
            const szNode = rPr?.['w:sz'];
            if (szNode) sz = Math.round(parseInt(szNode?.['@_w:val'] ?? '0', 10) / 2);
            for (const t of (Array.isArray(r?.['w:t']) ? r['w:t'] : [r?.['w:t']]).filter(Boolean)) {
                text += typeof t === 'string' ? t : (t?.['#text'] ?? '');
            }
        }
        // Also pick up hyperlink runs
        for (const hl of (Array.isArray(p?.['w:hyperlink']) ? p['w:hyperlink'] : [p?.['w:hyperlink']]).filter(Boolean)) {
            for (const r of (Array.isArray(hl?.['w:r']) ? hl['w:r'] : [])) {
                for (const t of (Array.isArray(r?.['w:t']) ? r['w:t'] : [r?.['w:t']]).filter(Boolean)) {
                    text += typeof t === 'string' ? t : (t?.['#text'] ?? '');
                }
            }
        }

        if (!text.trim()) return '';
        const boldMark = bold ? ' BOLD' : '';
        const szMark = sz ? ` sz=${sz}pt` : '';
        const indMark = parseInt(indLeft) > 0 ? ` ind=${indLeft}pt` : '';
        const spMark = spaceBefore > 0 ? ` spaceBefore=${spaceBefore}pt` : '';
        const preview = text.slice(0, 80).replace(/\n/g, ' ');
        return `${prefix}  [${styleName}]${boldMark}${szMark}${indMark}${spMark}  "${preview}"`;
    }

    // ── Walk body ─────────────────────────────────────────────────────────
    const paraLines: string[] = [];
    const tableLines: string[] = [];

    // Top-level paragraphs
    for (const p of (Array.isArray(body?.['w:p']) ? body['w:p'] : [])) {
        const line = summarisePara(p);
        if (line) paraLines.push(line);
    }

    // Tables
    let tIdx = 0;
    for (const tbl of (Array.isArray(body?.['w:tbl']) ? body['w:tbl'] : [])) {
        tIdx++;
        const tblPr = tbl?.['w:tblPr'];
        const tblW = tblPr?.['w:tblW'];
        const width = tblW ? (parseInt(tblW?.['@_w:w'] ?? '0', 10) / 1440).toFixed(2) : '?';
        const tblBorders = tblPr?.['w:tblBorders'];
        let hasBorder = false;
        if (tblBorders) {
            for (const side of ['top', 'left', 'bottom', 'right']) {
                const v = tblBorders?.[`w:${side}`]?.['@_w:val'];
                if (v && v !== 'nil' && v !== 'none') { hasBorder = true; break; }
            }
        }
        const rows = Array.isArray(tbl?.['w:tr']) ? tbl['w:tr'] : [];
        const numCols = rows.reduce((m: number, r: any) => Math.max(m, (Array.isArray(r?.['w:tc']) ? r['w:tc'] : []).length), 0);
        const colWidths: string[] = [];
        for (const gc of (Array.isArray(tbl?.['w:tblGrid']?.['w:gridCol']) ? tbl['w:tblGrid']['w:gridCol'] : [])) {
            const w = parseInt(gc?.['@_w:w'] ?? '0', 10);
            colWidths.push((w / 1440).toFixed(2) + '"');
        }
        tableLines.push(`\nTable ${tIdx}: ${rows.length} rows × ${numCols} cols  width=${width}"  borders=${hasBorder ? 'yes' : 'none'}  col-widths=[${colWidths.join(', ')}]`);

        rows.forEach((tr: any, ri: number) => {
            const cells = Array.isArray(tr?.['w:tc']) ? tr['w:tc'] : [];
            tableLines.push(`  Row ${ri + 1}:`);
            cells.forEach((tc: any, ci: number) => {
                const tcW = tc?.['w:tcPr']?.['w:tcW'];
                const cellW = tcW ? (parseInt(tcW?.['@_w:w'] ?? '0', 10) / 1440).toFixed(2) : '?';
                tableLines.push(`    Cell[${ci + 1}] width=${cellW}":`);
                for (const p of (Array.isArray(tc?.['w:p']) ? tc['w:p'] : [])) {
                    const line = summarisePara(p, '  ');
                    if (line) tableLines.push('  ' + line);
                }
            });
        });
    }

    return {
        paragraphSummary: paraLines.join('\n'),
        tablesSummary: tableLines.join('\n'),
        styleNames,
    };
}

// ---------------------------------------------------------------------------
// LLM call (reuses pattern from llmTailorResume.ts)
// ---------------------------------------------------------------------------

interface ProviderCfg {
    model: string;
    apiKeyEnv: string;
    baseUrl: string;
    maxTokens: number;
    temperature: number;
}

function httpsPost(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
        }, res => {
            const chunks: Buffer[] = [];
            res.on('data', (d: Buffer) => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 400)
                    reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                else resolve(JSON.parse(raw));
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function callLlm(cfg: ProviderCfg, systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing env var: ${cfg.apiKeyEnv}`);

    // GitHub Models / OpenAI-compatible endpoint
    const url = `${cfg.baseUrl}/chat/completions`;
    const resp = await httpsPost(url, { Authorization: `Bearer ${apiKey}` }, {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });

    const content = resp.choices?.[0]?.message?.content ?? '';
    if (resp.usage) {
        console.log(`  Tokens: ${resp.usage.prompt_tokens} prompt + ${resp.usage.completion_tokens} completion`);
    }
    return content;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert document-structure analyst specialising in DOCX resumes.
You receive a machine-readable dump of a DOCX file's paragraph and table structure and must return a JSON object that precisely describes the semantic layout.
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON.`;

function buildAnalysisPrompt(
    paragraphSummary: string,
    tablesSummary: string,
    styleNames: string[],
): string {
    return `Analyse the following DOCX resume structure dump and return a JSON object matching the schema below.

=== PARAGRAPH STYLES DEFINED ===
${styleNames.join(', ') || '(only Normal)'}

=== TOP-LEVEL PARAGRAPHS (outside tables, in document order) ===
${paragraphSummary || '(none)'}

=== TABLES (in document order) ===
${tablesSummary || '(none)'}

=== REQUIRED OUTPUT SCHEMA ===
Return a single JSON object with this exact shape:

{
  "pageLayout": {
    "widthIn": <number>,
    "heightIn": <number>,
    "marginsIn": { "top": <number>, "right": <number>, "bottom": <number>, "left": <number> },
    "columns": <number>
  },
  "header": {
    "layout": "two-column-table" | "single-column",
    "left": [
      {
        "semanticRole": "name|title|technologies|tagline|unknown",
        "bold": true|false,
        "fontSize": <number|null>,
        "sample": "<text from dump>"
      }
    ],
    "right": [
      {
        "semanticRole": "location|residency|email|phone|linkedin|github|portfolio|unknown",
        "bold": true|false,
        "fontSize": <number|null>,
        "sample": "<text from dump>"
      }
    ]
  },
  "sections": [
    {
      "key": "summary|experience|education|skills|certifications|interests|volunteer|references|<other>",
      "heading": "<exact heading text>",
      "headingBold": true|false,
      "headingFontSize": <number|null>,
      "contentLayout": "indented-bullets|two-column-table|flat-paragraphs|definition-list",
      "indentPt": <number|null>,
      "contentBold": true|false|null,
      "table": <null | {
        "rows": <number>,
        "cols": <number>,
        "columns": [
          { "role": "<description of this column's role>", "widthPct": <approximate % of table width> }
        ]
      }>,
      "sampleItems": ["<first item>", "<second item>"]
    }
  ],
  "notes": "<any important observations about the layout that don't fit the schema above>"
}

IMPORTANT rules:
- "header" refers to the name/contact block at the very top of the resume.  It may be inside Table 1.
- Map every field in the header table to its semantic role.  Common roles: name, title, technologies (tech stack tagline), location, residency (visa/citizenship status), email, phone, linkedin, github, portfolio.
- Only include sections that appear AFTER the header.
- For tables used as layout containers (skills grid, certs split by year), set contentLayout="two-column-table" and fill in the "table" field.
- Font sizes come from sz= markers in the dump (already converted to pt).
- indentPt is the indent= value from the dump (already in pt).
- Use null for optional numeric fields when not present in the dump.`;
}

// ---------------------------------------------------------------------------
// Replica DOCX generator from LLM analysis
// ---------------------------------------------------------------------------

const IN = (i: number) => Math.round(i * 1440);
const PT = (p: number) => Math.round(p * 20);
const SZ = (p: number) => Math.round(p * 2);

const PLACEHOLDER: Record<string, string> = {
    name: 'Jordan Lee',
    title: 'Senior Cloud Engineer',
    technologies: 'Python · TypeScript · AWS · Terraform · Kubernetes · Postgres',
    tagline: 'Building reliable distributed systems since 2016',
    location: 'Brisbane, QLD',
    residency: 'Australian Citizen',
    email: 'jordan.lee@placeholder.io',
    phone: '+61 400 222 333',
    linkedin: 'linkedin.com/in/jordanlee',
    github: 'github.com/jordanlee',
    portfolio: 'jordanlee.dev',
    unknown: '—',
};

const SECTION_CONTENT: Record<string, string[]> = {
    summary: [
        'Pragmatic engineer with 8+ years designing and operating cloud-native platforms at scale.',
        'Deep ownership mindset — led a full platform migration from on-prem to AWS over 18 months.',
        'Passionate about observability, developer experience, and eliminating toil through automation.',
    ],
    experience: [
        'Placeholder Corp   Senior Cloud Engineer   Mar 2021 – PRESENT',
        'Tech: Python, TypeScript, AWS ECS, RDS, SQS, Terraform, GitHub Actions.',
        'Key contributions:',
        'Reduced infrastructure provisioning time from 3 days to 30 minutes with reusable Terraform modules.',
        'Designed multi-region active-active setup for the payments service targeting 99.99% SLA.',
        'Introduced OpenTelemetry-based tracing, cutting mean time to diagnose incidents by 65%.',
    ],
    education: [
        'BEng, Software Engineering   (GPA 6.7/7.0)   2013 – 2016',
        'Sample University',
        'Queensland Higher School Certificate (ATAR 94)   2012',
    ],
    skills: [
        'Expert: Python, TypeScript, AWS, Terraform, PostgreSQL, Docker, Kubernetes',
        'Proficient: Go, Redis, GitHub Actions, Datadog, Grafana, REST & GraphQL',
        'Familiar: Rust, MongoDB, Azure, GCP, Ansible',
    ],
    certifications: [
        'AWS Solutions Architect – Professional (2024)',
        'AWS DevOps Engineer – Professional (2023)',
        'Terraform Associate (HashiCorp, 2023)',
        'Docker & Kubernetes: The Practical Guide (Udemy, 2022)',
    ],
    interests: [
        'Open-source: maintain tern-cli, a thin Terraform wrapper used by 400+ teams.',
        'Reading: recent favourites include "Accelerate" and "The Phoenix Project".',
        'Sport: Brazilian jiu-jitsu (purple belt) and weekend trail running.',
    ],
    volunteer: [
        'Code mentor at CoderDojo Brisbane — weekly sessions teaching Python to teenagers.',
        'Tech reviewer for Manning Publications (2022–present).',
    ],
    references: ['References available upon request.'],
};

function fallbackItems(key: string): string[] {
    return SECTION_CONTENT[key] ?? SECTION_CONTENT['summary'];
}

function makePara(text: string, opts: { bold?: boolean; sz?: number; indent?: number } = {}): Paragraph {
    return new Paragraph({
        indent: opts.indent ? { left: opts.indent } : undefined,
        children: [new TextRun({ text, bold: opts.bold ?? false, size: opts.sz ? SZ(opts.sz) : undefined })],
    });
}

function makeEmpty(): Paragraph {
    return new Paragraph({ children: [new TextRun('')] });
}

function buildHeaderSection(header: DocxAnalysis['header']): Table | Paragraph[] {
    if (header.layout === 'two-column-table') {
        // Estimate column widths by typical proportion
        const totalWidth = IN(7.5);
        const leftWidth = IN(4.5);
        const rightWidth = totalWidth - leftWidth;

        const leftParas = header.left.map(f =>
            new Paragraph({
                children: [new TextRun({
                    text: PLACEHOLDER[f.semanticRole] ?? f.sample ?? PLACEHOLDER.unknown,
                    bold: f.bold,
                    size: f.fontSize ? SZ(f.fontSize) : undefined,
                })]
            })
        );

        const rightParas = header.right.map(f => {
            const label: Record<string, string> = {
                email: 'Email: ', phone: 'Phone: ',
                linkedin: 'LinkedIn: ', github: 'GitHub: ', portfolio: 'Portfolio: ',
            };
            const prefix = label[f.semanticRole] ?? '';
            return new Paragraph({
                children: [new TextRun({
                    text: prefix + (PLACEHOLDER[f.semanticRole] ?? f.sample ?? PLACEHOLDER.unknown),
                    bold: f.bold,
                    size: f.fontSize ? SZ(f.fontSize) : undefined,
                })]
            });
        });

        const border = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
        const borders = { top: border, bottom: border, left: border, right: border };

        return new Table({
            width: { size: totalWidth, type: WidthType.DXA },
            rows: [new TableRow({
                children: [
                    new TableCell({ borders, width: { size: leftWidth, type: WidthType.DXA }, children: leftParas }),
                    new TableCell({ borders, width: { size: rightWidth, type: WidthType.DXA }, children: rightParas }),
                ]
            })],
        });
    }

    // Single column fallback
    return [...header.left, ...header.right].map(f =>
        makePara(PLACEHOLDER[f.semanticRole] ?? f.sample ?? '', { bold: f.bold, sz: f.fontSize ?? undefined })
    );
}

function buildSection(sec: SectionDef): Array<Table | Paragraph> {
    const items = fallbackItems(sec.key);
    const result: Array<Table | Paragraph> = [];

    result.push(makeEmpty());
    result.push(makePara(sec.heading, {
        bold: sec.headingBold,
        sz: sec.headingFontSize ?? undefined,
    }));

    if (sec.contentLayout === 'two-column-table' && sec.table) {
        const { rows, cols } = sec.table;
        const totalWidth = IN(7.5);
        // Use detected column proportions if available, else 30/70 split
        const colWidths = sec.table.columns.map(c =>
            Math.round(totalWidth * ((c.widthPct ?? (100 / cols)) / 100))
        );
        // Ensure we always have the right count
        while (colWidths.length < cols) colWidths.push(Math.round(totalWidth / cols));
        const border = { style: BorderStyle.SINGLE, size: 6, color: '000000' };
        const borders = { top: border, bottom: border, left: border, right: border };

        // Split items into rows
        const itemsPerRow = Math.ceil(items.length / rows);
        const tableRows: TableRow[] = [];
        for (let r = 0; r < rows; r++) {
            const rowItems = items.slice(r * itemsPerRow, (r + 1) * itemsPerRow);
            const cells = sec.table.columns.map((col, ci) => {
                // left column = label, right column = list
                const cellText = ci === 0
                    ? (col.role.toLowerCase().includes('label') || col.role.includes('level') || col.role.includes('proficiency')
                        ? ['Expert', 'Proficient', 'Familiar'][r] ?? `Level ${r + 1}`
                        : (rowItems[0]?.split(':')[0] ?? `Group ${r + 1}`))
                    : rowItems.map(i => i.split(':').slice(1).join(':').trim() || i).join('; ');

                return new TableCell({
                    borders,
                    width: { size: colWidths[ci] ?? Math.round(totalWidth / cols), type: WidthType.DXA },
                    children: [new Paragraph({
                        children: [new TextRun({ text: cellText, bold: ci === 0 })],
                    })],
                });
            });
            tableRows.push(new TableRow({ children: cells }));
        }
        result.push(new Table({ width: { size: totalWidth, type: WidthType.DXA }, rows: tableRows }));

    } else {
        // paragraphs / bullets
        for (const item of items) {
            result.push(makePara(item, {
                bold: sec.contentBold ?? false,
                indent: sec.indentPt ? PT(sec.indentPt) : undefined,
            }));
        }
    }

    return result;
}

async function generateReplicaDocx(analysis: DocxAnalysis, outPath: string): Promise<void> {
    const ma = analysis.pageLayout.marginsIn;
    const bodyChildren: Array<Table | Paragraph> = [];

    // Header
    const headerEl = buildHeaderSection(analysis.header);
    if (Array.isArray(headerEl)) bodyChildren.push(...headerEl);
    else bodyChildren.push(headerEl);

    // Sections
    for (const sec of analysis.sections) {
        bodyChildren.push(...buildSection(sec));
    }

    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: { width: IN(analysis.pageLayout.widthIn), height: IN(analysis.pageLayout.heightIn) },
                    margin: { top: IN(ma.top), right: IN(ma.right), bottom: IN(ma.bottom), left: IN(ma.left) },
                },
            },
            children: bodyChildren,
        }],
    });

    const buf = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buf);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Analyse a DOCX template with the LLM.
 * If a cached analysis JSON already exists it is loaded directly (no LLM call).
 * @param docxPath     Absolute path to the .docx template file.
 * @param providerName LLM provider key (defaults to 'github-copilot'). Must match an entry in config/llm_providers.json.
 * @returns Parsed DocxAnalysis object.
 */
export async function analyzeDocxTemplate(
    docxPath: string,
    providerName = 'github-copilot',
): Promise<DocxAnalysis> {
    const baseName = path.basename(docxPath, '.docx');
    const cacheDir = path.resolve(process.cwd(), 'outputs/llm_docx_analysis');
    const analysisPath = path.join(cacheDir, `${baseName}.analysis.json`);

    // Use cached result if available
    if (fs.existsSync(analysisPath)) {
        console.log(`  [llmAnalyzeDocx] Loading cached analysis: ${analysisPath}`);
        return JSON.parse(fs.readFileSync(analysisPath, 'utf-8')) as DocxAnalysis;
    }

    // Load provider config from config/llm_providers.json (shared global registry)
    const providersPath = path.resolve(process.cwd(), 'config/llm_providers.json');
    if (!fs.existsSync(providersPath)) {
        throw new Error(`LLM providers config not found: ${providersPath}`);
    }
    const providersFile = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
    const providerCfg: ProviderCfg = providersFile.providers?.[providerName];
    if (!providerCfg) {
        const available = Object.keys(providersFile.providers ?? {}).join(', ');
        throw new Error(`Provider "${providerName}" not found in ${providersPath}. Available: ${available}`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });

    console.log(`  [llmAnalyzeDocx] Extracting structure from: ${docxPath}`);
    const { paragraphSummary, tablesSummary, styleNames } = extractXmlText(docxPath);
    const userPrompt = buildAnalysisPrompt(paragraphSummary, tablesSummary, styleNames);

    console.log(`  [llmAnalyzeDocx] Calling LLM (${providerName} / ${providerCfg.model})...`);
    const rawJson = await callLlm(providerCfg, SYSTEM_PROMPT, userPrompt);

    let analysis: DocxAnalysis;
    try {
        analysis = JSON.parse(rawJson);
    } catch (e) {
        console.error('LLM returned invalid JSON:', rawJson.slice(0, 500));
        throw e;
    }
    fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
    console.log(`  [llmAnalyzeDocx] Analysis saved: ${analysisPath}`);
    return analysis;
}

// ---------------------------------------------------------------------------
// Main (standalone CLI)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const docxPath = argv.find(a => !a.startsWith('-'))
        ?? path.resolve(process.cwd(), 'inputs/job_templates/resume_template_2.docx');

    const providerName = (argv.find(a => a.startsWith('--provider='))?.split('=')[1])
        ?? (argv[argv.indexOf('--provider') + 1])
        ?? 'github-copilot';

    // Output paths
    const baseName = path.basename(docxPath, '.docx');
    const outDir = path.resolve(process.cwd(), 'outputs/llm_docx_analysis');
    const replicaPath = path.join(outDir, `${baseName}.replica.docx`);

    // Analyse (uses cached JSON if already exists)
    const analysis = await analyzeDocxTemplate(docxPath, providerName);
    console.log('\nAnalysis ready.');

    // Print summary
    console.log('\n── LLM ANALYSIS SUMMARY ────────────────────────────────────────────');
    console.log(`Header layout: ${analysis.header.layout}`);
    console.log('Header LEFT:');
    for (const f of analysis.header.left)
        console.log(`  [${f.semanticRole.padEnd(14)}] bold=${f.bold}  sz=${f.fontSize ?? '-'}pt  "${f.sample?.slice(0, 50)}"`);
    console.log('Header RIGHT:');
    for (const f of analysis.header.right)
        console.log(`  [${f.semanticRole.padEnd(14)}] bold=${f.bold}  sz=${f.fontSize ?? '-'}pt  "${f.sample?.slice(0, 50)}"`);
    console.log(`\nSections (${analysis.sections.length}):`);
    for (const s of analysis.sections)
        console.log(`  [${s.key.padEnd(16)}] "${s.heading}"  layout=${s.contentLayout}${s.table ? `  table=${s.table.rows}×${s.table.cols}` : ''}`);
    if (analysis.notes) console.log(`\nNotes: ${analysis.notes}`);
    console.log('────────────────────────────────────────────────────────────────────');

    // 5. Generate replica DOCX
    console.log('\nGenerating replica DOCX...');
    await generateReplicaDocx(analysis, replicaPath);
    console.log(`Replica saved: ${replicaPath}`);
    console.log('Open in Word/LibreOffice to visually verify the layout matches the original.');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
