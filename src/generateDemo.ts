#!/usr/bin/env node
/**
 * generateDemo.ts — Generate pre-built demo outputs for all dummy job ads
 * and Phase 2 sample resumes.
 * These outputs are committed to the repo for the GitHub Pages demo.
 *
 * Usage: node dist/generateDemo.js
 */

import fs from 'fs';
import path from 'path';
import { extractKeywords, deriveSeniority } from './parseJobAd';
import { tailorResume } from './tailorResume';
import { renderBuiltInHtml, renderToPdf } from './renderResume';
import { calculateScore } from './scoreResume';
import { extractParagraphs, detectHeadingCandidates, parseUploadedResume } from './parseUploadedResume';
import { analyzeStructure } from './analyzeStructure';
import { generateTheme, previewWithTheme } from './generateTheme';
import type { JsonResume, DemoEntry, Phase2DemoEntry } from './types';

const BASE_RESUME_PATH = path.join(__dirname, '..', 'base-resume.json');
const JOB_ADS_DIR = path.join(__dirname, '..', 'job_ads');
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');
const DOCS_DIR = path.join(__dirname, '..', 'docs');

async function main(): Promise<void> {
    const baseResume: JsonResume = JSON.parse(fs.readFileSync(BASE_RESUME_PATH, 'utf-8'));
    const jobAdFiles = fs.readdirSync(JOB_ADS_DIR).filter(f => f.endsWith('.txt'));

    if (jobAdFiles.length === 0) {
        console.log('No job ads found in job_ads/');
        return;
    }

    const demoIndex: DemoEntry[] = [];

    for (const file of jobAdFiles) {
        const jobAdPath = path.join(JOB_ADS_DIR, file);
        const jobName = path.basename(file, '.txt');
        const outDir = path.join(OUTPUTS_DIR, `job_${jobName}`);
        fs.mkdirSync(outDir, { recursive: true });

        console.log(`\nGenerating demo: ${jobName}`);

        // Parse + Tailor
        const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
        const { keywords } = extractKeywords(jobAdText);
        const seniority = deriveSeniority(jobAdText);
        const tailored = tailorResume(baseResume, keywords, seniority);

        // Save tailored resume
        const tailoredPath = path.join(outDir, 'tailored_resume.json');
        fs.writeFileSync(tailoredPath, JSON.stringify(tailored, null, 2));

        // Render HTML (built-in, no theme dependency needed)
        const name = (tailored.basics && tailored.basics.name) || 'Resume';
        const safeName = name.replace(/\s+/g, '_');
        const html = renderBuiltInHtml(tailored);
        const htmlPath = path.join(outDir, `Resume_${safeName}.html`);
        fs.writeFileSync(htmlPath, html);

        // Render PDF
        const pdfPath = path.join(outDir, `Resume_${safeName}.pdf`);
        const pdfOk = await renderToPdf(html, pdfPath);
        if (pdfOk) {
            console.log(`  PDF → ${pdfPath}`);
        }

        // Score
        const score = calculateScore(jobAdText, tailored);
        const scorePath = path.join(outDir, 'score.json');
        fs.writeFileSync(scorePath, JSON.stringify(score, null, 2));

        console.log(`  Keywords: ${keywords.length}, Match: ${score.matchScore}%, ATS: ${score.atsParsing}`);

        demoIndex.push({
            jobName,
            jobFile: file,
            outputDir: `job_${jobName}`,
            safeName,
            matchScore: score.matchScore,
            atsParsing: score.atsParsing,
            missingKeywords: score.missingKeywords,
            matchedKeywords: score.matchedKeywords,
        });
    }

    // Write demo manifest for docs/app.js
    const manifestPath = path.join(DOCS_DIR, 'demo-manifest.json');
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(demoIndex, null, 2));
    console.log(`\nDemo manifest → ${manifestPath}`);

    // Copy HTML outputs to docs/ for GitHub Pages
    for (const entry of demoIndex) {
        const srcHtml = path.join(OUTPUTS_DIR, entry.outputDir, `Resume_${entry.safeName}.html`);
        const destHtml = path.join(DOCS_DIR, `${entry.outputDir}_resume.html`);
        if (fs.existsSync(srcHtml)) {
            fs.copyFileSync(srcHtml, destHtml);
        }

        const srcScore = path.join(OUTPUTS_DIR, entry.outputDir, 'score.json');
        const destScore = path.join(DOCS_DIR, `${entry.outputDir}_score.json`);
        if (fs.existsSync(srcScore)) {
            fs.copyFileSync(srcScore, destScore);
        }

        const srcPdf = path.join(OUTPUTS_DIR, entry.outputDir, `Resume_${entry.safeName}.pdf`);
        const destPdf = path.join(DOCS_DIR, `${entry.outputDir}_resume.pdf`);
        if (fs.existsSync(srcPdf)) {
            fs.copyFileSync(srcPdf, destPdf);
        }
    }

    console.log('Demo files copied to docs/');

    // ── Phase 2 demo: sample resume structure analysis & theme generation ──
    console.log('\n--- Phase 2 Demo ---');
    const sampleFiles = fs.existsSync(SAMPLES_DIR)
        ? fs.readdirSync(SAMPLES_DIR).filter(f => /\.(txt|docx|pdf)$/.test(f))
        : [];

    const phase2Index: Phase2DemoEntry[] = [];
    const baseResume2: JsonResume = JSON.parse(fs.readFileSync(BASE_RESUME_PATH, 'utf-8'));

    for (const file of sampleFiles) {
        const samplePath = path.join(SAMPLES_DIR, file);
        const sampleName = path.basename(file, path.extname(file));
        const outDir = path.join(OUTPUTS_DIR, `phase2_${sampleName}`);
        fs.mkdirSync(outDir, { recursive: true });

        console.log(`\nPhase 2 demo: ${sampleName}`);

        // Parse sample (supports .txt, .docx, .pdf)
        const ext = path.extname(file).toLowerCase();
        let paragraphs: string[];
        let headingCandidates: ReturnType<typeof detectHeadingCandidates>;

        if (ext === '.txt') {
            const text = fs.readFileSync(samplePath, 'utf-8');
            paragraphs = extractParagraphs(text);
            headingCandidates = detectHeadingCandidates(paragraphs).filter(h => h.isLikelyHeading);
        } else {
            const parsed = await parseUploadedResume(samplePath);
            paragraphs = parsed.paragraphs;
            headingCandidates = parsed.headingCandidates;
        }

        // Analyze structure
        const structure = analyzeStructure(paragraphs, headingCandidates);
        const structurePath = path.join(outDir, 'structure_analysis.json');
        fs.writeFileSync(structurePath, JSON.stringify(structure, null, 2));

        // Generate theme
        const theme = generateTheme(structure);
        const themeDir = path.join(outDir, 'theme');
        fs.mkdirSync(themeDir, { recursive: true });
        fs.writeFileSync(path.join(themeDir, 'index.js'), theme.indexJs);

        // Render preview using generated theme + Peter's base resume
        const html = previewWithTheme(theme.indexJs, baseResume2 as unknown as Record<string, unknown>);
        const previewPath = path.join(outDir, 'themed_preview.html');
        fs.writeFileSync(previewPath, html);

        // Copy to docs/
        const docsPreview = path.join(DOCS_DIR, `phase2_${sampleName}_preview.html`);
        fs.copyFileSync(previewPath, docsPreview);

        const docsStructure = path.join(DOCS_DIR, `phase2_${sampleName}_structure.json`);
        fs.copyFileSync(structurePath, docsStructure);

        console.log(`  Sections: ${structure.sectionOrder.join(' → ')}`);
        console.log(`  Name detected: ${structure.nameCandidate || 'N/A'}`);

        phase2Index.push({
            sampleName,
            sampleFile: file,
            nameCandidate: structure.nameCandidate,
            sectionOrder: structure.sectionOrder,
            layoutHints: structure.layoutHints,
        });
    }

    // Write Phase 2 manifest
    if (phase2Index.length > 0) {
        const p2ManifestPath = path.join(DOCS_DIR, 'phase2-manifest.json');
        fs.writeFileSync(p2ManifestPath, JSON.stringify(phase2Index, null, 2));
        console.log(`\nPhase 2 manifest → ${p2ManifestPath}`);
    }

    console.log('\nDone.');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
