#!/usr/bin/env node
/**
 * tailorResume.js — Generate a tailored JSON Resume from base-resume.json
 * by filtering and prioritizing content relevant to a specific job ad.
 *
 * Supports two modes:
 *   --mode programmatic   (default) Deterministic keyword-based filtering
 *   --mode llm            LLM-powered tailoring (see scripts/llmTailorResume.js)
 *
 * Usage:
 *   node scripts/tailorResume.js <job-ad.txt> [--mode programmatic|llm] [--base base-resume.json] [--output path]
 */

const fs = require('fs');
const path = require('path');
const { extractKeywords, deriveSeniority } = require('./parseJobAd');

// ---------------------------------------------------------------------------
// Configuration — tuned for ≤ 2 A4 pages of rendered output
// ---------------------------------------------------------------------------
const DEFAULT_BASE = path.join(__dirname, '..', 'base-resume.json');
const MAX_HIGHLIGHTS_PER_WORK = 4;     // was 6 — tighter for 2-page target
const MAX_WORK_ENTRIES = 3;            // drop irrelevant roles entirely
const MIN_WORK_SCORE = 1;             // work entry must match ≥ 1 keyword
const MAX_PROJECTS = 3;               // was 4
const MAX_HIGHLIGHTS_PER_PROJECT = 4;
const MAX_SUMMARY_CHARS = 350;        // truncate summary to keep header compact
const MAX_SKILL_GROUPS = 6;           // keep most matched skill categories

// ---------------------------------------------------------------------------
// Core tailoring logic
// ---------------------------------------------------------------------------

/**
 * Score a text block against a keyword list.
 * Returns count of keyword matches.
 */
function scoreText(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.reduce((score, kw) => {
        return score + (lower.includes(kw.toLowerCase()) ? 1 : 0);
    }, 0);
}

/**
 * Score and sort work highlights by relevance.
 */
