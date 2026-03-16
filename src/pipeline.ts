#!/usr/bin/env node
/**
 * pipeline.ts — Unified resume builder pipeline.
 *
 * Workflow:
 *   1. (Optional) Parse template resume → analyze structure → generate custom theme
 *   2. Parse job ad → tailor resume → render → score
 *
 * Theme options:
 *   - templateResume set  → Custom theme from uploaded layout
 *   - theme set           → Named JSON Resume theme (auto-installed)
 *   - neither             → Default "elegant" theme
 *
 * Usage:
 *   # Task file — bundles every setting needed for a run:
 *   node dist/pipeline.js --task inputs/tasks/task_1.json
 *
 *   # Shorthand — first positional arg that ends in .json is auto-treated as a task:
 *   node dist/pipeline.js inputs/tasks/task_1.json
 *
 *   # Pure CLI (no task file):
 *   node dist/pipeline.js inputs/job_ads/senior_fullstack_engineer.txt
 *   node dist/pipeline.js inputs/job_ads/senior_fullstack_engineer.txt --mode llm
 *
 *   # CLI flags override matching fields in the task file:
 *   node dist/pipeline.js --task inputs/tasks/task_1.json --mode programmatic
 *   node dist/pipeline.js --task inputs/tasks/task_1.json --provider anthropic
 *
 *   # With template resume (custom theme generation):
 *   node dist/pipeline.js --task inputs/tasks/task_3.json
 *   node dist/pipeline.js --template-resume inputs/resume_templates/resume.docx --job-ad ad.txt
 *
 *   # Named theme:
 *   node dist/pipeline.js --theme even --job-ad ad.txt
 *
 *   # Process all job ads in inputs/job_ads/:
 *   node dist/pipeline.js --all [--mode programmatic|llm]
 *
 * Available flags (all optional when --task is provided):
 *   --task <path>             Path to a task_<n>.json config file
 *   --mode <mode>             programmatic | llm
 *   --base <path>             Base resume JSON path  (default: base-resume.json)
 *   --job-ad <path>           Job ad .txt file — may be repeated for multiple ads
 *   --all                     Process every .txt file in inputs/job_ads/
 *   --output <dir>            Output root directory
 *   --provider <name>         LLM provider (overrides task.llm.provider)
 *   --model <name>            LLM model name (overrides provider default from llm_providers.json)
 *   --template-resume <path>  Template resume (PDF/DOCX) → Phase 2 flow
 *   --theme <name>            Named JSON Resume theme (e.g. "elegant", "even")
 */

import fs from 'fs';
import path from 'path';
import { extractKeywords, deriveSeniority } from './parseJobAd';
import { programmaticallyTailorResume } from './tailorResume';
import { llmTailorResume } from './llmTailorResume';
import { renderToHtml, renderToHtmlWithNamedTheme, renderToPdf } from './renderResume';
import { renderToDocx } from './renderDocx';
import { calculateScore } from './scoreResume';
import { parseUploadedResume } from './parseUploadedResume';
import { analyzeStructure } from './analyzeStructure';
import { generateTheme, previewWithTheme } from './generateTheme';
import type { JsonResume, TaskLlmConfig, PipelineResult, TaskConfig, StructureAnalysis } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_BASE_RESUME = path.join(PROJECT_ROOT, 'base-resume.json');
const DEFAULT_JOB_ADS_DIR = path.join(PROJECT_ROOT, 'inputs', 'job_ads');
const DEFAULT_OUTPUTS_DIR = path.join(PROJECT_ROOT, 'outputs');

// ---------------------------------------------------------------------------
// Task config loading
// ---------------------------------------------------------------------------

