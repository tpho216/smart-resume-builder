#!/usr/bin/env node
/**
 * pipeline.ts — Resume builder pipeline (parse → tailor → render → score).
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
 *   # Process all job ads in inputs/job_ads/:
 *   node dist/pipeline.js --all [--mode programmatic|llm]
 *
 * Available flags (all optional when --task is provided):
 *   --task <path>        Path to a task_<n>.json config file
 *   --mode <mode>        programmatic | llm
 *   --base <path>        Base resume JSON path  (default: base-resume.json)
 *   --job-ad <path>      Job ad .txt file — may be repeated for multiple ads
 *   --all                Process every .txt file in inputs/job_ads/
 *   --output <dir>       Output root directory
 *   --provider <name>    LLM provider (overrides task.llm.provider)
 *   --model <name>       LLM model name (overrides task.llm.providers[provider].model)
 */

import fs from 'fs';
import path from 'path';
import { extractKeywords, deriveSeniority } from './parseJobAd';
import { programmaticallyTailorResume } from './tailorResume';
import { llmTailorResume } from './llmTailorResume';
import { renderToHtml, renderToPdf } from './renderResume';
import { renderToDocx } from './renderDocx';
import { calculateScore } from './scoreResume';
import type { JsonResume, LlmConfig, PipelineResult, TaskConfig } from './types';

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
    help: boolean;
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
    llmConfig?: LlmConfig;
    description?: string;
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

    let llmConfig: LlmConfig | undefined = task?.llm ? { ...task.llm } : undefined;
    if (llmConfig) {
        if (cli.provider) llmConfig = { ...llmConfig, provider: cli.provider };
        if (cli.model && llmConfig.providers) {
            const providerName = llmConfig.provider;
            llmConfig = {
                ...llmConfig,
                providers: {
                    ...llmConfig.providers,
                    [providerName]: { ...llmConfig.providers[providerName], model: cli.model },
                },
            };
        }
    }

    return { mode, baseResumePath, jobAdPaths, outputsDir, llmConfig, description: task?.description };
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

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pipeline: ${jobName}${config.description ? `  (${config.description})` : ''}`);
    console.log(`${'='.repeat(60)}`);

    const baseResume: JsonResume = JSON.parse(fs.readFileSync(config.baseResumePath, 'utf-8'));
    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');

    // Step 1: Parse job ad
    console.log('\n[1/4] Parsing job ad...');
    const { keywords } = extractKeywords(jobAdText);
    const seniority = deriveSeniority(jobAdText);
    console.log(`       Seniority: ${seniority}`);
    console.log(`       Keywords (${keywords.length}): ${keywords.join(', ')}`);

    // Step 2: Tailor resume
    console.log(`\n[2/4] Tailoring resume (${config.mode})...`);
    let tailored: JsonResume;
    if (config.mode === 'llm') {
        tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority, config.llmConfig);
    } else {
        tailored = programmaticallyTailorResume(baseResume, keywords, seniority);
    }
    const tailoredPath = path.join(outDir, 'tailored_resume.json');
    fs.writeFileSync(tailoredPath, JSON.stringify(tailored, null, 2));
    console.log(`       → ${tailoredPath}`);

    // Step 3: Render HTML + PDF + DOCX
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

    const docxPath = path.join(outDir, `Resume_${safeName}.docx`);
    const docxBuffer = await renderToDocx(tailored);
    fs.writeFileSync(docxPath, docxBuffer);
    console.log(`       DOCX → ${docxPath}`);

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

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
    console.log(`
Smart Resume Builder — pipeline

Usage:
  node dist/pipeline.js --task <task.json> [overrides]
  node dist/pipeline.js <task.json>            (shorthand)
  node dist/pipeline.js <job-ad.txt> [flags]
  node dist/pipeline.js --all [flags]

Flags:
  --task <path>      Task config JSON (e.g. inputs/tasks/task_1.json)
  --mode <mode>      programmatic | llm           (overrides task)
  --base <path>      Base resume JSON             (overrides task.baseResume)
  --job-ad <path>    Job ad .txt file, repeatable (overrides task.jobAd)
  --all              Process all .txt files in inputs/job_ads/
  --output <dir>     Output directory             (overrides task.outputDir)
  --provider <name>  LLM provider                 (overrides task.llm.provider)
  --model <name>     LLM model name               (overrides provider model)
  --help             Show this message

Examples:
  node dist/pipeline.js --task inputs/tasks/task_1.json
  node dist/pipeline.js inputs/tasks/task_2.json --mode llm
  node dist/pipeline.js inputs/job_ads/my_role.txt --mode llm --provider openai
  node dist/pipeline.js --all --mode programmatic
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
    if (config.llmConfig) {
        const provider = config.llmConfig.provider;
        const model = config.llmConfig.providers?.[provider]?.model ?? 'default';
        console.log(`LLM:         ${provider} / ${model}`);
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
