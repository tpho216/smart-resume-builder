#!/usr/bin/env node
/**
 * buildDocxTemplate.ts
 *
 * Two-phase script driven by OpenAI analysis:
 *
 *   Phase 1 — Analysis  (--analyze or default when no _mapping.json exists)
 *     Extract a human-readable skeleton of the DOCX, then ask OpenAI to
 *     produce a DocxMapping JSON that maps every DOCX element to the
 *     corresponding JsonResume field.  Saves <basename>_mapping.json.
 *
 *   Phase 2 — Injection  (always runs after analysis)
 *     Reads the mapping, performs XML surgery on the source DOCX to inject
 *     docxtemplater {placeholders}, and saves <basename>_tpl.docx.
 *
 *   Phase 3 — Verification  (--verify flag)
 *     Renders the template with the base resume, compares key field values
 *     against the original DOCX, and reports mismatches.
 *
 * Usage:
 *   npm run build:tpl -- inputs/resume_templates/resume_template_2.docx [--verify]
 *   npm run build:tpl -- inputs/resume_templates/resume_template_2.docx --analyze   # force re-analysis
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import readline from 'readline';
import type { DocxMapping, DocxDataSpec } from '../src/types.js';

// CJS interop
const PizZip = require('pizzip');

const MAPPINGS_DIR = path.join(__dirname, '..', 'outputs', 'llm_docx_analysis');
const TEMPLATES_DIR = path.join(__dirname, '..', 'outputs', 'templates');
const BASE_RESUME = path.join(__dirname, '..', 'base-resume.json');

export type { DocxMapping, DocxDataSpec };
export type DataSpec = DocxDataSpec;

// Local aliases derived from the mapping types for readability
type SimpleReplacement = DocxMapping['simpleReplacements'][0];
type ParagraphLoop = DocxMapping['paragraphLoops'][0];
type TableRowLoop = DocxMapping['tableRowLoops'][0];
type TableCellFields = DocxMapping['tableCellFields'][0];
type SectionLoop = DocxMapping['sectionLoops'][0];
type BodyPattern = SectionLoop['bodyPatterns'][0];

// ─── XML helpers ──────────────────────────────────────────────────────────────

function paraText(paraXml: string): string {
    return [...paraXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map(m => m[1])
        .join('')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function pPrOf(paraXml: string): string {
    const m = paraXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/);
    return m ? m[0] : '';
}

function firstRPrOf(paraXml: string): string {
    const m = paraXml.match(/<w:rPr[\s\S]*?<\/w:rPr>/);
    if (!m) return '';
    // Strip highlight and shading elements — they come from template markup, not content
    return m[0]
        .replace(/<w:highlight[^/]*(\/?>|<\/w:highlight>)/g, '')
        .replace(/<w:shd[^/]*(\/?>|<\/w:shd>)/g, '');
}

function paraOpenTag(paraXml: string): string {
    const m = paraXml.match(/^<w:p(?:\s[^>]*)?>/);
    return m ? m[0] : '<w:p>';
}

function escXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace all text content in a paragraph, keeping its pPr + first rPr. */
function replacePara(paraXml: string, newText: string): string {
    const open = paraOpenTag(paraXml);
    const pPr = pPrOf(paraXml);
    const rPr = firstRPrOf(paraXml);
    const spaceAttr = (newText.startsWith(' ') || newText.endsWith(' ')) ? ' xml:space="preserve"' : '';
    return `${open}${pPr}<w:r>${rPr}<w:t${spaceAttr}>${escXml(newText)}</w:t></w:r></w:p>`;
}

/** Create a minimal paragraph with a given formatting and text. */
function makePara(pPr: string, rPr: string, text: string): string {
    const spaceAttr = (text.startsWith(' ') || text.endsWith(' ')) ? ' xml:space="preserve"' : '';
    return `<w:p>${pPr}<w:r>${rPr}<w:t${spaceAttr}>${escXml(text)}</w:t></w:r></w:p>`;
}

interface ParaEntry {
    start: number;
    end: number;
    xml: string;
    text: string;
}

function getAllParas(xml: string): ParaEntry[] {
    const paras: ParaEntry[] = [];
    const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        paras.push({ start: m.index, end: m.index + m[0].length, xml: m[0], text: paraText(m[0]) });
    }
    return paras;
}

function isHeading2(paraXml: string): boolean {
    return (
        paraXml.includes('w:val="Heading2"') ||
        paraXml.includes("w:val='Heading2'") ||
        paraXml.includes('w:val="heading 2"') ||
        paraXml.includes("w:val='heading 2'") ||
        paraXml.includes('w:val="Heading 2"') ||
        paraXml.includes("w:val='Heading 2'")
    );
}

function isBoldPara(paraXml: string): boolean {
    return paraXml.includes('<w:b w:val="1"/>') || paraXml.includes("<w:b w:val='1'/>");
}

/** Bold paragraph that contains a year-range pattern (like a job/edu heading). */
function isBoldDateHeading(paraXml: string, text: string): boolean {
    if (!isBoldPara(paraXml)) return false;
    // Must contain a 4-digit year (job headings have dates like "2024 - 2025", "Dec 2025 - PRESENT")
    return /\b(19|20)\d{2}\b/.test(text) || /\bPRESENT\b/i.test(text);
}

function isItemHeading(paraXml: string, style?: 'heading2' | 'bold'): boolean {
    if (style === 'bold') return isBoldPara(paraXml);
    return isHeading2(paraXml);
}

function isBullet(paraXml: string): boolean {
    return paraXml.includes('<w:numPr>');
}

// ─── Skeleton extraction ──────────────────────────────────────────────────────

interface DocxSkeleton {
    headerCells: { colIndex: number; paragraphs: string[] }[];
    sections: SkeletonSection[];
}

interface SkeletonSection {
    heading: string;
    type: 'paragraphs' | 'table' | 'jobs' | 'education';
    paragraphs?: string[];
    table?: { rows: string[][] };
    jobs?: SkeletonJob[];
}

interface SkeletonJob {
    heading: string;
    body: string[];
    bullets: string[];
}