function rankHighlights(highlights, keywords, max = MAX_HIGHLIGHTS_PER_WORK) {
    return highlights
        .map(h => ({ text: h, score: scoreText(h, keywords) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map(h => h.text);
}

/**
 * Filter skill categories to only include matched keywords.
 * Keep skill group if at least one keyword matches. Cap total groups.
 */
function filterSkills(skills, keywords) {
    const kwLower = new Set(keywords.map(k => k.toLowerCase()));

    return skills
        .map(group => {
            const matchedKeywords = group.keywords.filter(kw =>
                kwLower.has(kw.toLowerCase())
            );
            if (matchedKeywords.length === 0) return null;
            return { ...group, keywords: matchedKeywords, _matchCount: matchedKeywords.length };
        })
        .filter(Boolean)
        .sort((a, b) => b._matchCount - a._matchCount)
        .slice(0, MAX_SKILL_GROUPS)
        .map(({ _matchCount, ...rest }) => rest);
}

/**
 * Score and rank projects by relevance. Trim highlights per project.
 */
function rankProjects(projects, keywords) {
    return projects
        .map(p => {
            const textBlob = [
                p.name || '',
                p.description || '',
                p.summary || '',
                ...(p.highlights || []),
            ].join(' ');
            const score = scoreText(textBlob, keywords);
            return { ...p, _score: score };
        })
        .filter(p => p._score >= 1)             // drop zero-relevance projects
        .sort((a, b) => b._score - a._score)
        .slice(0, MAX_PROJECTS)
        .map(({ _score, ...rest }) => ({
            ...rest,
            highlights: rankHighlights(rest.highlights || [], keywords, MAX_HIGHLIGHTS_PER_PROJECT),
        }));
}

/**
 * Score and rank work entries, dropping irrelevant ones.
 */
function rankWork(workEntries, keywords) {
    return workEntries
        .map(entry => {
            const textBlob = [
                entry.position || '',
                entry.summary || '',
                ...(entry.highlights || []),
            ].join(' ');
            const score = scoreText(textBlob, keywords);
            return { ...entry, _score: score };
        })
        .filter(e => e._score >= MIN_WORK_SCORE) // drop irrelevant roles
        .sort((a, b) => {
            // Primary: relevance. Secondary: recency (most recent first).
            if (b._score !== a._score) return b._score - a._score;
            return (b.startDate || '').localeCompare(a.startDate || '');
        })
        .slice(0, MAX_WORK_ENTRIES)
        .map(({ _score, ...rest }) => ({
            ...rest,
            highlights: rankHighlights(rest.highlights || [], keywords, MAX_HIGHLIGHTS_PER_WORK),
        }));
}

/**
 * Tailor a base resume JSON to match a job ad's keywords.
 * Produces a 2-page-optimized resume.
 * @param {object} baseResume - Parsed base-resume.json
 * @param {string[]} keywords - Extracted keywords from job ad
 * @param {string} seniority - junior | mid | senior
 * @returns {object} Tailored JSON Resume (schema-compliant)
 */
function programmaticallyTailorResume(baseResume, keywords, seniority = 'mid') {
    const resume = JSON.parse(JSON.stringify(baseResume)); // deep clone

    // --- Tailor summary (append seniority context if senior role) ---
    if (seniority === 'senior' && resume.basics && resume.basics.summary) {
        if (!resume.basics.summary.includes('architecture')) {
            resume.basics.summary += ' Passionate about system architecture, mentoring, and delivering high-impact engineering outcomes.';
        }
    }

    // --- Truncate summary for 2-page fit ---
    if (resume.basics && resume.basics.summary && resume.basics.summary.length > MAX_SUMMARY_CHARS) {
        resume.basics.summary = resume.basics.summary.slice(0, MAX_SUMMARY_CHARS).replace(/\s\S*$/, '') + '.';
    }

    // --- Rank, filter, and trim work entries ---
    if (resume.work) {
        resume.work = rankWork(resume.work, keywords);
    }

    // --- Filter skills ---
    if (resume.skills) {
        resume.skills = filterSkills(resume.skills, keywords);
    }

    // --- Rank and trim projects ---
    if (resume.projects) {
        resume.projects = rankProjects(resume.projects, keywords);
    }

    // --- Strip internal tags (not part of JSON Resume schema) ---
    if (resume.work) {
        resume.work.forEach(w => delete w._tags);
    }
    if (resume.projects) {
        resume.projects.forEach(p => delete p._tags);
    }
    delete resume._meta;

    return resume;
}

/**
 * Convenience wrapper — keeps the old function name working.
 * @deprecated Use programmaticallyTailorResume() directly.
 */
function tailorResume(baseResume, keywords, seniority) {
    return programmaticallyTailorResume(baseResume, keywords, seniority);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/tailorResume.js <job-ad.txt> [--mode programmatic|llm] [--base base-resume.json] [--output path]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const jobAdPath = args[0];
    if (!fs.existsSync(jobAdPath)) {
        console.error(`Error: Job ad not found: ${jobAdPath}`);
        process.exit(1);
    }

    // Parse flags
    const modeIdx = args.indexOf('--mode');
    const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'programmatic';
    const baseIdx = args.indexOf('--base');
    const basePath = baseIdx !== -1 ? args[baseIdx + 1] : DEFAULT_BASE;
    const outputIdx = args.indexOf('--output');

    // Load inputs
    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
    const baseResume = JSON.parse(fs.readFileSync(basePath, 'utf-8'));

    // Extract keywords
    const { keywords } = extractKeywords(jobAdText);
    const seniority = deriveSeniority(jobAdText);

    console.log(`Job ad:      ${path.basename(jobAdPath)}`);
    console.log(`Mode:        ${mode}`);
    console.log(`Seniority:   ${seniority}`);
    console.log(`Keywords:    ${keywords.length} found`);
    console.log(`Keywords:    ${keywords.join(', ')}`);
    console.log('');

    // Tailor
    let tailored;
    if (mode === 'llm') {
        const { llmTailorResume } = require('./llmTailorResume');
        tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority);
    } else {
        tailored = programmaticallyTailorResume(baseResume, keywords, seniority);
    }

    // Output
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

// Export for programmatic use
module.exports = {
    tailorResume,
    programmaticallyTailorResume,
    scoreText,
    filterSkills,
    rankProjects,
    rankWork,
};

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
