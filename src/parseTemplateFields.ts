/**
 * parseTemplateFields.ts
 *
 * Parses a .docx Docxtemplater template file and extracts all mustache-style
 * {field} placeholders, grouped by their enclosing section loops.
 *
 * Used by llmTailorResume to auto-inject a TEMPLATE FIELD REQUIREMENTS hint
 * into the LLM prompt so the LLM always populates exactly the right fields.
 */

import fs from 'fs';
import PizZip from 'pizzip';

export interface TemplateSectionFields {
    /** The loop variable, e.g. "projects", "work", "education" */
    loopVar: string;
    /** All simple {field} placeholders found inside the loop (excludes loop markers) */
    fields: string[];
    /** Nested loop vars found inside, e.g. ["highlights"] */
    nestedLoops: string[];
}

export interface ParsedTemplateFields {
    /** Fields grouped by section loop */
    sections: TemplateSectionFields[];
    /** All top-level (non-loop) fields */
    topLevelFields: string[];
}

/**
 * DOCX XML splits text across <w:r><w:t> run elements, which can fragment
 * mustache tokens like `{na` / `me}` across separate runs. We join all text
 * content first, then extract tokens from the joined string.
 */
function extractTextFromDocxXml(xml: string): string {
    // Extract content of all <w:t> tags (the actual text runs)
    const runs: string[] = [];
    for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
        runs.push(match[1]);
    }
    return runs.join('');
}

/**
 * Parse a .docx template file and return all mustache fields grouped by
 * their enclosing section loops.
 */
export function parseTemplateFields(templatePath: string): ParsedTemplateFields {
    if (!fs.existsSync(templatePath)) {
        return { sections: [], topLevelFields: [] };
    }

    const buffer = fs.readFileSync(templatePath);
    const zip = new PizZip(buffer);

    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) return { sections: [], topLevelFields: [] };

    const xml = xmlFile.asText();
    const text = extractTextFromDocxXml(xml);

    // Tokenise: find all {token} occurrences
    const allTokens = [...text.matchAll(/\{([^{}]+)\}/g)].map(m => m[1].trim());

    const sections: TemplateSectionFields[] = [];
    const topLevelFields: string[] = [];

    // Track which section loop we're currently inside (simple single-depth parser)
    const sectionStack: string[] = [];

    // Accumulate fields per section as we scan tokens
    const sectionFieldsMap: Map<string, Set<string>> = new Map();
    const sectionNestedMap: Map<string, Set<string>> = new Map();

    for (const token of allTokens) {
        if (token.startsWith('#')) {
            // Opening loop: {#loopVar}
            const loopVar = token.slice(1);
            if (sectionStack.length > 0) {
                // Nested loop — record as nested in parent
                const parent = sectionStack[sectionStack.length - 1];
                if (!sectionNestedMap.has(parent)) sectionNestedMap.set(parent, new Set());
                sectionNestedMap.get(parent)!.add(loopVar);
            } else {
                // Top-level section loop
                if (!sectionFieldsMap.has(loopVar)) sectionFieldsMap.set(loopVar, new Set());
            }
            sectionStack.push(loopVar);
        } else if (token.startsWith('/')) {
            // Closing loop: {/loopVar}
            if (sectionStack.length > 0) sectionStack.pop();
        } else {
            // Plain field
            if (sectionStack.length === 0) {
                topLevelFields.push(token);
            } else {
                // Attribute belongs to the outermost (section) loop, not the nested item loop
                const outermost = sectionStack[0];
                if (!sectionFieldsMap.has(outermost)) sectionFieldsMap.set(outermost, new Set());
                sectionFieldsMap.get(outermost)!.add(token);
            }
        }
    }

    for (const [loopVar, fieldSet] of sectionFieldsMap) {
        const nestedSet = sectionNestedMap.get(loopVar) ?? new Set<string>();
        // Exclude fields that are actually loop item vars of nested loops
        const fields = [...fieldSet].filter(f => !nestedSet.has(f));
        sections.push({
            loopVar,
            fields,
            nestedLoops: [...nestedSet],
        });
    }

    return {
        sections,
        topLevelFields: [...new Set(topLevelFields)],
    };
}

/**
 * Produce a human-readable field requirements hint for injection into the LLM prompt.
 * Example output:
 *
 *   DOCX TEMPLATE FIELD REQUIREMENTS (auto-detected):
 *   - Each "projects" entry MUST include these fields: name, startDate, endDate, description, responsibilities, technologies
 *     (plus highlights array items rendered via nested loop)
 *   - Each "work" entry MUST include: name, position, startDate, endDate, summary
 *   Do NOT omit any listed field — missing fields will render as blank in the output document.
 */
export function buildTemplateFieldHint(parsed: ParsedTemplateFields): string {
    if (parsed.sections.length === 0) return '';

    const lines: string[] = [
        'DOCX TEMPLATE FIELD REQUIREMENTS (auto-detected from resume template):',
    ];

    for (const sec of parsed.sections) {
        const fieldList = sec.fields.join(', ');
        const nestedNote = sec.nestedLoops.length
            ? ` (plus nested loop: ${sec.nestedLoops.join(', ')})`
            : '';
        lines.push(`- Each "${sec.loopVar}" entry MUST include these fields: ${fieldList}${nestedNote}`);
    }

    lines.push('Do NOT omit any listed field — missing fields will render as blank in the output document.');
    return lines.join('\n');
}