function extractSkeleton(docxPath: string): DocxSkeleton {
    const zip = new PizZip(fs.readFileSync(docxPath));
    const xml: string = zip.files['word/document.xml'].asText();

    const paras = getAllParas(xml);

    // Find tables
    const tableMatches: Array<{ start: number; end: number; xml: string }> = [];
    const tableRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tableRe.exec(xml)) !== null) {
        tableMatches.push({ start: tm.index, end: tm.index + tm[0].length, xml: tm[0] });
    }

    // Helper: get rows from table XML
    function getTableRows(tblXml: string): string[][] {
        const rows: string[][] = [];
        const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
        let r: RegExpExecArray | null;
        while ((r = rowRe.exec(tblXml)) !== null) {
            const row: string[] = [];
            const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
            let c: RegExpExecArray | null;
            while ((c = cellRe.exec(r[0])) !== null) {
                const cellText = getAllParas(c[0])
                    .map(p => p.text)
                    .filter(Boolean)
                    .join(' | ');
                row.push(cellText);
            }
            rows.push(row);
        }
        return rows;
    }

    // Table 0 is always the header table
    const headerSkeleton: DocxSkeleton['headerCells'] = [];
    if (tableMatches.length > 0) {
        const headerTbl = tableMatches[0];
        const rows = getTableRows(headerTbl.xml);
        // Get column count from first row
        const colCount = rows[0]?.length ?? 0;
        for (let c = 0; c < colCount; c++) {
            const cellParas: string[] = [];
            const rowRe2 = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
            let r2: RegExpExecArray | null;
            while ((r2 = rowRe2.exec(headerTbl.xml)) !== null) {
                const cellRe2 = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
                let c2: RegExpExecArray | null;
                let cIdx = 0;
                while ((c2 = cellRe2.exec(r2[0])) !== null) {
                    if (cIdx === c) {
                        getAllParas(c2[0])
                            .filter(p => p.text.trim())
                            .forEach(p => cellParas.push(p.text));
                    }
                    cIdx++;
                }
            }
            if (cellParas.length) headerSkeleton.push({ colIndex: c, paragraphs: cellParas });
        }
    }

    // Find section headings (all-caps single-line paragraphs)
    const SECTION_HEADINGS = ['SUMMARY', 'CORE SKILLS', 'RELEVANT EXPERIENCE', 'EDUCATION', 'CERTIFICATIONS', 'HOBBIES', 'INTERESTS'];

    const sections: SkeletonSection[] = [];

    // Process the body paragraphs (outside header table)
    const headerTableEnd = tableMatches[0]?.end ?? 0;
    const bodyParas = paras.filter(p => p.start >= headerTableEnd);

    let i = 0;
    while (i < bodyParas.length) {
        const p = bodyParas[i];
        const sectionName = SECTION_HEADINGS.find(h => p.text.includes(h));

        if (sectionName) {
            // Find which table (if any) immediately follows
            const nextTableIdx = tableMatches.findIndex(t => t.start > p.start);
            const nextSection = bodyParas.find((q, j) => j > i && SECTION_HEADINGS.some(h => q.text.includes(h)));
            const sectionEnd = nextSection?.start ?? xml.length;

            if (sectionName === 'CORE SKILLS' && nextTableIdx >= 0 && tableMatches[nextTableIdx].start < sectionEnd) {
                const tbl = tableMatches[nextTableIdx];
                const rows = getTableRows(tbl.xml);
                sections.push({ heading: sectionName, type: 'table', table: { rows } });
            } else if (sectionName === 'CERTIFICATIONS' && nextTableIdx >= 0 && tableMatches[nextTableIdx].start < sectionEnd) {
                const tbl = tableMatches[nextTableIdx];
                const rows = getTableRows(tbl.xml);
                sections.push({ heading: sectionName, type: 'table', table: { rows } });
            } else if (sectionName === 'RELEVANT EXPERIENCE') {
                // Parse jobs
                const expParas = bodyParas.filter(q => q.start > p.start && q.start < sectionEnd && q.text.trim());
                const jobs: SkeletonJob[] = [];
                let currentJob: SkeletonJob | null = null;
                for (const ep of expParas) {
                    if (isHeading2(ep.xml)) {
                        if (currentJob) jobs.push(currentJob);
                        currentJob = { heading: ep.text, body: [], bullets: [] };
                    } else if (currentJob) {
                        if (isBullet(ep.xml)) {
                            currentJob.bullets.push(ep.text);
                        } else {
                            currentJob.body.push(ep.text);
                        }
                    }
                }
                if (currentJob) jobs.push(currentJob);
                sections.push({ heading: sectionName, type: 'jobs', jobs });
            } else if (sectionName === 'EDUCATION') {
                const eduParas = bodyParas.filter(q => q.start > p.start && q.start < sectionEnd && q.text.trim());
                sections.push({ heading: 'EDUCATION', type: 'paragraphs', paragraphs: eduParas.map(e => e.text) });
            } else {
                // Generic: collect paragraphs until next section
                const textParas = bodyParas.filter(q => q.start > p.start && q.start < sectionEnd && q.text.trim());
                sections.push({ heading: sectionName, type: 'paragraphs', paragraphs: textParas.map(e => e.text) });
            }
        }
        i++;
    }

    return { headerCells: headerSkeleton, sections };
}

function formatSkeletonForPrompt(skeleton: DocxSkeleton): string {
    const lines: string[] = ['=== HEADER TABLE ==='];
    for (const col of skeleton.headerCells) {
        lines.push(`  Column ${col.colIndex}:`);
        col.paragraphs.forEach(p => lines.push(`    "${p}"`));
    }
    for (const sec of skeleton.sections) {
        lines.push('');
        lines.push(`=== ${sec.heading} ===`);
        if (sec.type === 'paragraphs') {
            sec.paragraphs?.forEach((p, i) => lines.push(`  [${i + 1}] "${p}"`));
        } else if (sec.type === 'table') {
            sec.table?.rows.forEach((row, ri) => {
                row.forEach((cell, ci) => lines.push(`  Row ${ri + 1} Col ${ci + 1}: "${cell}"`));
            });
        } else if (sec.type === 'jobs') {
            sec.jobs?.forEach((job, ji) => {
                lines.push(`  Job ${ji + 1} heading: "${job.heading}"`);
                job.body.forEach(b => lines.push(`    body: "${b}"`));
                job.bullets.forEach(b => lines.push(`    bullet: "${b}"`));
            });
        }
    }
    return lines.join('\n');
}

// ─── LLM call for mapping ─────────────────────────────────────────────────────

function httpsPost(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqBody = JSON.stringify(body);
        const options: import('https').RequestOptions = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody), ...headers },
        };
        const req = require('https').request(options, (res: import('http').IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on('data', (d: Buffer) => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
                else resolve(JSON.parse(raw));
            });
        });
        req.on('error', reject);
        req.write(reqBody);
        req.end();
    });
}

const MAPPING_PROMPT_SYSTEM = `\
You are an expert at analyzing DOCX resume templates and producing docxtemplater v3 mappings.

## docxtemplater v3 syntax reminder
- {variable}             simple value substitution
- {#arrayVar}...{/arrayVar}  loop; in PARAGRAPH context the {#} and {/} markers live in their
                              OWN standalone paragraphs (those paragraphs are deleted in output);
                              the content paragraph(s) between them repeat once per item.
- In TABLE ROW context: put {#skills}{category} in the first cell and {keywords}{/skills} in the
  last cell — the entire row repeats once per item.  The {#}/{/} markers are INSIDE the same row.

## Your task
Given the DOCX skeleton and the JsonResume data below, produce a JSON object that exactly matches
this TypeScript interface (all fields are required unless marked optional with ?):

interface DocxMapping {
  version: "1";
  simpleReplacements: {
    anchor: string;           // substring that uniquely identifies the original DOCX paragraph
    template: string;         // replacement text — may contain {placeholder} tags
  }[];
  paragraphLoops: {
    loopVar: string;          // placeholder array name, e.g. "summaryLines"
    itemField: string;        // field name on each item, e.g. "line"
    anchors: string[];        // anchor substrings of the N paragraphs to collapse into one loop
  }[];
  tableRowLoops: {
    loopVar: string;
    sectionAnchor: string;    // text in the heading just above the table
    columnFields: string[];   // placeholder field names for each column, in order
  }[];
  tableCellFields: {
    sectionAnchor: string;
    columnPlaceholders: string[];  // one per column
  }[];
  sectionLoops: {
    loopVar: string;
    startAnchor: string;  // MUST be the SECTION HEADING text (e.g. "RELEVANT EXPERIENCE", "EDUCATION")
    endAnchor: string;    // MUST be the NEXT SECTION HEADING text (e.g. "EDUCATION", "CERTIFICATIONS")
    headingTemplate: string;  // e.g. "{name}  –  {position}  •  {startDate} – {endDate}"
    bodyPatterns: {
      prefix: string;         // paragraph starts with this text
      field?: string;         // placeholder field inside the loop
      template?: string;      // full replacement template text
      keepLiteral?: boolean;  // if true, keep paragraph text exactly as-is
    }[];
    summaryField?: string;    // placeholder for the plain description paragraph between heading and Responsibilities
    highlights: { loopVar: string; itemField: string };
  }[];
  data: {
    [placeholder: string]:
      | { type: "path"; path: string }
      | { type: "split"; path: string; by: string; index: number }
      | { type: "literal"; value: string }
      | { type: "concat"; paths: string[]; sep: string }
      | { type: "profile"; network: string; field: string }
      | { type: "splitSentences"; path: string; itemField: string }
      | { type: "formatDate"; path: string }
      | { type: "array"; path: string; itemMap: Record<string, any> }
      | { type: "extractPrefix"; prefix: string }
      | { type: "filterRest"; exclude: string[]; itemField: string }
      | { type: "certs"; inProgress: boolean }
  };
}

## Rules
1. Every piece of visible text in the DOCX skeleton must end up covered by either a simpleReplacement,
   a loop field, OR left unchanged (e.g. section headings like "CORE SKILLS" that are not data).
2. Use the EXACT same anchor substrings as shown in the skeleton (case-sensitive).
3. Preserve surrounding literal text in templates: e.g. "Email: {email}", "Phone: {phone}".
4. For simpleReplacements use the smallest anchor that is still unique in the document.
5. In the data section, every {placeholder} referenced in simpleReplacements, loop fields, and
   headingTemplates MUST have an entry.  Array loop data specs use type "array" with an itemMap
   that describes each field (using relative paths "name", "position", sub-specs for transforms).
6. For itemMap entries in an "array" spec, use the same DataSpec union but paths are relative to
   each array item (i.e. "name" not "work[0].name").
7. For sectionLoops, startAnchor MUST be the SECTION HEADING (e.g. "RELEVANT EXPERIENCE"),
   and endAnchor MUST be the NEXT SECTION HEADING (e.g. "EDUCATION"). Never use job titles or
   body text as startAnchor/endAnchor.
8. Return ONLY the JSON object — no markdown, no prose.`;