function loadTaskConfig(taskPath: string): TaskConfig {
    const abs = path.isAbsolute(taskPath) ? taskPath : path.resolve(taskPath);
    if (!fs.existsSync(abs)) {
        throw new Error(`Task file not found: ${abs}`);
    }
    console.log(`Task file:   ${abs}`);
    return JSON.parse(fs.readFileSync(abs, 'utf-8')) as TaskConfig;
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

interface CliArgs {
    taskFile?: string;
    mode?: 'programmatic' | 'llm';
    base?: string;
    jobAds: string[];
    all: boolean;
    output?: string;
    provider?: string;
    model?: string;
    templateResume?: string;
    theme?: string;
    help: boolean;
    /** Force re-analysis of the DOCX template (re-runs LLM + review). */
    analyze?: boolean;
    /** Skip the interactive review step when --analyze is also passed. */
    noReview?: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
    const cli: CliArgs = { jobAds: [], all: false, help: false };
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                cli.help = true;
                break;
            case '--task':
                cli.taskFile = argv[++i];
                break;
            case '--mode':
                cli.mode = argv[++i] as 'programmatic' | 'llm';
                break;
            case '--base':
                cli.base = argv[++i];
                break;
            case '--job-ad':
                cli.jobAds.push(argv[++i]);
                break;
            case '--all':
                cli.all = true;
                break;
            case '--output':
                cli.output = argv[++i];
                break;
            case '--provider':
                cli.provider = argv[++i];
                break;
            case '--model':
                cli.model = argv[++i];
                break;
            case '--template-resume':
                cli.templateResume = argv[++i];
                break;
            case '--theme':
                cli.theme = argv[++i];
                break;
            case '--analyze':
                cli.analyze = true;
                break;
            case '--no-review':
                cli.noReview = true;
                break;
            default:
                // Positional: bare .json → task file; .txt → job ad
                if (!arg.startsWith('--')) {
                    if (arg.endsWith('.json')) {
                        cli.taskFile = cli.taskFile ?? arg;
                    } else {
                        cli.jobAds.push(arg);
                    }
                }
        }
        i++;
    }
    return cli;
}

// ---------------------------------------------------------------------------
// Merge CLI + task → resolved config (CLI always wins)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
    mode: 'programmatic' | 'llm';
    baseResumePath: string;
    jobAdPaths: string[];
    outputsDir: string;
    llmConfig?: TaskLlmConfig;
    description?: string;
    /** Path to a template resume whose layout should be replicated. */
    templateResumePath?: string;
    /** Named JSON Resume theme (e.g. "elegant", "even"). */
    theme?: string;
    /**
     * Path to a pre-built *_tpl.docx + *_mapping.json produced by buildDocxTemplate.ts.
     * Renders via docxtemplater — faster and more accurate than the LLM-analysis path.
     */
    templateDocxTplPath?: string;
    /** Force re-analysis of the DOCX template (re-runs LLM + interactive review). */
    analyze?: boolean;
    /** Skip the interactive review when --analyze is also set. */
    noReview?: boolean;
}

function resolveConfig(cli: CliArgs, task?: TaskConfig): ResolvedConfig {
    const mode: 'programmatic' | 'llm' = cli.mode ?? task?.mode ?? 'programmatic';

    const baseResumePath = path.resolve(cli.base ?? task?.baseResume ?? DEFAULT_BASE_RESUME);

    const outputsDir = cli.output
        ? path.resolve(cli.output)
        : task?.outputDir
            ? path.resolve(task.outputDir)
            : DEFAULT_OUTPUTS_DIR;

    let jobAdPaths: string[] = [];
    if (cli.all) {
        const files = fs.readdirSync(DEFAULT_JOB_ADS_DIR).filter(f => f.endsWith('.txt'));
        jobAdPaths = files.map(f => path.join(DEFAULT_JOB_ADS_DIR, f));
    } else if (cli.jobAds.length > 0) {
        jobAdPaths = cli.jobAds.map(p => path.resolve(p));
    } else if (task?.jobAd) {
        const raw = task.jobAd;
        if (raw === 'all') {
            const files = fs.readdirSync(DEFAULT_JOB_ADS_DIR).filter(f => f.endsWith('.txt'));
            jobAdPaths = files.map(f => path.join(DEFAULT_JOB_ADS_DIR, f));
        } else if (Array.isArray(raw)) {
            jobAdPaths = raw.map(p => path.resolve(p));
        } else {
            jobAdPaths = [path.resolve(raw)];
        }
    }

    let llmConfig: TaskLlmConfig | undefined = task?.llm ? { ...task.llm } : undefined;
    if (llmConfig) {
        if (cli.provider) llmConfig = { ...llmConfig, provider: cli.provider };
        if (cli.model) llmConfig = { ...llmConfig, model: cli.model };
    } else if (cli.provider) {
        // Provider specified on CLI with no task file
        llmConfig = { provider: cli.provider, ...(cli.model && { model: cli.model }) };
    }

    return {
        mode, baseResumePath, jobAdPaths, outputsDir, llmConfig, description: task?.description,
        templateResumePath: cli.templateResume
            ? path.resolve(cli.templateResume)
            : task?.templateResume
                ? path.resolve(task.templateResume)
                : undefined,
        theme: cli.theme ?? task?.theme,
        templateDocxTplPath: task?.templateDocxTpl
            ? path.resolve(task.templateDocxTpl)
            : undefined,
        analyze: cli.analyze,
        noReview: cli.noReview,
    };
}

