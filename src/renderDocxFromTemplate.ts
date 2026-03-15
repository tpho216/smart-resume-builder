/**
 * renderDocxFromTemplate.ts
 *
 * Runtime renderer: takes a *_tpl.docx (produced by buildDocxTemplate.ts) and
 * its companion *_mapping.json, evaluates every DataSpec against the supplied
 * JsonResume, and fills the template with docxtemplater v3.
 *
 * Public API:
 *   renderDocxFromTemplate(tplPath, mappingPath, resume, outPath) → Promise<void>
 */

import fs from 'fs';
import path from 'path';
import type { DocxMapping, DocxDataSpec, JsonResume } from './types.js';

type DataSpec = DocxDataSpec;

// CJS interop
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

// ─── Path evaluation helpers ──────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

/** Resolve a dot-notation path against an object. "basics.location.city" etc. */
function getPath(obj: unknown, dotPath: string): unknown {
    return dotPath.split('.').reduce((acc: unknown, key) => {
        if (acc == null) return undefined;
        return (acc as AnyRecord)[key];
    }, obj);
}

/** Strip HTML tags from a string. */
function stripHtml(text: string): string {
    return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** Format a YYYY-MM or YYYY-MM-DD date string to "Mon YYYY" or "PRESENT". */
function formatDate(d?: string): string {
    if (!d) return 'PRESENT';
    const [year, month] = d.split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const m = month ? months[parseInt(month, 10) - 1] : undefined;
    return m ? `${m} ${year}` : year;
}

// ─── DataSpec evaluators ──────────────────────────────────────────────────────

/** Evaluate a DataSpec against a top-level JsonResume object. */
function evalSpec(spec: DataSpec, resume: JsonResume): unknown {
    if (!spec || typeof spec !== 'object') return '';
    const s = spec as AnyRecord;

    switch (s['type'] as string) {
        case 'path': {
            const val = getPath(resume, s['path'] as string);
            // Auto-join arrays of strings (e.g. skills.keywords pre-joined)
            if (Array.isArray(val)) return stripHtml((val as string[]).map(v => stripHtml(String(v))).join(', '));
            if (typeof val === 'string') return stripHtml(val);
            return val ?? '';
        }
        case 'split': {
            const val = (getPath(resume, s['path'] as string) as string) ?? '';
            const parts = val.split(s['by'] as string);
            return (parts[s['index'] as number] ?? '').trim();
        }
        case 'literal': {
            return s['value'] ?? '';
        }
        case 'concat': {
            const paths = s['paths'] as string[];
            return stripHtml(paths.map(p => (getPath(resume, p) as string) ?? '').join(s['sep'] as string));
        }
        case 'profile': {
            const profiles = ((resume.basics as AnyRecord | undefined)?.['profiles'] as Array<AnyRecord>) ?? [];
            const network = (s['network'] as string).toLowerCase();
            const prof = profiles.find(p => (p['network'] as string)?.toLowerCase() === network);
            return prof ? (prof[s['field'] as string] as string) ?? '' : '';
        }
        case 'splitSentences': {
            const rawText = stripHtml((getPath(resume, s['path'] as string) as string) ?? '');
            const sentences = rawText.split(/(?<=\.)\ +/).map(t => t.trim()).filter(Boolean);
            if (sentences.length === 0) return [{ [s['itemField'] as string]: rawText }];
            return sentences.map(t => ({ [s['itemField'] as string]: stripHtml(t) }));
        }
        case 'formatDate': {
            return formatDate((getPath(resume, s['path'] as string) as string) ?? undefined);
        }
        case 'array': {
            const arr = (getPath(resume, s['path'] as string) as unknown[]) ?? [];
            const itemMap = s['itemMap'] as Record<string, DataSpec>;
            return arr.map(item => {
                const obj: AnyRecord = {};
                for (const [k, subSpec] of Object.entries(itemMap)) {
                    obj[k] = evalItemSpec(subSpec, item as AnyRecord);
                }
                return obj;
            });
        }
        case 'certs': {
            const certs = (resume.certificates as unknown as Array<AnyRecord>) ?? [];
            const isInProgress = s['inProgress'] as boolean;
            // Heuristic: if cert has no date, or date is in the future → in-progress
            const now = new Date();
            const filtered = isInProgress
                ? certs.filter(c => !c['date'] || new Date(c['date'] as string) > now)
                : certs.filter(c => c['date'] && new Date(c['date'] as string) <= now);
            return filtered.map(c => c['name'] as string).filter(Boolean).join('\n');
        }
        default:
            return '';
    }
}

/**
 * Evaluate a DataSpec against a single array item (used inside "array" itemMap).
 * Paths are relative to the item itself (e.g. "name" not "work[0].name").
 */
function evalItemSpec(spec: DataSpec, item: AnyRecord): unknown {
    if (!spec || typeof spec !== 'object') return '';
    const s = spec as AnyRecord;

    switch (s['type'] as string) {
        case 'path': {
            const val = item[s['path'] as string];
            // Auto-join string arrays (e.g. keywords: ['React', 'TypeScript'] → 'React, TypeScript')
            if (Array.isArray(val)) return stripHtml((val as string[]).map(v => stripHtml(String(v))).join(', '));
            if (typeof val === 'string') return stripHtml(val);
            return val ?? '';
        }
        case 'split': {
            const val = (item[s['path'] as string] as string) ?? '';
            const parts = val.split(s['by'] as string);
            return (parts[s['index'] as number] ?? '').trim();
        }
        case 'literal': {
            return s['value'] ?? '';
        }
        case 'concat': {
            const paths = s['paths'] as string[];
            const sep = s['sep'] as string;
            const parts = paths.map(p => {
                const v = item[p];
                if (Array.isArray(v)) return stripHtml((v as string[]).map(x => stripHtml(String(x))).join(sep));
                return stripHtml(String(v ?? ''));
            });
            return parts.join(sep);
        }
        case 'formatDate': {
            return formatDate((item[s['path'] as string] as string) ?? undefined);
        }
        case 'extractPrefix': {
            const highlights = (item['highlights'] as string[]) ?? [];
            const prefix = s['prefix'] as string;
            const match = highlights.find(h => h.startsWith(prefix));
            return match ? match.slice(prefix.length).trim() : '';
        }
        case 'filterRest': {
            const highlights = (item['highlights'] as string[]) ?? [];
            const exclude = s['exclude'] as string[];
            const itemField = s['itemField'] as string;
            const filtered = highlights.filter(h => !exclude.some(ex => h.startsWith(ex)));
            return filtered.map(h => ({ [itemField]: stripHtml(h) }));
        }
        case 'array': {
            // Nested array (rare, but handle it)
            const arr = (item[s['path'] as string] as unknown[]) ?? [];
            const itemMap = s['itemMap'] as Record<string, DataSpec>;
            return arr.map(subItem => {
                const obj: AnyRecord = {};
                for (const [k, subSpec] of Object.entries(itemMap)) {
                    obj[k] = evalItemSpec(subSpec, subItem as AnyRecord);
                }
                return obj;
            });
        }
        default:
            return '';
    }
}

// ─── Build template data object ───────────────────────────────────────────────

/** Set a value at a dotted path in an object, creating intermediates as needed. */
function setNestedPath(obj: AnyRecord, keyPath: string, value: unknown): void {
    // Handle simple array index patterns: profiles[0].username → profiles[0][username]
    // We only handle simple dotted paths here (no [ ] index expressions)
    const parts = keyPath.split('.');
    if (parts.length === 1) {
        obj[keyPath] = value;
        return;
    }
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (current[part] == null || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part] as AnyRecord;
    }
    current[parts[parts.length - 1]] = value;
}