async function getLLMMapping(
    skeleton: DocxSkeleton,
    resume: import('../src/types.js').JsonResume,
    provider: string,
): Promise<DocxMapping> {
    const providers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'llm_providers.json'), 'utf-8'));
    const cfg = providers.providers[provider];
    if (!cfg) throw new Error(`Unknown provider: ${provider}`);
    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing env var: ${cfg.apiKeyEnv}`);

    // Compact the resume to share structure without all the verbose content
    const r = resume as Record<string, unknown>;
    const basics = (r['basics'] ?? {}) as Record<string, unknown>;
    const compactResume = {
        basics: {
            name: basics['name'],
            label: basics['label'],
            email: basics['email'],
            phone: basics['phone'],
            url: basics['url'],
            summary: ((basics['summary'] as string) ?? '').slice(0, 120) + '…',
            location: basics['location'],
            profiles: basics['profiles'],
        },
        work: ((r['work'] as unknown[]) ?? []).slice(0, 1).map((w) => {
            const ww = w as Record<string, unknown>;
            return {
                name: ww['name'], position: ww['position'],
                startDate: ww['startDate'], endDate: ww['endDate'],
                summary: ((ww['summary'] as string) ?? '').slice(0, 60) + '…',
                highlights: ((ww['highlights'] as string[]) ?? []).slice(0, 4)
                    .map(h => h.slice(0, 60) + '…'),
            };
        }),
        skills: ((r['skills'] as unknown[]) ?? []).slice(0, 3).map((s) => {
            const ss = s as Record<string, unknown>;
            return { name: ss['name'], keywords: ((ss['keywords'] as string[]) ?? []).slice(0, 4) };
        }),
        certificates: ((r['certificates'] as unknown[]) ?? []).slice(0, 2),
        interests: ((r['interests'] as unknown[]) ?? []).slice(0, 2),
    };

    const userContent = [
        '## DOCX Skeleton\n',
        formatSkeletonForPrompt(skeleton),
        '\n\n## JsonResume schema + sample data\n',
        JSON.stringify(compactResume, null, 2),
    ].join('');

    const url = `${cfg.baseUrl}/chat/completions`;
    const body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 16384,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: MAPPING_PROMPT_SYSTEM },
            { role: 'user', content: userContent },
        ],
    };

    console.log(`  Calling ${provider} (${cfg.model}) for mapping analysis...`);
    const resp = await httpsPost(url, { Authorization: `Bearer ${apiKey}` }, body) as {
        choices: { message: { content: string }; finish_reason: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const usage = resp.usage;
    if (usage) console.log(`  Tokens: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} total`);

    const finishReason = resp.choices[0].finish_reason;
    if (finishReason === 'length') {
        throw new Error(
            `LLM mapping response was truncated (finish_reason=length). ` +
            `Increase maxTokens in config/llm_providers.json (currently ${cfg.maxTokens ?? 16384}).`
        );
    }

    const raw = resp.choices[0].message.content.trim();
    const parsed = JSON.parse(raw) as DocxMapping;
    return parsed;
}

// ─── Placeholder injection ────────────────────────────────────────────────────

function injectFromMapping(docxPath: string, mapping: DocxMapping): Buffer {
    const zip = new PizZip(fs.readFileSync(docxPath));
    let xml: string = zip.files['word/document.xml'].asText();

    const allParas = getAllParas(xml);

    /** Replace the XML of a found paragraph (by its position in the string). */
    function applyReplacement(paraEntry: ParaEntry, newContent: string): void {
        xml = xml.slice(0, paraEntry.start) + replacePara(paraEntry.xml, newContent) + xml.slice(paraEntry.end);
    }

    /** Find a paragraph whose text contains the anchor (case-sensitive). */
    function findPara(anchor: string): ParaEntry | undefined {
        // Refresh positions from current xml since offsets shift after edits
        return getAllParas(xml).find(p => p.text.includes(anchor));
    }

    // ── 1. Simple replacements ─────────────────────────────────────────────
    // Process in reverse document order so positions don't shift
    const simpleTargets: Array<{ para: ParaEntry; template: string }> = [];
    for (const sr of mapping.simpleReplacements) {
        const para = findPara(sr.anchor);
        if (!para) {
            console.warn(`  [warn] simpleReplacement anchor not found: "${sr.anchor}"`);
            continue;
        }
        simpleTargets.push({ para, template: sr.template });
    }
    // Sort by position descending so replacements don't shift offsets of later ones
    simpleTargets.sort((a, b) => b.para.start - a.para.start);
    for (const { para, template } of simpleTargets) {
        const fresh = getAllParas(xml).find(p => p.text.includes(para.text.slice(0, 20)));
        if (fresh) {
            xml = xml.slice(0, fresh.start) + replacePara(fresh.xml, template) + xml.slice(fresh.end);
        }
    }

    // ── 2. Paragraph loops ─────────────────────────────────────────────────
    for (const loop of mapping.paragraphLoops) {
        const currentParas = getAllParas(xml);
        const matched = loop.anchors
            .map(a => currentParas.find(p => p.text.includes(a)))
            .filter(Boolean) as ParaEntry[];

        if (matched.length === 0) {
            console.warn(`  [warn] paragraphLoop "${loop.loopVar}": no anchors found`);
            continue;
        }

        // Use formatting from first matched para
        const refPara = matched[0];
        const pPr = pPrOf(refPara.xml);
        const rPr = firstRPrOf(refPara.xml);

        const openPara = makePara(pPr, rPr, `{#${loop.loopVar}}`);
        const contentPara = makePara(pPr, rPr, `{${loop.itemField}}`);
        const closePara = makePara(pPr, rPr, `{/${loop.loopVar}}`);
        const loopBlock = openPara + contentPara + closePara;

        // Replace from first match to last match (inclusive) with the loop block
        const first = matched[0];
        const last = matched[matched.length - 1];
        // Refresh positions
        const refresh = getAllParas(xml);
        const freshFirst = refresh.find(p => p.text.includes(first.text.slice(0, 20)));
        const freshLast = refresh.find(p => p.text.includes(last.text.slice(0, 20)));
        if (!freshFirst || !freshLast) continue;
        xml = xml.slice(0, freshFirst.start) + loopBlock + xml.slice(freshLast.end);
    }

    // ── 3. Table row loops ─────────────────────────────────────────────────
    for (const loop of mapping.tableRowLoops) {
        const anchorPara = getAllParas(xml).find(p => p.text.includes(loop.sectionAnchor));
        if (!anchorPara) {
            console.warn(`  [warn] tableRowLoop "${loop.loopVar}": sectionAnchor not found: "${loop.sectionAnchor}"`);
            continue;
        }

        // Find the first table that starts after the anchor paragraph
        const tableRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
        tableRe.lastIndex = anchorPara.end;
        let tblMatch = tableRe.exec(xml);
        if (!tblMatch) {
            console.warn(`  [warn] tableRowLoop "${loop.loopVar}": no table found after anchor`);
            continue;
        }

        // Get rows from the table
        const tblXml = tblMatch[0];
        const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
        const rows: Array<{ start: number; end: number; xml: string }> = [];
        let rm: RegExpExecArray | null;
        while ((rm = rowRe.exec(tblXml)) !== null) {
            rows.push({ start: tblMatch.index + rm.index, end: tblMatch.index + rm.index + rm[0].length, xml: rm[0] });
        }

        if (rows.length === 0) continue;

        // Build template row from first data row
        const templateRow = rows[0];
        const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
        const cells: string[] = [];
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(templateRow.xml)) !== null) cells.push(cm[0]);

        if (cells.length !== loop.columnFields.length) {
            console.warn(`  [warn] tableRowLoop "${loop.loopVar}": expected ${loop.columnFields.length} columns, found ${cells.length}`);
        }

        // Replace each cell's paragraphs with the placeholder text
        let newRowXml = templateRow.xml;
        for (let ci = 0; ci < Math.min(cells.length, loop.columnFields.length); ci++) {
            const field = loop.columnFields[ci];
            const cellXml = cells[ci];
            // Get first paragraph of cell to borrow formatting
            const cellPara = getAllParas(cellXml)[0];
            const pPr = cellPara ? pPrOf(cellPara.xml) : '';
            const rPr = cellPara ? firstRPrOf(cellPara.xml) : '';

            let placeholderText: string;
            if (ci === 0) {
                placeholderText = `{#${loop.loopVar}}{${field}}`;
            } else if (ci === cells.length - 1) {
                placeholderText = `{${field}}{/${loop.loopVar}}`;
            } else {
                placeholderText = `{${field}}`;
            }

            const newCellPara = makePara(pPr, rPr, placeholderText);
            // Replace all paragraph content inside the cell
            const firstPara = getAllParas(cellXml)[0];
            const lastPara = getAllParas(cellXml)[getAllParas(cellXml).length - 1];
            if (firstPara && lastPara) {
                const newCellContent = cellXml.slice(0, firstPara.start - /* cell open tag offset */0);
                // Rebuild cell: keep cell properties, replace para(s) with one para
                const cellPrMatch = cellXml.match(/<w:tcPr[\s\S]*?<\/w:tcPr>/);
                const cellPr = cellPrMatch ? cellPrMatch[0] : '';
                const cellOpen = cellXml.match(/^<w:tc(?:\s[^>]*)?>/)?.[0] ?? '<w:tc>';
                const newCell = `${cellOpen}${cellPr}${newCellPara}</w:tc>`;
                newRowXml = newRowXml.replace(cellXml, newCell);
            }
        }

        // Reconstruct table: keep header row (if first row is header style) or just use newRowXml
        // Remove all rows except the first (template) row
        let newTblXml = tblXml;
        for (let ri = rows.length - 1; ri >= 1; ri--) {
            const r = rows[ri];
            const relStart = r.start - tblMatch.index;
            const relEnd = r.end - tblMatch.index;
            newTblXml = newTblXml.slice(0, relStart) + newTblXml.slice(relEnd);
        }
        // Replace first row with template row
        const firstRowRelStart = rows[0].start - tblMatch.index;
        const firstRowRelEnd = rows[0].end - tblMatch.index;
        newTblXml = newTblXml.slice(0, firstRowRelStart) + newRowXml + newTblXml.slice(firstRowRelEnd);

        xml = xml.slice(0, tblMatch.index) + newTblXml + xml.slice(tblMatch.index + tblMatch[0].length);
    }

    // ── 4. Table cell fields ───────────────────────────────────────────────
    for (const tcf of mapping.tableCellFields) {
        const anchorPara = getAllParas(xml).find(p => p.text.includes(tcf.sectionAnchor));
        if (!anchorPara) {
            console.warn(`  [warn] tableCellFields: sectionAnchor not found: "${tcf.sectionAnchor}"`);
            continue;
        }

        const tableRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
        tableRe.lastIndex = anchorPara.end;
        let tblMatch = tableRe.exec(xml);
        if (!tblMatch) continue;

        const tblXml = tblMatch[0];
        const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
        let rm: RegExpExecArray | null;
        const tblRows: string[] = [];
        while ((rm = rowRe.exec(tblXml)) !== null) tblRows.push(rm[0]);

        if (tblRows.length === 0) continue;
        // Use first (and likely only) data row
        let newRowXml = tblRows[0];
        const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
        const cells: string[] = [];
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(tblRows[0])) !== null) cells.push(cm[0]);

        for (let ci = 0; ci < Math.min(cells.length, tcf.columnPlaceholders.length); ci++) {
            const placeholder = tcf.columnPlaceholders[ci];
            // Normalize: strip any existing { } so we never produce double-braces
            const rawField = placeholder.replace(/^\{+/, '').replace(/\}+$/, '');
            const cellXml = cells[ci];
            const cellPara = getAllParas(cellXml)[0];
            const pPr = cellPara ? pPrOf(cellPara.xml) : '';
            const rPr = cellPara ? firstRPrOf(cellPara.xml) : '';
            const cellPrMatch = cellXml.match(/<w:tcPr[\s\S]*?<\/w:tcPr>/);
            const cellPr = cellPrMatch ? cellPrMatch[0] : '';
            const cellOpen = cellXml.match(/^<w:tc(?:\s[^>]*)?>/)?.[0] ?? '<w:tc>';
            const newCell = `${cellOpen}${cellPr}${makePara(pPr, rPr, `{${rawField}}`)}</w:tc>`;
            newRowXml = newRowXml.replace(cellXml, newCell);
        }

        let newTblXml = tblXml.replace(tblRows[0], newRowXml);
        xml = xml.slice(0, tblMatch.index) + newTblXml + xml.slice(tblMatch.index + tblMatch[0].length);
    }

    // ── 5. Section loops (work experience) ────────────────────────────────
    for (const loop of mapping.sectionLoops) {
        const currentParas = getAllParas(xml);
        const startPara = currentParas.find(p => p.text.includes(loop.startAnchor));
        const endPara = currentParas.find(p => p.text.includes(loop.endAnchor));
        if (!startPara || !endPara) {
            console.warn(`  [warn] sectionLoop "${loop.loopVar}": boundary anchors not found`);
            continue;
        }

        // Collect all non-empty paragraphs in the section
        const sectionParas = currentParas.filter(
            p => p.start >= startPara.end && p.start < endPara.start && p.text.trim()
        );

        if (sectionParas.length === 0) continue;

        // Find the first item heading
        const firstHeadingIdx = sectionParas.findIndex(p => isItemHeading(p.xml, loop.headingStyle));
        if (firstHeadingIdx < 0) {
            console.warn(`  [warn] sectionLoop "${loop.loopVar}": no item headings found (headingStyle=${loop.headingStyle ?? 'heading2'})`);
            continue;
        }

        // Find the second item heading (marks end of first item)
        let secondHeadingIdx = sectionParas.findIndex((p, i) => i > firstHeadingIdx && isItemHeading(p.xml, loop.headingStyle));
        // If heading2 mode found no second heading, fall back to bold+date detection
        if (secondHeadingIdx < 0 && (!loop.headingStyle || loop.headingStyle === 'heading2')) {
            secondHeadingIdx = sectionParas.findIndex((p, i) => i > firstHeadingIdx && isBoldDateHeading(p.xml, p.text));
        }
        const firstJobEnd = secondHeadingIdx >= 0 ? secondHeadingIdx : sectionParas.length;
        const firstJobParas = sectionParas.slice(firstHeadingIdx, firstJobEnd);

        // Determine actual heading detection function for building the template
        // (accounting for mixed Heading2/bold-date in the same section)
        const isItemHead = (p: ParaEntry): boolean => {
            if (loop.headingStyle === 'bold') return isBoldPara(p.xml);
            if (isHeading2(p.xml)) return true;
            // Fallback: bold paragraph with date pattern
            return isBoldDateHeading(p.xml, p.text);
        };

        // Build the loop template paragraphs
        const refPara = firstJobParas[0];
        const pPr = pPrOf(refPara.xml);
        const rPr = firstRPrOf(refPara.xml);

        const parts: string[] = [];
        parts.push(makePara(pPr, rPr, `{#${loop.loopVar}}`));

        let addedHighlightsLoop = false;
        let addedSummary = false;
        const usedPatterns = new Set<number>(); // track which bodyPattern indices have been emitted

        for (const p of firstJobParas) {
            if (isItemHead(p)) {
                parts.push(replacePara(p.xml, loop.headingTemplate));
            } else if (isBullet(p.xml)) {
                if (!addedHighlightsLoop && loop.highlights) {
                    const bulletPPr = pPrOf(p.xml);
                    const bulletRPr = firstRPrOf(p.xml);
                    parts.push(makePara(bulletPPr, bulletRPr, `{#${loop.highlights.loopVar}}`));
                    parts.push(makePara(bulletPPr, bulletRPr, `{${loop.highlights.itemField}}`));
                    parts.push(makePara(bulletPPr, bulletRPr, `{/${loop.highlights.loopVar}}`));
                    addedHighlightsLoop = true;
                }
            } else {
                const text = p.text;
                const matchIdx = loop.bodyPatterns.findIndex(
                    (bp, idx) => !usedPatterns.has(idx) && text.startsWith(bp.prefix)
                );
                if (matchIdx >= 0) {
                    const matchedPattern = loop.bodyPatterns[matchIdx];
                    usedPatterns.add(matchIdx);
                    if (matchedPattern.keepLiteral) {
                        parts.push(p.xml); // keep original text
                    } else if (matchedPattern.template) {
                        parts.push(replacePara(p.xml, matchedPattern.template));
                    } else if (matchedPattern.field) {
                        parts.push(replacePara(p.xml, `{${matchedPattern.field}}`));
                        if (!addedSummary) addedSummary = true; // treat first field emit as summary
                    }
                } else if (!addedSummary && loop.summaryField && !addedHighlightsLoop) {
                    parts.push(replacePara(p.xml, `{${loop.summaryField}}`));
                    addedSummary = true;
                } else if (!addedSummary && !addedHighlightsLoop) {
                    // No matching prefix and no summaryField — use first unmatched body para as description
                    const guessedField = loop.loopVar === 'projects' ? 'description' : 'summary';
                    parts.push(replacePara(p.xml, `{${guessedField}}`));
                    addedSummary = true;
                    console.warn(`  [warn] sectionLoop "${loop.loopVar}": no bodyPattern matched "${p.text.slice(0, 40)}", falling back to {${guessedField}}`);
                }
                // If addedSummary=true and no pattern matched, silently drop the paragraph
                // (avoids repeating the same description/summary field multiple times)
            }
        }

        parts.push(makePara(pPr, rPr, `{/${loop.loopVar}}`));

        // Replace from first job heading to end of last job
        const allJobParas = sectionParas.slice(firstHeadingIdx);
        const sectionStart = allJobParas[0].start;
        const sectionEnd = allJobParas[allJobParas.length - 1].end;

        xml = xml.slice(0, sectionStart) + parts.join('') + xml.slice(sectionEnd);
    }

    zip.file('word/document.xml', xml);
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ─── Mapping auto-patch ───────────────────────────────────────────────────────

