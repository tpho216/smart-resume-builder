#!/usr/bin/env node
/**
 * phase2Pipeline.ts — Full Phase 2 pipeline: upload → parse → analyze → theme → render.
 *
 * Takes an uploaded resume (PDF/DOCX) + optionally a job ad, and produces
 * a custom-themed tailored resume that mirrors the uploaded resume's structure.
 *
 * Usage:
 *   node dist/phase2Pipeline.js <uploaded-resume.pdf|.docx> [--job-ad job_ads/file.txt] [--base base-resume.json]
 *
 * Steps:
 *   1. Parse uploaded resume → extract text + paragraphs
 *   2. Analyze structure → section order + content styles
 *   3. Generate custom theme from structure
 *   4. (Optional) Tailor base-resume.json for job ad
 *   5. Render using generated theme → HTML + PDF
 *   6. (Optional) Score against job ad
 */

import fs from 'fs';
import path from 'path';
import { parseUploadedResume } from './parseUploadedResume';
import { analyzeStructure } from './analyzeStructure';
import { generateTheme, previewWithTheme } from './generateTheme';
import { renderToPdf } from './renderResume';
import { renderToDocx } from './renderDocx';
import type { JsonResume, ScoreReport, Phase2PipelineOptions, Phase2PipelineResult } from './types';

// Optional Phase 1 imports (only used when --job-ad is provided)
let extractKeywordsFn: ((text: string) => { keywords: string[] }) | undefined;
let deriveSeniorityFn: ((text: string) => string) | undefined;
let tailorResumeFn: ((base: JsonResume, keywords: string[], seniority: string) => JsonResume) | undefined;
let llmTailorResumeFn: ((base: JsonResume, jobAdText: string, keywords: string[], seniority: string) => Promise<JsonResume>) | undefined;
let calculateScoreFn: ((jobAdText: string, resume: JsonResume) => ScoreReport) | undefined;

try {
    const parseJobAd = require('./parseJobAd');
    extractKeywordsFn = parseJobAd.extractKeywords;
    deriveSeniorityFn = parseJobAd.deriveSeniority;
    const tailorMod = require('./tailorResume');
    tailorResumeFn = tailorMod.tailorResume;
    const llmMod = require('./llmTailorResume');
    llmTailorResumeFn = llmMod.llmTailorResume;
    const scoreMod = require('./scoreResume');
    calculateScoreFn = scoreMod.calculateScore;
} catch { /* Phase 1 scripts optional */ }

const DEFAULT_BASE = path.join(__dirname, '..', 'base-resume.json');

