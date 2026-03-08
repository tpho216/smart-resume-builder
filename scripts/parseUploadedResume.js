#!/usr/bin/env node
/**
 * parseUploadedResume.js — Parse an uploaded resume (PDF or DOCX) and extract
 * raw text, paragraphs, and basic formatting hints.
 *
 * Supports: .pdf (via pdf-parse), .docx (via mammoth)
 *
 * Usage:
 *   node scripts/parseUploadedResume.js <resume.pdf|resume.docx> [--output parsed.json]
 *
 * Output: JSON with extracted text blocks, paragraph list, and metadata.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// PDF parsing
// ---------------------------------------------------------------------------

/**
 * Parse a PDF file and extract text with page-level structure.
 * @param {string} filePath - Path to PDF
 * @returns {Promise<{ pages: string[], fullText: string, meta: object }>}
 */
async function parsePdf(filePath) {
    let pdfParse;
    try {
        pdfParse = require('pdf-parse');
    } catch (e) {
        throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
    }

    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);

    // Split by page (pdf-parse joins them, but we can split on form-feed heuristic)
    const pages = data.text.split(/\f/).filter(p => p.trim());
    const fullText = data.text;

    return {
        format: 'pdf',
        pages,
        fullText,
        meta: {
            pageCount: data.numpages || pages.length,
            info: data.info || {},
        },
    };
}

// ---------------------------------------------------------------------------
// DOCX parsing
// ---------------------------------------------------------------------------

/**
 * Parse a DOCX file and extract text + HTML structure.
 * @param {string} filePath - Path to DOCX
 * @returns {Promise<{ html: string, fullText: string, messages: object[] }>}
 */
async function parseDocx(filePath) {
    let mammoth;
    try {
        mammoth = require('mammoth');
    } catch (e) {
        throw new Error('mammoth not installed. Run: npm install mammoth');
    }

    const buffer = fs.readFileSync(filePath);

    // Extract HTML (preserves headings, lists, bold, etc.)
    const htmlResult = await mammoth.convertToHtml({ buffer });

    // Extract raw text
    const textResult = await mammoth.extractRawText({ buffer });

    return {
        format: 'docx',
        html: htmlResult.value,
        fullText: textResult.value,
        messages: htmlResult.messages,
        meta: {},
    };
}

// ---------------------------------------------------------------------------
// Paragraph extraction — format-agnostic
// ---------------------------------------------------------------------------

/**
 * Split raw text into meaningful paragraphs / lines.
 * Strips excessive whitespace, preserves logical blocks.
 */
function extractParagraphs(fullText) {
    return fullText
        .split(/\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
}

/**
 * Detect likely heading lines (heuristic: short line, possibly ALL CAPS or
 * ending with colon, not preceded by bullet).
 */
function detectHeadingCandidates(paragraphs) {
    return paragraphs.map((line, index) => {
        const isShort = line.length < 60;
        const isAllCaps = line === line.toUpperCase() && /[A-Z]/.test(line);
        const endsWithColon = line.endsWith(':');
        const hasNoLeadingBullet = !/^[\-•●▪◦\*\d+\.\)]/.test(line);
        const looksLikeHeading = isShort && hasNoLeadingBullet && (isAllCaps || endsWithColon);

        return {
            index,
            text: line,
            isLikelyHeading: looksLikeHeading,
            isAllCaps,
            endsWithColon,
            charCount: line.length,
        };
    });
}

// ---------------------------------------------------------------------------
// Unified parse entry point
// ---------------------------------------------------------------------------

/**
 * Parse any supported resume file.
 * @param {string} filePath - Path to .pdf or .docx
 * @returns {Promise<object>} Parsed result with text, paragraphs, headings
 */
async function parseUploadedResume(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    let raw;
    if (ext === '.pdf') {
        raw = await parsePdf(filePath);
    } else if (ext === '.docx') {
        raw = await parseDocx(filePath);
    } else {
        throw new Error(`Unsupported format: ${ext}. Supported: .pdf, .docx`);
    }

    const paragraphs = extractParagraphs(raw.fullText);
    const headingCandidates = detectHeadingCandidates(paragraphs);

    return {
        ...raw,
        paragraphs,
        headingCandidates: headingCandidates.filter(h => h.isLikelyHeading),
        totalParagraphs: paragraphs.length,
        totalHeadingCandidates: headingCandidates.filter(h => h.isLikelyHeading).length,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/parseUploadedResume.js <resume.pdf|resume.docx> [--output parsed.json]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const inputPath = args[0];
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File not found: ${inputPath}`);
        process.exit(1);
    }

    console.log(`Parsing: ${inputPath}`);
    const result = await parseUploadedResume(inputPath);

    console.log(`Format:     ${result.format}`);
    console.log(`Paragraphs: ${result.totalParagraphs}`);
    console.log(`Heading candidates: ${result.totalHeadingCandidates}`);

    // Output
    const outputIdx = args.indexOf('--output');
    if (outputIdx !== -1 && args[outputIdx + 1]) {
        const outPath = args[outputIdx + 1];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        // Omit html field for cleaner JSON (can be huge)
        const output = { ...result };
        if (output.html && output.html.length > 5000) {
            output._htmlTruncated = true;
            output.htmlPreview = output.html.substring(0, 2000) + '...';
            delete output.html;
        }
        fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
        console.log(`Output → ${outPath}`);
    } else {
        // Print heading candidates
        console.log('\nDetected heading candidates:');
        result.headingCandidates.forEach(h => {
            console.log(`  [${h.index}] ${h.text}`);
        });
    }
}

module.exports = { parseUploadedResume, parsePdf, parseDocx, extractParagraphs, detectHeadingCandidates };

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