/**
 * Automatically corrects common issues in LLM-generated mappings:
 *  1. Adds missing paragraphLoops for summary / interests sections.
 *  2. Ensures skills.keywords is a joined string (not a nested array).
 *  3. Ensures work.highlights use filterRest to get plain highlight strings.
 *  4. Ensures work data itemMap has "position" for the headingTemplate.
 */
function patchMapping(mapping: DocxMapping, skeleton: DocxSkeleton): DocxMapping {
    const patched = JSON.parse(JSON.stringify(mapping)) as DocxMapping;

    // ── 1. Add missing paragraphLoops ────────────────────────────────────
    const hasLoop = (v: string) => patched.paragraphLoops.some(l => l.loopVar === v);

    if (!hasLoop('summaryLines')) {
        const sec = skeleton.sections.find(s => s.heading === 'SUMMARY');
        if (sec?.paragraphs && sec.paragraphs.length >= 1) {
            const anchors = sec.paragraphs.map(p => p.slice(0, 30));
            patched.paragraphLoops.push({ loopVar: 'summaryLines', itemField: 'line', anchors });
            patched.data['summaryLines'] = { type: 'splitSentences', path: 'basics.summary', itemField: 'line' };
            console.log('  [patch] Added missing paragraphLoop: summaryLines');
        }
    }
    // Always normalise: LLM sometimes generates type:"array" for summaryLines instead of splitSentences
    if (patched.data['summaryLines'] && (patched.data['summaryLines'] as Record<string, unknown>)['type'] !== 'splitSentences') {
        patched.data['summaryLines'] = { type: 'splitSentences', path: 'basics.summary', itemField: 'line' };
        console.log('  [patch] Normalised summaryLines data spec to splitSentences');
    }

    // Normalize: rename 'hobbies' paragraphLoop to 'interests' so it matches data key
    const hobbiesLoopIdx = patched.paragraphLoops.findIndex(l => l.loopVar === 'hobbies');
    if (hobbiesLoopIdx >= 0 && !hasLoop('interests')) {
        patched.paragraphLoops[hobbiesLoopIdx].loopVar = 'interests';
        // Fix itemField to 'line' for consistency
        patched.paragraphLoops[hobbiesLoopIdx].itemField = 'line';
        // If LLM stored it under 'hobbies' in data, rename to 'interests'
        if (patched.data['hobbies'] && !patched.data['interests']) {
            patched.data['interests'] = patched.data['hobbies'];
        }
        delete patched.data['hobbies'];
        // Ensure interests data spec uses 'line' itemField
        patched.data['interests'] = { type: 'array', path: 'interests', itemMap: { line: { type: 'path', path: 'name' } } };
        console.log('  [patch] Renamed hobbies loop → interests');
    }

    if (!hasLoop('interests')) {
        const sec = skeleton.sections.find(s => s.heading === 'HOBBIES' || s.heading === 'INTERESTS' || (s.heading ?? '').includes('HOBBIES'));
        if (sec?.paragraphs && sec.paragraphs.length >= 1) {
            const anchors = sec.paragraphs.map(p => p.slice(0, 30));
            patched.paragraphLoops.push({ loopVar: 'interests', itemField: 'line', anchors });
            patched.data['interests'] = { type: 'array', path: 'interests', itemMap: { line: { type: 'path', path: 'name' } } };
            console.log('  [patch] Added missing paragraphLoop: interests');
        }
    }

    // ── 2. Fix *.keywords to be a joined string in any tableRowLoop data entry ──
    for (const trl of patched.tableRowLoops) {
        const spec = patched.data[trl.loopVar];
        if (!spec || (spec as Record<string, unknown>)['type'] !== 'array') continue;
        const arrSpec = spec as { type: string; path: string; itemMap: Record<string, DocxDataSpec> };
        const kw = arrSpec.itemMap?.['keywords'] as Record<string, unknown> | undefined;
        if (!kw) continue;
        if (kw['type'] === 'array') {
            arrSpec.itemMap['keywords'] = { type: 'path', path: 'keywords' } as DocxDataSpec;
            console.log(`  [patch] Fixed ${trl.loopVar}.keywords: nested array → path (auto-join)`);
        } else if (kw['type'] === 'concat') {
            const paths = kw['paths'] as string[];
            if (paths?.length === 1) {
                arrSpec.itemMap['keywords'] = { type: 'path', path: paths[0] } as DocxDataSpec;
                console.log(`  [patch] Fixed ${trl.loopVar}.keywords: concat(single path) → path (auto-join)`);
            }
        }
    }

    // ── 3. Fix work/projects highlights: must be filterRest; add summaryField; ensure position ──
    const SECTION_SUMMARY_FIELD: Record<string, string> = {
        work: 'summary', projects: 'description', volunteer: 'summary',
    };

    for (const sectionLoop of patched.sectionLoops) {
        const loopDataKey = sectionLoop.loopVar;
        // Ensure the sectionLoop has a summaryField set (used as fallback when no bodyPattern matches)
        if (!sectionLoop.summaryField && SECTION_SUMMARY_FIELD[loopDataKey]) {
            (sectionLoop as Record<string, unknown>)['summaryField'] = SECTION_SUMMARY_FIELD[loopDataKey];
            console.log(`  [patch] Set sectionLoop "${loopDataKey}" summaryField: ${SECTION_SUMMARY_FIELD[loopDataKey]}`);
        }

        const spec = patched.data[loopDataKey] as { type: string; path: string; itemMap: Record<string, DocxDataSpec> } | undefined;
        if (!spec || spec.type !== 'array') continue;

        // Ensure itemMap fields use paths that match the target JsonResume array schema
        if (loopDataKey === 'projects') {
            // projects items use 'description' not 'summary', and have no 'position'
            if (spec.itemMap?.['summary']) {
                spec.itemMap['description'] = spec.itemMap['summary'];
                (spec.itemMap['description'] as Record<string, unknown>)['path'] = 'description';
                delete spec.itemMap['summary'];
                console.log(`  [patch] Fixed ${loopDataKey}.itemMap: renamed summary → description`);
            }
            if (spec.itemMap?.['description']) {
                (spec.itemMap['description'] as Record<string, unknown>)['path'] = 'description';
            }
            if (spec.itemMap?.['position']) {
                delete spec.itemMap['position'];
                console.log(`  [patch] Fixed ${loopDataKey}.itemMap: removed position (not in projects schema)`);
            }

            // Fix headingTemplate: remove {position} placeholder
            if (sectionLoop.headingTemplate?.includes('{position}')) {
                sectionLoop.headingTemplate = sectionLoop.headingTemplate
                    .replace(/\s*[–-]\s*\{position\}/, '')
                    .replace(/\{position\}\s*[–-]?\s*/, '');
                console.log(`  [patch] Fixed projects headingTemplate: removed {position}`);
            }

            // Fix summaryField and bodyPatterns: summary → description
            if ((sectionLoop as Record<string, unknown>)['summaryField'] === 'summary') {
                (sectionLoop as Record<string, unknown>)['summaryField'] = 'description';
                console.log(`  [patch] Fixed projects sectionLoop summaryField: summary → description`);
            }
            for (const bp of sectionLoop.bodyPatterns ?? []) {
                if ((bp as Record<string, unknown>)['field'] === 'summary') {
                    (bp as Record<string, unknown>)['field'] = 'description';
                    console.log(`  [patch] Fixed projects bodyPattern field: summary → description`);
                }
            }
        }
        if (loopDataKey === 'work') {
            // work items use 'summary' not 'description', and have 'position'
            if (spec.itemMap?.['description']) {
                spec.itemMap['summary'] = spec.itemMap['description'];
                (spec.itemMap['summary'] as Record<string, unknown>)['path'] = 'summary';
                delete spec.itemMap['description'];
                console.log(`  [patch] Fixed ${loopDataKey}.itemMap: renamed description → summary`);
            }
        }

        // Fix highlights to filterRest
        if (spec.itemMap?.['highlights']) {
            const hl = spec.itemMap['highlights'] as Record<string, unknown>;
            if (hl['type'] !== 'filterRest') {
                spec.itemMap['highlights'] = {
                    type: 'filterRest',
                    exclude: ['Responsibilities:', 'Technology Stacks:', 'Key contributions:'],
                    itemField: 'text',
                } as DocxDataSpec;
                console.log(`  [patch] Fixed ${loopDataKey}.highlights: replaced with filterRest`);
            }
        }

        // Ensure work-like entries have a "position" field
        if (loopDataKey === 'work' && !spec.itemMap?.['position']) {
            spec.itemMap['position'] = { type: 'path', path: 'position' } as DocxDataSpec;
            console.log('  [patch] Added missing work.position field');
        }
    }

    // Also fix work if it exists in data but isn't a sectionLoop (backward-compat)
    if (patched.data['work'] && (patched.data['work'] as Record<string, unknown>)['type'] === 'array') {
        const workSpec = patched.data['work'] as { type: string; path: string; itemMap: Record<string, DocxDataSpec> };
        if (workSpec.itemMap?.['highlights']) {
            const hl = workSpec.itemMap['highlights'] as Record<string, unknown>;
            if (hl['type'] !== 'filterRest') {
                workSpec.itemMap['highlights'] = {
                    type: 'filterRest',
                    exclude: ['Responsibilities:', 'Technology Stacks:', 'Key contributions:'],
                    itemField: 'text',
                } as DocxDataSpec;
                console.log('  [patch] Fixed work.highlights: replaced with filterRest');
            }
        }
        if (!workSpec.itemMap?.['position']) {
            workSpec.itemMap['position'] = { type: 'path', path: 'position' } as DocxDataSpec;
            console.log('  [patch] Added missing work.position field');
        }
    }
    // Sync all sectionLoop highlights.itemField with their data filterRest itemField
    for (const loop of patched.sectionLoops) {
        if (!loop.highlights) continue;
        const dataSpec = patched.data[loop.loopVar] as { type: string; itemMap: Record<string, DocxDataSpec> } | undefined;
        if (!dataSpec?.itemMap?.['highlights']) continue;
        const hlSpec = dataSpec.itemMap['highlights'] as Record<string, unknown>;
        if (hlSpec['type'] === 'filterRest' && hlSpec['itemField']) {
            const newField = hlSpec['itemField'] as string;
            if (loop.highlights.itemField !== newField) {
                console.log(`  [patch] Synced ${loop.loopVar} highlights itemField: "${loop.highlights.itemField}" → "${newField}"`);
                loop.highlights.itemField = newField;
            }
        }
    }

    // ── 4. Fix education sectionLoop: set headingStyle=bold ──────────────────
    const eduLoop = patched.sectionLoops.find(l => l.loopVar === 'education');
    if (eduLoop && !eduLoop.headingStyle) {
        (eduLoop as { headingStyle?: string }).headingStyle = 'bold';
        console.log('  [patch] Set education sectionLoop headingStyle=bold');
    }

    // ── 4b. Fix education data: degree → studyType (JsonResume standard) ────
    if (patched.data['education'] && (patched.data['education'] as Record<string, unknown>)['type'] === 'array') {
        const eduSpec = patched.data['education'] as { type: string; path: string; itemMap: Record<string, DocxDataSpec> };
        if (eduSpec.itemMap?.['degree']) {
            const degreeSpec = eduSpec.itemMap['degree'] as Record<string, unknown>;
            if (degreeSpec['type'] === 'path' && degreeSpec['path'] === 'degree') {
                degreeSpec['path'] = 'studyType';
                console.log('  [patch] Fixed education.degree path: "degree" → "studyType"');
            }
        }
    }

    // ── 5. Fix sectionLoop startAnchor/endAnchor to be section headings ───────
    const sectionHeadings = skeleton.sections.map(s => s.heading);
    for (const loop of patched.sectionLoops) {
        // Fix startAnchor: must match a skeleton section heading
        if (!sectionHeadings.includes(loop.startAnchor)) {
            // Try to find the right heading from loopVar
            const varToHeading: Record<string, string> = {
                work: 'RELEVANT EXPERIENCE', projects: 'RELEVANT EXPERIENCE',
                education: 'EDUCATION',
                certifications: 'CERTIFICATIONS', interests: 'HOBBIES',
            };
            const candidate = varToHeading[loop.loopVar];
            if (candidate && sectionHeadings.includes(candidate)) {
                console.log(`  [patch] Fixed sectionLoop "${loop.loopVar}" startAnchor: "${loop.startAnchor}" → "${candidate}"`);
                loop.startAnchor = candidate;
            }
        }
        // Fix endAnchor: must match a skeleton section heading or EOF marker
        if (!sectionHeadings.includes(loop.endAnchor)) {
            const startIdx = sectionHeadings.indexOf(loop.startAnchor);
            if (startIdx >= 0 && startIdx + 1 < sectionHeadings.length) {
                const nextHeading = sectionHeadings[startIdx + 1];
                console.log(`  [patch] Fixed sectionLoop "${loop.loopVar}" endAnchor: "${loop.endAnchor}" → "${nextHeading}"`);
                loop.endAnchor = nextHeading;
            }
        }
    }

    // ── 5. Deduplicate paragraphLoops: keep longest-anchor version ───────────
    const seenLoops = new Map<string, typeof patched.paragraphLoops[0]>();
    for (const l of patched.paragraphLoops) {
        const existing = seenLoops.get(l.loopVar);
        if (!existing || (l.anchors?.length ?? 0) > (existing.anchors?.length ?? 0)) {
            seenLoops.set(l.loopVar, l);
        }
    }
    const before = patched.paragraphLoops.length;
    patched.paragraphLoops = [...seenLoops.values()];
    if (patched.paragraphLoops.length < before) {
        console.log(`  [patch] Deduplicated paragraphLoops: ${before} → ${patched.paragraphLoops.length}`);
    }

    return patched;
}

