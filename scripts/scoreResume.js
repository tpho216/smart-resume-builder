#!/usr/bin/env node
/**
 * scoreResume.js — Calculate ATS match score and identify missing keywords.
 *
 * Compares tailored_resume.json against the job ad to produce:
 *   - Match percentage
 *   - Matched / missing keywords lists
 *   - ATS parsing pass/fail (schema + section completeness checks)
 *
 * Usage:
 *   node scripts/scoreResume.js <job-ad.txt> <tailored_resume.json> [--output score.json]
 *
 * Output: score.json with match results.
 */

const fs = require('fs');
const path = require('path');
const { extractKeywords } = require('./parseJobAd');

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

/**
 * Flatten all text content from a JSON Resume into a single lowercase string.
 */
function flattenResume(resume) {
    const parts = [];

    // Basics
    if (resume.basics) {
        parts.push(resume.basics.summary || '');
        parts.push(resume.basics.label || '');
    }

    // Skills
    if (resume.skills) {
        resume.skills.forEach(s => {
            parts.push(s.name);
            parts.push(...(s.keywords || []));
        });
    }

    // Work
    if (resume.work) {
        resume.work.forEach(w => {
            parts.push(w.position || '');
            parts.push(w.summary || '');
            parts.push(...(w.highlights || []));
        });
    }

    // Projects
    if (resume.projects) {
        resume.projects.forEach(p => {
            parts.push(p.name || '');
            parts.push(p.description || '');
            parts.push(p.summary || '');
            parts.push(...(p.highlights || []));
        });
    }

    // Education
    if (resume.education) {
        resume.education.forEach(e => {
            parts.push(e.area || '');
            parts.push(e.studyType || '');
        });
    }

    return parts.join(' ').toLowerCase();
}

/**
 * Check ATS parsing — basic structural validation.
 */
function checkAtsParsing(resume) {
    const issues = [];

    if (!resume.basics?.name) issues.push('Missing name');
    if (!resume.basics?.email) issues.push('Missing email');
    if (!resume.basics?.summary) issues.push('Missing summary');
    if (!resume.work || resume.work.length === 0) issues.push('No work experience');
    if (!resume.skills || resume.skills.length === 0) issues.push('No skills section');
    if (!resume.education || resume.education.length === 0) issues.push('No education');

    // Check work entries have dates
    if (resume.work) {
        resume.work.forEach((w, i) => {
            if (!w.startDate) issues.push(`Work entry ${i + 1} missing start date`);
        });
    }

    return {
        pass: issues.length === 0,
        issues,
    };
}

/**
 * Calculate match score.
 * @param {string} jobAdText - Raw job ad text
 * @param {object} resumeJson - Tailored resume JSON
 * @returns {object} Score report
 */
function calculateScore(jobAdText, resumeJson) {
    // Extract keywords from job ad
    const { keywords: jobKeywords } = extractKeywords(jobAdText);

    // Flatten resume to searchable text
    const resumeText = flattenResume(resumeJson);

    // Match each keyword
    const matched = [];
    const missing = [];

    for (const kw of jobKeywords) {
        if (resumeText.includes(kw.toLowerCase())) {
            matched.push(kw);
        } else {
            missing.push(kw);
        }
    }

    const total = jobKeywords.length;
    const matchScore = total > 0 ? Math.round((matched.length / total) * 100) : 0;

    // ATS parsing check
    const ats = checkAtsParsing(resumeJson);

    return {
        matchScore,
        matchedCount: matched.length,
        totalKeywords: total,
        matchedKeywords: matched,
        missingKeywords: missing,
        atsParsing: ats.pass ? 'PASS' : 'FAIL',
        atsIssues: ats.issues,
        timestamp: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main() {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.includes('--help')) {
        console.log('Usage: node scripts/scoreResume.js <job-ad.txt> <tailored_resume.json> [--output score.json]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const jobAdPath = args[0];
    const resumePath = args[1];

    if (!fs.existsSync(jobAdPath)) {
        console.error(`Error: Job ad not found: ${jobAdPath}`);
        process.exit(1);
    }
    if (!fs.existsSync(resumePath)) {
        console.error(`Error: Resume not found: ${resumePath}`);
        process.exit(1);
    }

    const jobAdText = fs.readFileSync(jobAdPath, 'utf-8');
    const resumeJson = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));

    const score = calculateScore(jobAdText, resumeJson);

    // Output
    const outputIdx = args.indexOf('--output');
    if (outputIdx !== -1 && args[outputIdx + 1]) {
        const outPath = args[outputIdx + 1];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(score, null, 2));
        console.log(`Score report → ${outPath}`);
    } else {
        // Default: write to same directory as the resume
        const outDir = path.dirname(resumePath);
        const outPath = path.join(outDir, 'score.json');
        fs.writeFileSync(outPath, JSON.stringify(score, null, 2));
        console.log(`Score report → ${outPath}`);
    }

    // Print summary
    console.log('');
    console.log(`Match Score:      ${score.matchScore}%`);
    console.log(`Keywords Matched: ${score.matchedCount}/${score.totalKeywords}`);
    console.log(`ATS Parsing:      ${score.atsParsing}`);
    if (score.missingKeywords.length > 0) {
        console.log(`Missing Keywords: ${score.missingKeywords.join(', ')}`);
    }
    if (score.atsIssues.length > 0) {
        console.log(`ATS Issues:       ${score.atsIssues.join(', ')}`);
    }
}

module.exports = { calculateScore, flattenResume, checkAtsParsing };

if (require.main === module) main();
