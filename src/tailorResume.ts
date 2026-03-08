#!/usr/bin/env node
/**
 * tailorResume.ts — Generate a tailored JSON Resume from base-resume.json
 * by filtering and prioritizing content relevant to a specific job ad.
 *
 * Supports two modes:
 *   --mode programmatic   (default) Deterministic keyword-based filtering
 *   --mode llm            LLM-powered tailoring (see llmTailorResume.ts)
 *
 * Usage:
 *   node dist/tailorResume.js <job-ad.txt> [--mode programmatic|llm] [--base base-resume.json] [--output path]
 */

import fs from 'fs';
import path from 'path';
import { extractKeywords, deriveSeniority } from './parseJobAd';
import type { JsonResume, ResumeWorkEntry, ResumeProject, ResumeSkillGroup, Seniority } from './types';

// ---------------------------------------------------------------------------
// Configuration — tuned for ≤ 2 A4 pages of rendered output
// ---------------------------------------------------------------------------
const DEFAULT_BASE = path.join(__dirname, '..', 'base-resume.json');
const MAX_HIGHLIGHTS_PER_WORK = 4;
const MAX_WORK_ENTRIES = 3;
const MIN_WORK_SCORE = 1;
const MAX_PROJECTS = 3;
const MAX_HIGHLIGHTS_PER_PROJECT = 4;
const MAX_SUMMARY_CHARS = 350;
const MAX_SKILL_GROUPS = 6;

// ---------------------------------------------------------------------------
// Core tailoring logic
// ---------------------------------------------------------------------------

/**
 * Score a text block against a keyword list.
 * Returns count of keyword matches.
 */
export function scoreText(text: string, keywords: string[]): number {
    const lower = text.toLowerCase();
    return keywords.reduce((score, kw) => {
        return score + (lower.includes(kw.toLowerCase()) ? 1 : 0);
    }, 0);
}

/**
 * Score and sort work highlights by relevance.
 */
export function rankHighlights(highlights: string[], keywords: string[], max: number = MAX_HIGHLIGHTS_PER_WORK): string[] {
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
export function filterSkills(skills: ResumeSkillGroup[], keywords: string[]): ResumeSkillGroup[] {
    const kwLower = new Set(keywords.map(k => k.toLowerCase()));

    return skills
        .map(group => {
            const matchedKeywords = group.keywords.filter(kw =>
                kwLower.has(kw.toLowerCase())
            );
            if (matchedKeywords.length === 0) return null;
            return { ...group, keywords: matchedKeywords, _matchCount: matchedKeywords.length };
        })
        .filter((g): g is ResumeSkillGroup & { _matchCount: number } => g !== null)
        .sort((a, b) => b._matchCount - a._matchCount)
        .slice(0, MAX_SKILL_GROUPS)
        .map(({ _matchCount, ...rest }) => rest);
}

/**
 * Score and rank projects by relevance. Trim highlights per project.
 */
export function rankProjects(projects: ResumeProject[], keywords: string[]): ResumeProject[] {
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
        .filter(p => (p._score ?? 0) >= 1)
        .sort((a, b) => (b._score ?? 0) - (a._score ?? 0))
        .slice(0, MAX_PROJECTS)
        .map(({ _score, ...rest }) => ({
            ...rest,
            highlights: rankHighlights(rest.highlights || [], keywords, MAX_HIGHLIGHTS_PER_PROJECT),
        }));
}

/**
 * Score and rank work entries, dropping irrelevant ones.
 */
export function rankWork(workEntries: ResumeWorkEntry[], keywords: string[]): ResumeWorkEntry[] {
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
        .filter(e => (e._score ?? 0) >= MIN_WORK_SCORE)
        .sort((a, b) => {
            // Primary: relevance. Secondary: recency (most recent first).
            if ((b._score ?? 0) !== (a._score ?? 0)) return (b._score ?? 0) - (a._score ?? 0);
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
 */
export function programmaticallyTailorResume(baseResume: JsonResume, keywords: string[], seniority: Seniority = 'mid'): JsonResume {
    const resume: JsonResume = JSON.parse(JSON.stringify(baseResume)); // deep clone

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
export function tailorResume(baseResume: JsonResume, keywords: string[], seniority: Seniority): JsonResume {
    return programmaticallyTailorResume(baseResume, keywords, seniority);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node dist/tailorResume.js <job-ad.txt> [--mode programmatic|llm] [--base base-resume.json] [--output path]');
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
    const baseResume: JsonResume = JSON.parse(fs.readFileSync(basePath, 'utf-8'));

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
    let tailored: JsonResume;
    if (mode === 'llm') {
        const { llmTailorResume } = require('./llmTailorResume');
        tailored = await llmTailorResume(baseResume, jobAdText, keywords, seniority);
    } else {
        tailored = programmaticallyTailorResume(baseResume, keywords, seniority);
    }

    // Output
    let outPath: string;
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

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
