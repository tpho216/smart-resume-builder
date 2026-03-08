#!/usr/bin/env node
/**
 * analyzeStructure.ts — Analyze an uploaded resume's section structure,
 * ordering, and hierarchy to produce a layout blueprint.
 *
 * Input: parsed resume JSON (from parseUploadedResume.ts) or raw text file.
 * Output: A structure analysis JSON describing sections, their order, and
 *         content style (bullets, prose, grid, etc.).
 *
 * Usage:
 *   node dist/analyzeStructure.js <parsed.json|resume.txt> [--output structure.json]
 */

import fs from 'fs';
import path from 'path';
import { extractParagraphs, detectHeadingCandidates } from './parseUploadedResume';
import type { ContentStyle, StructureAnalysis, HeadingCandidate, SectionAnalysis, HeaderBlock, LayoutHints } from './types';

// ---------------------------------------------------------------------------
// Known resume section patterns
// ---------------------------------------------------------------------------

interface SectionPattern {
    key: string;
    patterns: RegExp[];
}

export const SECTION_PATTERNS: SectionPattern[] = [
    { key: 'contact', patterns: [/^contact/i, /^personal\s+(info|details)/i] },
    { key: 'summary', patterns: [/^(professional\s+)?summary/i, /^(career\s+)?objective/i, /^profile/i, /^about(\s+me)?/i, /^overview/i] },
    { key: 'experience', patterns: [/^(work\s+)?experience/i, /^employment/i, /^professional\s+experience/i, /^work\s+history/i, /^career\s+history/i] },
    { key: 'education', patterns: [/^education/i, /^academic/i, /^qualifications/i] },
    { key: 'skills', patterns: [/^(technical\s+)?skills/i, /^competenc/i, /^expertise/i, /^technologies/i, /^tech\s+stack/i] },
    { key: 'projects', patterns: [/^projects/i, /^key\s+projects/i, /^portfolio/i, /^selected\s+projects/i] },
    { key: 'certificates', patterns: [/^certific/i, /^licen[sc]es?/i, /^professional\s+development/i] },
    { key: 'awards', patterns: [/^awards/i, /^honours/i, /^honors/i, /^achievements/i] },
    { key: 'publications', patterns: [/^publications/i, /^papers/i, /^research/i] },
    { key: 'languages', patterns: [/^languages/i] },
    { key: 'interests', patterns: [/^interests/i, /^hobbies/i] },
    { key: 'references', patterns: [/^references/i, /^referees/i] },
    { key: 'volunteer', patterns: [/^volunteer/i, /^community/i] },
];

/**
 * Match a heading line to a known section key.
 */
