#!/usr/bin/env node
/**
 * pipeline.js — Run the full resume pipeline for a given job ad.
 *
 * Steps: parse → tailor → render → score
 *
 * Usage:
 *   node scripts/pipeline.js <job-ad.txt> [--mode programmatic|llm]
 *   node scripts/pipeline.js job_ads/senior_fullstack_engineer.txt --mode llm
 *   node scripts/pipeline.js --all   (process all job ads in job_ads/)
 */

const fs = require('fs');
const path = require('path');
const { extractKeywords, deriveSeniority } = require('./parseJobAd');
const { programmaticallyTailorResume } = require('./tailorResume');
const { llmTailorResume } = require('./llmTailorResume');
const { renderToHtml, renderToPdf } = require('./renderResume');
const { calculateScore } = require('./scoreResume');

const BASE_RESUME_PATH = path.join(__dirname, '..', 'base-resume.json');
const JOB_ADS_DIR = path.join(__dirname, '..', 'job_ads');
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');

async function runPipeline(jobAdPath, mode = 'programmatic') {
    const jobName = path.basename(jobAdPath, '.txt');
    const outDir = path.join(OUTPUTS_DIR, `job_${jobName}`);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pipeline: ${jobName}`);
    console.log(`${'='.repeat(60)}`);

    // Load base resume
    const baseResume = JSON.parse(fs.readFileSync(BASE_RESUME_PATH, 'utf-8'));
    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');

    // Step 1: Parse job ad
    console.log('\n[1/4] Parsing job ad...');
    const { keywords } = extractKeywords(jobAdText);
    const seniority = deriveSeniority(jobAdText);
    console.log(`       Seniority: ${seniority}`);
    console.log(`       Keywords (${keywords.length}): ${keywords.join(', ')}`);

    // Step 2: Tailor resume
    console.log(`\n[2/4] Tailoring resume (${mode})...`);
    let tailored;
    if (mode === 'llm') {
        tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority);
    } else {
        tailored = programmaticallyTailorResume(baseResume, keywords, seniority);
    }
    const tailoredPath = path.join(outDir, 'tailored_resume.json');
    fs.writeFileSync(tailoredPath, JSON.stringify(tailored, null, 2));
    console.log(`       → ${tailoredPath}`);

    // Step 3: Render HTML + PDF
    console.log('\n[3/4] Rendering resume...');
    const name = (tailored.basics && tailored.basics.name) || 'Resume';
    const safeName = name.replace(/\s+/g, '_');

    const html = renderToHtml(tailored);
    const htmlPath = path.join(outDir, `Resume_${safeName}.html`);
    fs.writeFileSync(htmlPath, html);
    console.log(`       HTML → ${htmlPath}`);

    const pdfPath = path.join(outDir, `Resume_${safeName}.pdf`);
    const pdfOk = await renderToPdf(html, pdfPath);
    if (pdfOk) {
        console.log(`       PDF  → ${pdfPath}`);
    } else {
        console.log('       PDF skipped (puppeteer not available)');
    }

    // Step 4: Score
    console.log('\n[4/4] Scoring resume...');
    const score = calculateScore(jobAdText, tailored);
    const scorePath = path.join(outDir, 'score.json');
    fs.writeFileSync(scorePath, JSON.stringify(score, null, 2));
    console.log(`       → ${scorePath}`);
    console.log(`       Match Score: ${score.matchScore}%`);
    console.log(`       ATS Parsing: ${score.atsParsing}`);
    if (score.missingKeywords.length > 0) {
        console.log(`       Missing: ${score.missingKeywords.join(', ')}`);
    }

    return { jobName, outDir, score };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/pipeline.js <job-ad.txt> [--mode programmatic|llm]');
        console.log('       node scripts/pipeline.js --all [--mode programmatic|llm]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    // Parse --mode flag
    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'programmatic';
    if (!['programmatic', 'llm'].includes(mode)) {
        console.error(`Invalid mode: ${mode}. Use "programmatic" or "llm".`);
        process.exit(1);
    }

    let jobAdPaths = [];

    if (args.includes('--all')) {
        // Process all job ads
        const files = fs.readdirSync(JOB_ADS_DIR).filter(f => f.endsWith('.txt'));
        jobAdPaths = files.map(f => path.join(JOB_ADS_DIR, f));
        if (jobAdPaths.length === 0) {
            console.error('No .txt files found in job_ads/');
            process.exit(1);
        }
    } else {
        // First non-flag arg is the job ad path
        const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
        jobAdPaths = [positional[0]];
    }

    const results = [];
    for (const adPath of jobAdPaths) {
        const result = await runPipeline(adPath, mode);
        results.push(result);
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('Pipeline Summary');
    console.log(`${'='.repeat(60)}`);
    for (const r of results) {
        console.log(`  ${r.jobName}: ${r.score.matchScore}% match (ATS: ${r.score.atsParsing})`);
    }
    console.log('');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