// ─── Verification ─────────────────────────────────────────────────────────────

interface VerifyResult { field: string; expected: string; actual: string; ok: boolean }

async function verifyTemplate(
    tplPath: string,
    mapping: DocxMapping,
    resume: import('../src/types').JsonResume,
): Promise<VerifyResult[]> {
    // Dynamically import the renderer (avoids circular init issues)
    const { renderDocxFromTemplate } = await import('../src/renderDocxFromTemplate.js');
    const mappingPath = tplPath.replace('_tpl.docx', '_mapping.json');

    const tmpOut = path.join(path.dirname(tplPath), '__verify_out.docx');
    await renderDocxFromTemplate(tplPath, mappingPath, resume as never, tmpOut);

    const zip = new PizZip(fs.readFileSync(tmpOut));
    const xml: string = zip.files['word/document.xml'].asText();
    const rendered = getAllParas(xml).map(p => p.text).filter(Boolean);

    fs.unlinkSync(tmpOut);

    const basics = (resume as unknown as { basics: Record<string, string> }).basics ?? {};
    const checks: Array<{ field: string; expected: string }> = [
        { field: 'name', expected: basics.name ?? '' },
        { field: 'email', expected: basics.email ?? '' },
        { field: 'phone', expected: basics.phone ?? '' },
    ];

    return checks.map(c => ({
        field: c.field,
        expected: c.expected,
        actual: rendered.find(r => r.includes(c.expected)) ?? '(not found)',
        ok: rendered.some(r => r.includes(c.expected)),
    }));
}