export function matchSection(text: string): string | null {
    const clean = text.replace(/[:\-–—|]/g, '').trim();
    for (const sec of SECTION_PATTERNS) {
        for (const pat of sec.patterns) {
            if (pat.test(clean)) return sec.key;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Content style detection
// ---------------------------------------------------------------------------

/**
 * Analyze lines between two headings to determine content style.
 */
export function analyzeContentStyle(lines: string[]): ContentStyle {
    if (lines.length === 0) return { type: 'empty', bulletCount: 0, lineCount: 0 };

    let bulletCount = 0;
    let dateCount = 0;
    let shortLineCount = 0;
    let totalChars = 0;

    const datePattern = /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}\b|\bpresent\b/i;
    const bulletPattern = /^[\-•●▪◦\*]\s|^\d+[\.\)]\s/;

    for (const line of lines) {
        if (bulletPattern.test(line)) bulletCount++;
        if (datePattern.test(line)) dateCount++;
        if (line.length < 50) shortLineCount++;
        totalChars += line.length;
    }

    const avgLength = totalChars / lines.length;
    const bulletRatio = bulletCount / lines.length;

    let type: ContentStyle['type'] = 'prose'; // default
    if (bulletRatio > 0.5) type = 'bullets';
    else if (shortLineCount / lines.length > 0.7 && avgLength < 40) type = 'list';
    else if (lines.length <= 2 && avgLength > 80) type = 'paragraph';

    return {
        type,
        lineCount: lines.length,
        bulletCount,
        dateCount,
        avgLineLength: Math.round(avgLength),
        hasDates: dateCount > 0,
    };
}

// ---------------------------------------------------------------------------
// Structure analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a resume's section structure from paragraphs.
 */
export function analyzeStructure(paragraphs: string[], headingCandidates: HeadingCandidate[] | null = null): StructureAnalysis {
    if (!headingCandidates) {
        headingCandidates = detectHeadingCandidates(paragraphs).filter(h => h.isLikelyHeading);
    }

    // Build section map
    const sections: SectionAnalysis[] = [];
    const sectionOrder: string[] = [];
    let nameCandidate: string | null = null;

    // Try to identify the candidate's name (usually the first or second line, longer than 2 chars)
    for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
        const line = paragraphs[i];
        if (line.length > 2 && line.length < 60 && !matchSection(line)) {
            nameCandidate = line;
            break;
        }
    }

    // Walk through heading candidates and assign sections
    for (let i = 0; i < headingCandidates.length; i++) {
        const heading = headingCandidates[i];
        const sectionKey = matchSection(heading.text);

        // Determine content lines: everything between this heading and the next
        const startIdx = heading.index + 1;
        const endIdx = i + 1 < headingCandidates.length
            ? headingCandidates[i + 1].index
            : paragraphs.length;

        const contentLines = paragraphs.slice(startIdx, endIdx);
        const style = analyzeContentStyle(contentLines);

        const section: SectionAnalysis = {
            heading: heading.text,
            sectionKey: sectionKey || 'unknown',
            order: sections.length,
            paragraphIndex: heading.index,
            contentStyle: style,
            lineCount: contentLines.length,
        };

        sections.push(section);
        if (sectionKey) sectionOrder.push(sectionKey);
    }

    // Detect if there's a header/summary block before the first heading
    let headerBlock: HeaderBlock | null = null;
    if (headingCandidates.length > 0 && headingCandidates[0].index > 0) {
        const headerLines = paragraphs.slice(0, headingCandidates[0].index);
        headerBlock = {
            lines: headerLines,
            lineCount: headerLines.length,
            hasSummary: headerLines.some(l => l.length > 100),
        };
    }

    // Detect overall layout hints
    const hasContactSection = sectionOrder.includes('contact');
    const hasSummary = sectionOrder.includes('summary') || (headerBlock !== null && headerBlock.hasSummary);
    const experienceFirst = sectionOrder.indexOf('experience') < sectionOrder.indexOf('education');
    const skillsPosition = sectionOrder.indexOf('skills');
    const skillsEarly = skillsPosition >= 0 && skillsPosition <= 2;

    const layoutHints: LayoutHints = {
        hasContactSection,
        hasSummarySection: hasSummary,
        experienceBeforeEducation: experienceFirst,
        skillsEarly,
        totalSections: sections.length,
        detectedSections: sectionOrder.length,
        unknownSections: sections.filter(s => s.sectionKey === 'unknown').length,
    };

    return {
        nameCandidate,
        sectionOrder,
        sections,
        headerBlock,
        layoutHints,
        totalParagraphs: paragraphs.length,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node dist/analyzeStructure.js <parsed.json|resume.txt> [--output structure.json]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const inputPath = args[0];
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File not found: ${inputPath}`);
        process.exit(1);
    }

    let paragraphs: string[];
    let headingCandidates: HeadingCandidate[] | null = null;
    const ext = path.extname(inputPath).toLowerCase();

    if (ext === '.json') {
        // Expect parsed resume JSON
        const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
        paragraphs = parsed.paragraphs;
        headingCandidates = parsed.headingCandidates || null;
    } else {
        // Treat as raw text
        const text = fs.readFileSync(inputPath, 'utf-8');
        paragraphs = extractParagraphs(text);
    }

    const analysis = analyzeStructure(paragraphs, headingCandidates);

    console.log(`Name candidate: ${analysis.nameCandidate || 'N/A'}`);
    console.log(`Sections found: ${analysis.sections.length}`);
    console.log(`Section order:  ${analysis.sectionOrder.join(' → ')}`);
    console.log(`Layout hints:`);
    console.log(`  Experience before Education: ${analysis.layoutHints.experienceBeforeEducation}`);
    console.log(`  Skills early:               ${analysis.layoutHints.skillsEarly}`);
    console.log(`  Has summary:                ${analysis.layoutHints.hasSummarySection}`);

    // Output
    const outputIdx = args.indexOf('--output');
    if (outputIdx !== -1 && args[outputIdx + 1]) {
        const outPath = args[outputIdx + 1];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2));
        console.log(`\nStructure analysis → ${outPath}`);
    } else {
        console.log('\nSections:');
        analysis.sections.forEach((s, i) => {
            console.log(`  ${i + 1}. [${s.sectionKey}] "${s.heading}" — ${s.contentStyle.type} (${s.lineCount} lines)`);
        });
    }
}

if (require.main === module) main();
