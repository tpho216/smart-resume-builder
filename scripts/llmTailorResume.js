#!/usr/bin/env node
/**
 * llmTailorResume.js — LLM-powered resume tailoring.
 *
 * Reads the prompt template from config/llm-prompt.md, fills placeholders,
 * and calls the configured LLM provider (OpenAI or Anthropic) to produce
 * a tailored JSON Resume that fits within 2 pages.
 *
 * Usage (standalone):
 *   node scripts/llmTailorResume.js <job-ad.txt> [--base base-resume.json] [--output path]
 *
 * Programmatic:
 *   const { llmTailorResume } = require('./llmTailorResume');
 *   const tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority);
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'llm-config.json');
const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', 'config', 'llm-prompt.md');

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`LLM config not found: ${CONFIG_PATH}\nRun with --mode programmatic or create config/llm-config.json`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadPromptTemplate(config) {
    const promptPath = config.promptFile
        ? path.resolve(path.dirname(CONFIG_PATH), '..', config.promptFile)
        : DEFAULT_PROMPT_PATH;
    if (!fs.existsSync(promptPath)) {
        throw new Error(`Prompt template not found: ${promptPath}`);
    }
    return fs.readFileSync(promptPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(template, { baseResume, jobAdText, keywords, seniority }) {
    return template
        .replace('{{SENIORITY}}', seniority)
        .replace('{{KEYWORDS}}', keywords.join(', '))
        .replace('{{JOB_AD}}', jobAdText)
        .replace('{{BASE_RESUME}}', JSON.stringify(baseResume, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers (zero-dep — uses built-in https)
// ---------------------------------------------------------------------------

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                } else {
                    resolve(JSON.parse(raw));
                }
            });
        });

        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callOpenAI(providerCfg, prompt) {
    const apiKey = process.env[providerCfg.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`Missing environment variable: ${providerCfg.apiKeyEnv}`);
    }

    const url = `${providerCfg.baseUrl}/chat/completions`;
    const body = {
        model: providerCfg.model,
        max_tokens: providerCfg.maxTokens,
        temperature: providerCfg.temperature,
        messages: [
            { role: 'system', content: 'You are an expert resume tailoring assistant. Return ONLY valid JSON, no markdown fences.' },
            { role: 'user', content: prompt },
        ],
    };

    console.log(`  Calling OpenAI (${providerCfg.model})...`);
    const resp = await httpsPost(url, { Authorization: `Bearer ${apiKey}` }, body);
    return resp.choices[0].message.content;
}

async function callAnthropic(providerCfg, prompt) {
    const apiKey = process.env[providerCfg.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`Missing environment variable: ${providerCfg.apiKeyEnv}`);
    }

    const url = `${providerCfg.baseUrl}/messages`;
    const body = {
        model: providerCfg.model,
        max_tokens: providerCfg.maxTokens,
        temperature: providerCfg.temperature,
        system: 'You are an expert resume tailoring assistant. Return ONLY valid JSON, no markdown fences.',
        messages: [
            { role: 'user', content: prompt },
        ],
    };

    console.log(`  Calling Anthropic (${providerCfg.model})...`);
    const resp = await httpsPost(url, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    }, body);
    return resp.content[0].text;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseJsonResponse(raw) {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Try to extract JSON object from the response
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw new Error(`Failed to parse LLM response as JSON: ${e.message}\n\nRaw response:\n${raw.slice(0, 500)}`);
    }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Tailor a resume using LLM.
 * @param {object} baseResume
 * @param {string} jobAdText
 * @param {string[]} keywords
 * @param {string} seniority
 * @returns {Promise<object>} Tailored JSON Resume
 */
async function llmTailorResume(baseResume, jobAdText, keywords, seniority) {
    const config = loadConfig();
    const template = loadPromptTemplate(config);
    const prompt = buildPrompt(template, { baseResume, jobAdText, keywords, seniority });

    const providerName = config.provider;
    const providerCfg = config.providers[providerName];
    if (!providerCfg) {
        throw new Error(`Unknown provider "${providerName}" in config. Available: ${Object.keys(config.providers).join(', ')}`);
    }

    let rawResponse;
    if (providerName === 'openai') {
        rawResponse = await callOpenAI(providerCfg, prompt);
    } else if (providerName === 'anthropic') {
        rawResponse = await callAnthropic(providerCfg, prompt);
    } else {
        throw new Error(`Unsupported provider: ${providerName}`);
    }

    const tailored = parseJsonResponse(rawResponse);

    // Sanity check: must have basics.name
    if (!tailored.basics || !tailored.basics.name) {
        throw new Error('LLM response missing basics.name — response may be malformed.');
    }

    return tailored;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/llmTailorResume.js <job-ad.txt> [--base base-resume.json] [--output path]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const jobAdPath = args[0];
    if (!fs.existsSync(jobAdPath)) {
        console.error(`Error: Job ad not found: ${jobAdPath}`);
        process.exit(1);
    }

    const { extractKeywords, deriveSeniority } = require('./parseJobAd');

    const baseIdx = args.indexOf('--base');
    const basePath = baseIdx !== -1 ? args[baseIdx + 1] : path.join(__dirname, '..', 'base-resume.json');
    const outputIdx = args.indexOf('--output');

    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
    const baseResume = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
    const { keywords } = extractKeywords(jobAdText);
    const seniority = deriveSeniority(jobAdText);

    console.log(`Job ad:      ${path.basename(jobAdPath)}`);
    console.log(`Mode:        llm`);
    console.log(`Seniority:   ${seniority}`);
    console.log(`Keywords:    ${keywords.length} found`);
    console.log('');

    const tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority);

    let outPath;
    if (outputIdx !== -1 && args[outputIdx + 1]) {
        outPath = args[outputIdx + 1];
    } else {
        const jobName = path.basename(jobAdPath, '.txt');
        const outDir = path.join(__dirname, '..', 'outputs', `job_${jobName}`);
        outPath = path.join(outDir, 'tailored_resume.json');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(tailored, null, 2));
    console.log(`Tailored resume → ${outPath}`);
}

module.exports = { llmTailorResume, loadConfig, loadPromptTemplate, buildPrompt };

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