export async function runPhase2Pipeline(options: Phase2PipelineOptions): Promise<Phase2PipelineResult> {
    const {
        uploadedResumePath,
        jobAdPath = null,
        basePath = DEFAULT_BASE,
        outputDir = null,
        mode = 'programmatic',
    } = options;

    const uploadName = path.basename(uploadedResumePath, path.extname(uploadedResumePath));
    const outDir = outputDir || path.join(__dirname, '..', 'outputs', `phase2_${uploadName}`);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Phase 2 Pipeline: ${path.basename(uploadedResumePath)}`);
    console.log(`${'='.repeat(60)}`);

    // ── Step 1: Parse uploaded resume ────────────────────────
    console.log('\n[1/5] Parsing uploaded resume...');
    const parsed = await parseUploadedResume(uploadedResumePath);
    const parsedPath = path.join(outDir, 'parsed_resume.json');

    // Save (without huge HTML blob)
    const parsedForSave: Record<string, unknown> = { ...parsed };
    if (typeof parsedForSave.html === 'string' && (parsedForSave.html as string).length > 5000) {
        parsedForSave.htmlPreview = (parsedForSave.html as string).substring(0, 2000);
        delete parsedForSave.html;
    }
    fs.writeFileSync(parsedPath, JSON.stringify(parsedForSave, null, 2));
    console.log(`       Paragraphs: ${parsed.totalParagraphs}`);
    console.log(`       Headings:   ${parsed.totalHeadingCandidates}`);
    console.log(`       → ${parsedPath}`);

    // ── Step 2: Analyze structure ────────────────────────────
    console.log('\n[2/5] Analyzing structure...');
    const structure = analyzeStructure(parsed.paragraphs, parsed.headingCandidates);
    const structurePath = path.join(outDir, 'structure_analysis.json');
    fs.writeFileSync(structurePath, JSON.stringify(structure, null, 2));
    console.log(`       Name:    ${structure.nameCandidate || 'N/A'}`);
    console.log(`       Sections: ${structure.sectionOrder.join(' → ')}`);
    console.log(`       → ${structurePath}`);

    // ── Step 3: Generate theme ───────────────────────────────
    console.log('\n[3/5] Generating custom theme...');
    const theme = generateTheme(structure);
    const themeDir = path.join(outDir, 'theme');
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, 'index.js'), theme.indexJs);
    fs.writeFileSync(path.join(themeDir, 'package.json'), JSON.stringify({
        name: 'jsonresume-theme-custom-generated',
        version: '1.0.0',
        main: 'index.js',
    }, null, 2));
    console.log(`       Section order: ${theme.sectionOrder.join(' → ')}`);
    console.log(`       → ${themeDir}/index.js`);

    // ── Step 4: Tailor resume (if job ad provided) ───────────
    let resumeToRender: JsonResume;
    if (jobAdPath && fs.existsSync(jobAdPath) && extractKeywordsFn && deriveSeniorityFn) {
        console.log(`\n[4/5] Tailoring resume for job ad (mode: ${mode})...`);
        const baseResume: JsonResume = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
        const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
        const { keywords } = extractKeywordsFn(jobAdText);
        const seniority = deriveSeniorityFn(jobAdText);
        console.log(`       Keywords: ${keywords.length}, Seniority: ${seniority}`);

        if (mode === 'llm' && llmTailorResumeFn) {
            console.log('       Calling LLM...');
            resumeToRender = await llmTailorResumeFn(baseResume, jobAdText, keywords, seniority);
        } else if (tailorResumeFn) {
            resumeToRender = tailorResumeFn(baseResume, keywords, seniority);
        } else {
            resumeToRender = baseResume;
        }

        const tailoredPath = path.join(outDir, 'tailored_resume.json');
        fs.writeFileSync(tailoredPath, JSON.stringify(resumeToRender, null, 2));
        console.log(`       → ${tailoredPath}`);
    } else {
        console.log('\n[4/5] No job ad provided — using base resume...');
        resumeToRender = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
    }

    // ── Step 5: Render with generated theme ──────────────────
    console.log('\n[5/5] Rendering with custom theme...');
    const html = previewWithTheme(theme.indexJs, resumeToRender as Record<string, unknown>);
    const name = (resumeToRender.basics && resumeToRender.basics.name) || 'Resume';
    const safeName = name.replace(/\s+/g, '_');

    const htmlPath = path.join(outDir, `Resume_${safeName}.html`);
    fs.writeFileSync(htmlPath, html);
    console.log(`       HTML → ${htmlPath}`);

    // PDF
    const pdfPath = path.join(outDir, `Resume_${safeName}.pdf`);
    const pdfOk = await renderToPdf(html, pdfPath);
    if (pdfOk) {
        console.log(`       PDF  → ${pdfPath}`);
    } else {
        console.log('       PDF skipped (puppeteer not available)');
    }

    // DOCX — uses reference structure for faithful layout replication
    const docxPath = path.join(outDir, `Resume_${safeName}.docx`);
    const docxBuffer = await renderToDocx(resumeToRender, structure);
    fs.writeFileSync(docxPath, docxBuffer);
    console.log(`       DOCX → ${docxPath}`);

    // ── Optional: Score ──────────────────────────────────────
    let score: ScoreReport | null = null;
    if (jobAdPath && fs.existsSync(jobAdPath) && calculateScoreFn) {
        const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
        score = calculateScoreFn(jobAdText, resumeToRender);
        const scorePath = path.join(outDir, 'score.json');
        fs.writeFileSync(scorePath, JSON.stringify(score, null, 2));
        console.log(`\n       Match Score: ${score.matchScore}%`);
        console.log(`       ATS Parsing: ${score.atsParsing}`);
    }

    // ── Summary ──────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log('Phase 2 Pipeline Complete');
    console.log(`Output directory: ${outDir}`);
    console.log(`${'='.repeat(60)}\n`);

    return { outDir, structure, theme, score };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node dist/phase2Pipeline.js <resume.pdf|.docx> [--job-ad ad.txt] [--base base-resume.json] [--output dir]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const uploadedResumePath = args[0];
    if (!fs.existsSync(uploadedResumePath)) {
        console.error(`Error: File not found: ${uploadedResumePath}`);
        process.exit(1);
    }

    const jobAdIdx = args.indexOf('--job-ad');
    const baseIdx = args.indexOf('--base');
    const outIdx = args.indexOf('--output');
    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx !== -1 ? (args[modeIdx + 1] as 'programmatic' | 'llm') : 'programmatic';

    await runPhase2Pipeline({
        uploadedResumePath,
        jobAdPath: jobAdIdx !== -1 ? args[jobAdIdx + 1] : null,
        basePath: baseIdx !== -1 ? args[baseIdx + 1] : DEFAULT_BASE,
        outputDir: outIdx !== -1 ? args[outIdx + 1] : null,
        mode,
    });
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