// ---------------------------------------------------------------------------
// Core pipeline run
// ---------------------------------------------------------------------------

async function runPipeline(
    jobAdPath: string,
    config: ResolvedConfig
): Promise<PipelineResult> {
    const jobName = path.basename(jobAdPath, '.txt');

    // If outputsDir already looks like a per-job directory, use it directly;
    // otherwise create a sub-directory per job.
    const outDir = config.outputsDir.includes(jobName)
        ? config.outputsDir
        : path.join(config.outputsDir, `job_${jobName}`);

    fs.mkdirSync(outDir, { recursive: true });

    // Wipe stale output files from previous runs so old names don't linger.
    for (const f of fs.readdirSync(outDir)) {
        if (/\.(html|pdf|docx)$/i.test(f)) {
            fs.rmSync(path.join(outDir, f));
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pipeline: ${jobName}${config.description ? `  (${config.description})` : ''}`);
    console.log(`${'='.repeat(60)}`);

    const baseResume: JsonResume = JSON.parse(fs.readFileSync(config.baseResumePath, 'utf-8'));
    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');

    // ── Template resume: parse → analyze → generate theme ──
    let structure: StructureAnalysis | undefined;
    let customThemeJs: string | undefined;

    if (config.templateResumePath) {
        console.log('\nParsing template resume...');
        const parsed = await parseUploadedResume(config.templateResumePath);
        const parsedPath = path.join(outDir, 'parsed_resume.json');
        const parsedForSave: Record<string, unknown> = { ...parsed };
        if (typeof parsedForSave.html === 'string' && (parsedForSave.html as string).length > 5000) {
            parsedForSave.htmlPreview = (parsedForSave.html as string).substring(0, 2000);
            delete parsedForSave.html;
        }
        fs.writeFileSync(parsedPath, JSON.stringify(parsedForSave, null, 2));
        console.log(`       Paragraphs: ${parsed.totalParagraphs}`);
        console.log(`       Headings:   ${parsed.totalHeadingCandidates}`);
        console.log(`       → ${parsedPath}`);

        console.log('\nAnalyzing structure...');
        structure = analyzeStructure(parsed.paragraphs, parsed.headingCandidates);
        const structurePath = path.join(outDir, 'structure_analysis.json');
        fs.writeFileSync(structurePath, JSON.stringify(structure, null, 2));
        console.log(`       Name:     ${structure.nameCandidate || 'N/A'}`);
        console.log(`       Sections: ${structure.sectionOrder.join(' → ')}`);
        console.log(`       → ${structurePath}`);

        console.log('\nGenerating custom theme...');
        const theme = generateTheme(structure);
        customThemeJs = theme.indexJs;
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
    }

    // ── Parse job ad ─────────────────────────────────
    console.log('\nParsing job ad...');
    const { keywords } = extractKeywords(jobAdText);
    const seniority = deriveSeniority(jobAdText);
    console.log(`       Seniority: ${seniority}`);
    console.log(`       Keywords (${keywords.length}): ${keywords.join(', ')}`);

    // ── Tailor resume ────────────────────────────────
    console.log(`\nTailoring resume (${config.mode})...`);
    let tailored: JsonResume;
    if (config.mode === 'llm') {
        tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority, config.llmConfig, config.templateDocxTplPath);
    } else {
        tailored = programmaticallyTailorResume(baseResume, keywords, seniority);
    }
    const tailoredPath = path.join(outDir, 'tailored_resume.json');
    fs.writeFileSync(tailoredPath, JSON.stringify(tailored, null, 2));
    console.log(`       → ${tailoredPath}`);

    // ── Render HTML + PDF + DOCX ─────────────────────
    console.log('\nRendering resume...');
    const name = (tailored.basics && tailored.basics.name) || 'Resume';
    const compactName = name.replace(/\s+/g, '');

    // Determine theme name for filename
    let themeName: string;
    if (config.theme) {
        themeName = config.theme;
    } else if (config.templateResumePath) {
        themeName = path.basename(config.templateResumePath).replace(/\.[^.]+$/, '');
    } else {
        themeName = 'elegant'; // default theme
    }
    const baseName = `${compactName}_Resume_${themeName}`;

    let html: string;
    if (customThemeJs) {
        console.log('       Using custom-generated theme');
        html = previewWithTheme(customThemeJs, tailored as Record<string, unknown>);
    } else if (config.theme) {
        console.log(`       Using theme: ${config.theme}`);
        html = renderToHtmlWithNamedTheme(tailored, config.theme);
    } else {
        console.log('       Using theme: elegant (default)');
        html = renderToHtml(tailored);
    }

    const htmlPath = path.join(outDir, `${baseName}.html`);
    fs.writeFileSync(htmlPath, html);
    console.log(`       HTML → ${htmlPath}`);

    const pdfPath = path.join(outDir, `${baseName}.pdf`);
    const pdfOk = await renderToPdf(html, pdfPath);
    if (pdfOk) {
        console.log(`       PDF  → ${pdfPath}`);
    } else {
        console.log('       PDF skipped (puppeteer not available)');
    }

    const docxPath = path.join(outDir, `${baseName}.docx`);
    const docxBuffer = await renderToDocx(tailored, structure);
    fs.writeFileSync(docxPath, docxBuffer);
    console.log(`       DOCX → ${docxPath}`);

    // ── Template DOCX (docxtemplater — mapping-based) ────────
    if (config.templateDocxTplPath) {
        console.log('\nRendering template DOCX (docxtemplater)...');
        console.log(`       Template: ${config.templateDocxTplPath}`);
        const { renderDocxFromTemplate } = await import('./renderDocxFromTemplate.js');
        const tplBase = path.basename(config.templateDocxTplPath, '_tpl.docx');
        const mappingPath = path.join(PROJECT_ROOT, 'outputs', 'llm_docx_analysis', `${tplBase}_mapping.json`);
        const needsBuild = config.analyze || !fs.existsSync(config.templateDocxTplPath) || !fs.existsSync(mappingPath);
        if (needsBuild) {
            const srcDocx = path.join(PROJECT_ROOT, 'inputs', 'resume_templates', `${tplBase}.docx`);
            const reason = config.analyze ? '--analyze flag' : 'files missing';
            console.log(`\n  [auto] Building template (${reason})...`);
            const { spawnSync } = require('child_process') as typeof import('child_process');
            const buildArgs = ['tsx', 'src/buildDocxTemplate.ts', srcDocx];
            if (config.analyze) buildArgs.push('--analyze');
            if (config.noReview) buildArgs.push('--no-review');
            const result = spawnSync('npx', buildArgs, {
                cwd: PROJECT_ROOT,
                stdio: 'inherit',
                shell: true,
            });
            if (result.status !== 0) throw new Error('build:tpl failed — cannot render _dtpl.docx');
        }
        const tplDocxPath = path.join(outDir, `${compactName}_Resume_${tplBase}_dtpl.docx`);
        await renderDocxFromTemplate(config.templateDocxTplPath, mappingPath, tailored, tplDocxPath);
        console.log(`       Template DOCX → ${tplDocxPath}`);
    }

    // ── Score resume ──────────────────────────────────
    console.log('\nScoring resume...');
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

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
    console.log(`
Smart Resume Builder — unified pipeline

Usage:
  node dist/pipeline.js --task <task.json> [overrides]
  node dist/pipeline.js <task.json>            (shorthand)
  node dist/pipeline.js <job-ad.txt> [flags]
  node dist/pipeline.js --all [flags]

Flags:
  --task <path>             Task config JSON (e.g. inputs/tasks/task_1.json)
  --mode <mode>             programmatic | llm           (overrides task)
  --base <path>             Base resume JSON             (overrides task.baseResume)
  --job-ad <path>           Job ad .txt file, repeatable (overrides task.jobAd)
  --all                     Process all .txt files in inputs/job_ads/
  --output <dir>            Output directory             (overrides task.outputDir)
  --provider <name>         LLM provider                 (overrides task.llm.provider)
  --model <name>            LLM model name               (overrides provider model)
  --template-resume <path>  Template resume PDF/DOCX → custom theme generation
  --theme <name>            Named JSON Resume theme (e.g. "elegant", "even")
  --help                    Show this message

Theme options:
  templateResume set  → Custom theme from uploaded layout
  theme set           → Named theme (auto-installed if needed)
  neither             → Default "elegant" theme

Examples:
  node dist/pipeline.js --task inputs/tasks/task_1.json
  node dist/pipeline.js inputs/tasks/task_2.json --mode llm
  node dist/pipeline.js inputs/job_ads/my_role.txt --mode llm --provider openai
  node dist/pipeline.js --all --mode programmatic
  node dist/pipeline.js --task inputs/tasks/task_3.json          # w/ template resume
  node dist/pipeline.js --template-resume resume.docx --job-ad ad.txt
  node dist/pipeline.js --theme even --job-ad ad.txt
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const cli = parseCliArgs(argv);

    if (cli.help || argv.length === 0) {
        printHelp();
        process.exit(argv.length === 0 ? 1 : 0);
    }

    if (cli.mode && !['programmatic', 'llm'].includes(cli.mode)) {
        console.error(`Error: Invalid --mode "${cli.mode}". Use "programmatic" or "llm".`);
        process.exit(1);
    }

    let task: TaskConfig | undefined;
    if (cli.taskFile) {
        task = loadTaskConfig(cli.taskFile);
        if (task.description) console.log(`Description: ${task.description}`);
    }

    const config = resolveConfig(cli, task);

    if (config.jobAdPaths.length === 0) {
        console.error(
            'Error: No job ad specified.\n' +
            'Provide one via --job-ad <path>, as a positional .txt arg,\n' +
            'set "jobAd" in the task file, or use --all.'
        );
        process.exit(1);
    }

    console.log(`Mode:        ${config.mode}`);
    console.log(`Base resume: ${config.baseResumePath}`);
    console.log(`Job ads:     ${config.jobAdPaths.map(p => path.relative(PROJECT_ROOT, p)).join(', ')}`);
    if (config.templateResumePath) {
        console.log(`Template:    ${path.relative(PROJECT_ROOT, config.templateResumePath)} (custom theme)`);
    } else if (config.theme) {
        console.log(`Theme:       ${config.theme}`);
    }
    if (config.llmConfig) {
        const { provider, model } = config.llmConfig;
        console.log(`LLM:         ${provider}${model ? ` / ${model}` : ''}`);
    }

    const results: PipelineResult[] = [];
    for (const adPath of config.jobAdPaths) {
        const result = await runPipeline(adPath, config);
        results.push(result);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('Pipeline Summary');
    console.log(`${'='.repeat(60)}`);
    for (const r of results) {
        console.log(`  ${r.jobName}: ${r.score.matchScore}% match (ATS: ${r.score.atsParsing})`);
    }
    console.log('');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