// ─── Human-in-the-loop mapping review ────────────────────────────────────────

const JSON_RESUME_ARRAYS = [
    'work', 'projects', 'volunteer', 'education', 'awards',
    'publications', 'skills', 'languages', 'interests', 'references', 'certificates',
];

function rl(): readline.Interface {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: readline.Interface, prompt: string): Promise<string> {
    return new Promise(resolve => iface.question(prompt, answer => resolve(answer.trim())));
}

// When switching sectionLoop loopVar, remap itemMap entry _paths_ that belong
// to the old schema (e.g. work.summary → projects.description).
// Format: { 'oldLoopVar_to_newLoopVar': { 'old.path.value': 'new.path.value' | '__remove__' } }
const PATH_REMAP: Record<string, Record<string, string>> = {
    work_to_projects: { summary: 'description', position: '__remove__' },
    projects_to_work: { description: 'summary' },
};

async function reviewMapping(mapping: DocxMapping): Promise<DocxMapping> {
    const result: DocxMapping = JSON.parse(JSON.stringify(mapping)); // deep clone
    const iface = rl();

    const hr = '─'.repeat(62);
    const arrays = JSON_RESUME_ARRAYS.join(' / ');

    // ── sectionLoops ────────────────────────────────────────────────
    if (result.sectionLoops.length) {
        console.log(`\n${hr}`);
        console.log('  SECTION ASSIGNMENTS  (LLM identified section → JSON array)');
        console.log(`  Valid values: ${arrays}`);
        console.log(hr);

        for (let i = 0; i < result.sectionLoops.length; i++) {
            const sl = result.sectionLoops[i];
            const answer = await ask(
                iface,
                `  [${i + 1}]  "${sl.startAnchor}"  →  ${sl.loopVar}\n       Press Enter to accept, or type replacement: `,
            );
            if (answer) {
                console.log(`       ✎  ${sl.loopVar}  →  ${answer}`);
                result.sectionLoops[i] = { ...sl, loopVar: answer };
                // keep data entry in sync
                const dataEntry = (result.data as Record<string, unknown>)[sl.loopVar] as Record<string, unknown> | undefined;
                if (dataEntry) {
                    // 1. Move data key
                    (result.data as Record<string, unknown>)[answer] = dataEntry;
                    delete (result.data as Record<string, unknown>)[sl.loopVar];

                    // 2. Always update path to the new target array (user's explicit intent)
                    const oldPath = dataEntry['path'] as string | undefined;
                    dataEntry['path'] = answer;
                    console.log(`       ✎  data.${answer}.path: "${oldPath ?? '?'}" → "${answer}"`);

                    // 3. Remap itemMap entry paths for known JsonResume schema differences
                    const remapKey = `${sl.loopVar}_to_${answer}`;
                    const remap = PATH_REMAP[remapKey];
                    const itemMap = dataEntry['itemMap'] as Record<string, Record<string, unknown>> | undefined;
                    if (remap && itemMap) {
                        for (const [fieldKey, fieldEntry] of Object.entries(itemMap)) {
                            const currentPath = fieldEntry['path'] as string | undefined;
                            if (!currentPath) continue;
                            const newPath = remap[currentPath];
                            if (newPath === '__remove__') {
                                delete itemMap[fieldKey];
                                console.log(`       ✎  data.${answer}.itemMap.${fieldKey}: removed (not in target schema)`);
                            } else if (newPath) {
                                fieldEntry['path'] = newPath;
                                console.log(`       ✎  data.${answer} itemMap path: "${currentPath}" → "${newPath}"`);
                            }
                        }
                    }
                }
            } else {
                console.log('       ✓  kept');
            }
        }
    }

    // ── tableRowLoops ───────────────────────────────────────────────
    if (result.tableRowLoops.length) {
        console.log(`\n${hr}`);
        console.log('  TABLE ROW SECTIONS');
        console.log(hr);

        for (let i = 0; i < result.tableRowLoops.length; i++) {
            const tl = result.tableRowLoops[i];
            const cols = tl.columnFields.join(', ');
            const answer = await ask(
                iface,
                `  [${i + 1}]  "${tl.sectionAnchor}"  →  ${tl.loopVar}  (columns: ${cols})\n       Press Enter to accept, or type replacement loopVar: `,
            );
            if (answer) {
                console.log(`       ✎  ${tl.loopVar}  →  ${answer}`);
                result.tableRowLoops[i] = { ...tl, loopVar: answer };
                if ((result.data as Record<string, unknown>)[tl.loopVar]) {
                    (result.data as Record<string, unknown>)[answer] =
                        (result.data as Record<string, unknown>)[tl.loopVar];
                    delete (result.data as Record<string, unknown>)[tl.loopVar];
                }
            } else {
                console.log('       ✓  kept');
            }
        }
    }

    // ── simpleReplacements ──────────────────────────────────────────
    if (result.simpleReplacements.length) {
        console.log(`\n${hr}`);
        console.log('  SIMPLE REPLACEMENTS');
        console.log(hr);
        result.simpleReplacements.forEach((sr, idx) => {
            const anchor = sr.anchor.length > 40 ? sr.anchor.slice(0, 37) + '…' : sr.anchor;
            console.log(`  ${String(idx + 1).padStart(2)}.  "${anchor}"`);
            console.log(`       →  ${sr.template}`);
        });

        let editing = true;
        while (editing) {
            const answer = await ask(
                iface,
                `\n  Press Enter to accept all, or type a line number to edit: `,
            );
            if (!answer) {
                editing = false;
            } else {
                const n = parseInt(answer, 10);
                if (isNaN(n) || n < 1 || n > result.simpleReplacements.length) {
                    console.log(`  Invalid number. Enter 1-${result.simpleReplacements.length} or press Enter.`);
                } else {
                    const sr = result.simpleReplacements[n - 1];
                    console.log(`  Editing entry ${n}:`);
                    console.log(`    anchor:   "${sr.anchor}"`);
                    console.log(`    template: ${sr.template}`);
                    const field = await ask(iface, `  Edit which field? [anchor / template]: `);
                    if (field === 'anchor' || field === 'template') {
                        const val = await ask(iface, `  New value: `);
                        if (val) {
                            (result.simpleReplacements[n - 1] as Record<string, string>)[field] = val;
                            console.log(`  ✎  Updated ${field} → "${val}"`);
                        }
                    } else {
                        console.log('  Skipped — unrecognised field.');
                    }
                }
            }
        }
    }

    iface.close();
    console.log(`\n${hr}`);
    console.log('  Review complete.');
    console.log(hr);
    return result;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function buildDocxTemplate(docxPath: string, options: { forceAnalyze?: boolean; provider?: string; skipReview?: boolean } = {}): Promise<void> {
    const { forceAnalyze = false, provider = 'github-copilot', skipReview = false } = options;

    const absDocxPath = path.resolve(docxPath);
    const base = path.basename(absDocxPath, '.docx');
    const mappingPath = path.join(MAPPINGS_DIR, `${base}_mapping.json`);
    const tplPath = path.join(TEMPLATES_DIR, `${base}_tpl.docx`);

    fs.mkdirSync(MAPPINGS_DIR, { recursive: true });
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

    // ── Phase 1: Analysis ─────────────────────────────────────────────────
    let mapping: DocxMapping;
    let skeleton: DocxSkeleton;

    if (!forceAnalyze && fs.existsSync(mappingPath)) {
        console.log(`  Using cached mapping: ${mappingPath}`);
        mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as DocxMapping;
        // Still need skeleton for patch (re-extract — fast, no LLM)
        skeleton = extractSkeleton(absDocxPath);
    } else {
        console.log(`\nExtracting DOCX skeleton from: ${absDocxPath}`);
        skeleton = extractSkeleton(absDocxPath);

        const resume = JSON.parse(fs.readFileSync(BASE_RESUME, 'utf-8'));

        console.log('\nRequesting mapping from LLM...');
        mapping = await getLLMMapping(skeleton, resume, provider);
        fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
        console.log(`  Mapping saved → ${mappingPath}`);

        // ── Apply auto-patches ────────────────────────────────────────
        const patched = patchMapping(mapping, skeleton);
        if (JSON.stringify(patched) !== JSON.stringify(mapping)) {
            fs.writeFileSync(mappingPath, JSON.stringify(patched, null, 2));
            console.log('  Patched mapping saved.');
        }
        mapping = patched;

        // ── Human-in-the-loop review (fresh analysis only) ────────────
        if (!skipReview) {
            const reviewed = await reviewMapping(mapping);
            if (JSON.stringify(reviewed) !== JSON.stringify(mapping)) {
                // Re-patch after review: user may have renamed loopVars, so summaryField,
                // highlights fixes, etc. need to re-run against the new names.
                const repatched = patchMapping(reviewed, skeleton);
                fs.writeFileSync(mappingPath, JSON.stringify(repatched, null, 2));
                console.log('  Reviewed + re-patched mapping saved.');
                mapping = repatched;
            } else {
                mapping = reviewed;
            }
        }

        // Return early — patches + review already applied above
        // (fall through to injection)
    }

    // ── Apply auto-patches to fix common LLM mapping issues (cached path) ──
    if (!forceAnalyze && fs.existsSync(mappingPath)) {
        const patched = patchMapping(mapping, skeleton);
        if (JSON.stringify(patched) !== JSON.stringify(mapping)) {
            fs.writeFileSync(mappingPath, JSON.stringify(patched, null, 2));
            console.log('  Patched mapping saved.');
        }
        mapping = patched;
    }

    // ── Phase 2: Injection ────────────────────────────────────────────────
    console.log('\nInjecting placeholders...');
    const steps = [
        `simpleReplacements (${mapping.simpleReplacements.length})`,
        `paragraphLoops (${mapping.paragraphLoops.length})`,
        `tableRowLoops (${mapping.tableRowLoops.length})`,
        `tableCellFields (${mapping.tableCellFields.length})`,
        `sectionLoops (${mapping.sectionLoops.length})`,
    ];
    steps.forEach(s => console.log(`  • ${s}`));

    const tplBuffer = injectFromMapping(absDocxPath, mapping);
    fs.writeFileSync(tplPath, tplBuffer);
    console.log(`\n✓ Template written: ${tplPath}`);
}

async function main() {
    const args = process.argv.slice(2);
    const docxPath = args.find(a => a.endsWith('.docx') && !a.startsWith('-'));
    const forceAnalyze = args.includes('--analyze');
    const doVerify = args.includes('--verify');
    const skipReview = args.includes('--no-review');
    const providerFlagIdx = args.indexOf('--provider');
    const provider = providerFlagIdx >= 0 ? args[providerFlagIdx + 1] : 'github-copilot';

    if (!docxPath) {
        console.error('Usage: tsx src/buildDocxTemplate.ts <template.docx> [--analyze] [--no-review] [--verify] [--provider <name>]');
        process.exit(1);
    }

    await buildDocxTemplate(docxPath, { forceAnalyze, provider, skipReview });

    const absDocxPath = path.resolve(docxPath);
    const base = path.basename(absDocxPath, '.docx');
    const tplPath = path.join(TEMPLATES_DIR, `${base}_tpl.docx`);
    const mappingPath = path.join(MAPPINGS_DIR, `${base}_mapping.json`);
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as DocxMapping;

    // ── Phase 3: Verification ─────────────────────────────────────────────
    if (doVerify) {
        console.log('\nVerifying template...');
        try {
            const resume = JSON.parse(fs.readFileSync(BASE_RESUME, 'utf-8'));
            const results = await verifyTemplate(tplPath, mapping, resume);
            let allOk = true;
            for (const r of results) {
                const icon = r.ok ? '✓' : '✗';
                console.log(`  ${icon} ${r.field}: ${r.ok ? r.expected : `expected "${r.expected}" — got "${r.actual}"`}`);
                if (!r.ok) allOk = false;
            }
            if (allOk) console.log('\n  All verification checks passed!');
            else console.log('\n  Some checks failed — review the mapping JSON and re-run with --analyze to regenerate.');
        } catch (e: unknown) {
            console.warn(`  Verification skipped (renderer not available): ${(e as Error).message}`);
        }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