function buildTemplateData(mapping: DocxMapping, resume: JsonResume): AnyRecord {
    const data: AnyRecord = {};
    for (const [key, spec] of Object.entries(mapping.data)) {
        const value = evalSpec(spec as DataSpec, resume);
        // If key contains dots, build a nested object structure (docxtemplater resolves nested paths)
        if (key.includes('.') || key.includes('[')) {
            setNestedPath(data, key.replace(/\[(\d+)\]/g, '.$1'), value);
        } else {
            data[key] = value;
        }
    }
    // Pass-through common nested structures so templates can use {location.city} etc. naturally
    const basics = (resume.basics ?? {}) as AnyRecord;
    if (!data['location'] && basics['location']) data['location'] = basics['location'];
    if (!data['profiles'] && basics['profiles']) data['profiles'] = basics['profiles'];
    return data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function renderDocxFromTemplate(
    tplPath: string,
    mappingPath: string,
    resume: JsonResume,
    outPath: string,
): Promise<void> {
    if (!fs.existsSync(tplPath)) throw new Error(`Template not found: ${tplPath}`);
    if (!fs.existsSync(mappingPath)) throw new Error(`Mapping not found: ${mappingPath}`);

    const mapping: DocxMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
    const templateData = buildTemplateData(mapping, resume);

    const content = fs.readFileSync(tplPath, 'binary');
    const zip = new PizZip(content);

    const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        // Suppress "tag not found" errors — unknown placeholders rendered as empty string
        nullGetter: () => '',
    });

    doc.render(templateData);

    const buf: Buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
}
