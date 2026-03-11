#!/usr/bin/env tsx
/**
 * One-shot script: re-render the template DOCX from existing
 * tailored_resume.json + analysis JSON (no LLM calls needed).
 *
 * Usage:
 *   tsx scripts/reRenderTemplate.ts [outDir] [analysisJson]
 *
 * Defaults:
 *   outDir       → outputs/job_revel_street
 *   analysisJson → outputs/llm_docx_analysis/resume_template_2.analysis.json
 */
import fs from 'fs';
import path from 'path';
import { renderDocxFromAnalysis } from '../src/renderFromAnalysis.js';
import type { DocxAnalysis } from '../src/llmAnalyzeDocx.js';
import type { JsonResume } from '../src/types.js';

const [, , outDir = 'outputs/job_revel_street',
    analysisPath = 'outputs/llm_docx_analysis/resume_template_2.analysis.json'] = process.argv;

const absAnalysis = path.resolve(process.cwd(), analysisPath);
const absTailored = path.resolve(process.cwd(), outDir, 'tailored_resume.json');
const absOut = path.resolve(process.cwd(), outDir, 'Resume_Peter_Ho_template.docx');

if (!fs.existsSync(absAnalysis)) { console.error('Missing:', absAnalysis); process.exit(1); }
if (!fs.existsSync(absTailored)) { console.error('Missing:', absTailored); process.exit(1); }

const analysis = JSON.parse(fs.readFileSync(absAnalysis, 'utf8')) as DocxAnalysis;
const resume = JSON.parse(fs.readFileSync(absTailored, 'utf8')) as JsonResume;

(async () => {
    await renderDocxFromAnalysis(analysis, resume, absOut);
    console.log('Template DOCX →', absOut);
})().catch(e => { console.error(e); process.exit(1); });
