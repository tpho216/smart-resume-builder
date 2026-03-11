#!/usr/bin/env node
/**
 * renderResume.ts — Render a tailored_resume.json into HTML and PDF.
 *
 * Uses the jsonresume-theme-elegant theme and Puppeteer for PDF generation.
 * Falls back to a built-in minimal HTML renderer if the theme is unavailable.
 *
 * Usage:
 *   node dist/renderResume.js <tailored_resume.json> [--output-dir <dir>]
 *   node dist/renderResume.js outputs/job_senior_fullstack_engineer/tailored_resume.json
 *
 * Phase 2 hook: exports renderToHtml() and renderToPdf() for custom theme workflows.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { JsonResume } from './types';

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * CSS override injected after the elegant theme to shrink fonts for 2-page PDF fit.
 */
const ELEGANT_SIZE_OVERRIDE = `
<style>
  /* ── 2-page fit overrides ─────────────────────────── */
  body { font-size: 11.5px !important; line-height: 1.3 !important; }
  .container { max-width: 860px !important; padding: 0 8px !important; }
  h1, .name { font-size: 1.7em !important; margin-bottom: 0 !important; }
  h2, .section-title { font-size: 1.1em !important; margin-top: 10px !important; margin-bottom: 4px !important; padding-bottom: 2px !important; }
  h3 { font-size: 0.95em !important; margin-bottom: 0 !important; }
  .item { margin-bottom: 6px !important; padding-bottom: 0 !important; }
  .item-detail, .item p, p { font-size: 0.9em !important; line-height: 1.3 !important; margin-bottom: 2px !important; }
  ul { margin-top: 1px !important; margin-bottom: 2px !important; padding-left: 16px !important; }
  li { margin-bottom: 0 !important; padding-bottom: 0 !important; font-size: 0.9em !important; line-height: 1.3 !important; }
  .skills .item { margin-bottom: 2px !important; }
  .section { margin-bottom: 4px !important; padding-bottom: 0 !important; }
  header { margin-bottom: 4px !important; padding-bottom: 4px !important; }
  .date, .meta { font-size: 0.85em !important; }
  .summary { margin-bottom: 6px !important; }
  @media print { body { padding: 0 !important; margin: 0 !important; } }
</style>
`;

/**
 * Attempt to render using a JSON Resume theme package.
 * Falls back to built-in renderer.
 */
export function renderToHtml(resumeJson: JsonResume): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const theme = require('jsonresume-theme-elegant') as { render: (resume: JsonResume) => string };
        let html = theme.render(resumeJson);
        // Inject size overrides right before </head>
        html = html.replace('</head>', ELEGANT_SIZE_OVERRIDE + '</head>');
        return html;
    } catch {
        console.warn('Theme not installed, using built-in renderer. Run: npm install jsonresume-theme-elegant');
        return renderBuiltInHtml(resumeJson);
    }
}

/**
 * Render using a named JSON Resume theme package (e.g. "elegant", "even").
 * Installs the theme on the fly if it isn't already available.
 */
export function renderToHtmlWithNamedTheme(resumeJson: JsonResume, themeName: string): string {
    const pkgName = themeName.startsWith('jsonresume-theme-')
        ? themeName
        : `jsonresume-theme-${themeName}`;

    // Attempt to load; install if missing
    let theme: { render: (resume: JsonResume) => string };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        theme = require(pkgName) as typeof theme;
    } catch {
        console.log(`       Theme "${pkgName}" not found — installing...`);
        execSync(`npm install --no-save ${pkgName}`, {
            cwd: path.join(__dirname, '..'),
            stdio: 'pipe',
        });
        // Clear require cache and retry
        delete require.cache[require.resolve(pkgName)];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        theme = require(pkgName) as typeof theme;
        console.log(`       Installed ${pkgName}`);
    }

    let html = theme.render(resumeJson);

    // Apply same size overrides for consistent PDF output
    if (html.includes('</head>')) {
        html = html.replace('</head>', ELEGANT_SIZE_OVERRIDE + '</head>');
    }
    return html;
}

/**
 * Minimal built-in HTML renderer — ensures the pipeline works without deps.
 */
export function renderBuiltInHtml(resume: JsonResume): string {
    const basics = resume.basics || { name: 'Resume' };
    const esc = (s: string | undefined): string => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(basics.name)} — Resume</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 900px; margin: 0 auto; padding: 20px 20px; line-height: 1.4; font-size: 0.85em; }
    h1 { font-size: 1.6em; color: #1a1a1a; margin-bottom: 2px; }
    h2 { font-size: 1.1em; color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 2px; margin: 16px 0 8px; }
    h3 { font-size: 0.95em; color: #1a1a1a; margin-bottom: 1px; }
    .subtitle { color: #666; font-size: 0.95em; margin-bottom: 4px; }
    .contact { color: #555; font-size: 0.82em; margin-bottom: 10px; }
    .contact a { color: #2563eb; text-decoration: none; }
    .summary { margin-bottom: 12px; font-size: 0.9em; }
    .entry { margin-bottom: 10px; }
    .entry-header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; }
    .date { color: #888; font-size: 0.82em; }
    ul { padding-left: 18px; margin-top: 3px; }
    li { margin-bottom: 2px; font-size: 0.9em; }
    .skills-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .skill-group { background: #f0f4ff; border-radius: 6px; padding: 6px 10px; min-width: 180px; }
    .skill-group strong { display: block; margin-bottom: 2px; color: #1a1a1a; font-size: 0.9em; }
    .skill-group span { font-size: 0.82em; color: #555; }
    p { font-size: 0.9em; margin-bottom: 2px; }
    @media print { body { padding: 12px; } }
  </style>
</head>
<body>
`;

    // Header
    html += `<h1>${esc(basics.name)}</h1>\n`;
    if (basics.label) html += `<div class="subtitle">${esc(basics.label)}</div>\n`;

    const contactParts: string[] = [];
    if (basics.email) contactParts.push(`<a href="mailto:${esc(basics.email)}">${esc(basics.email)}</a>`);
    if (basics.phone) contactParts.push(esc(basics.phone));
    if (basics.url) contactParts.push(`<a href="${esc(basics.url)}">${esc(basics.url)}</a>`);
    if (basics.location) contactParts.push(`${esc(basics.location.city)}, ${esc(basics.location.region)}`);
    if (basics.profiles) {
        basics.profiles.forEach(p => {
            contactParts.push(`<a href="${esc(p.url)}">${esc(p.network)}</a>`);
        });
    }
    html += `<div class="contact">${contactParts.join(' · ')}</div>\n`;

    // Summary
    if (basics.summary) {
        html += `<div class="summary">${esc(basics.summary)}</div>\n`;
    }

    // Work
    if (resume.work && resume.work.length) {
        html += `<h2>Experience</h2>\n`;
        resume.work.forEach(w => {
            const end = w.endDate || 'Present';
            html += `<div class="entry">
  <div class="entry-header">
    <h3>${esc(w.position)} — ${esc(w.name)}</h3>
    <span class="date">${esc(w.startDate)} – ${esc(end)}</span>
  </div>
  ${w.summary ? `<p>${esc(w.summary)}</p>` : ''}
  ${w.highlights && w.highlights.length ? `<ul>${w.highlights.map(h => `<li>${esc(h)}</li>`).join('\n')}</ul>` : ''}
</div>\n`;
        });
    }

    // Projects
    if (resume.projects && resume.projects.length) {
        html += `<h2>Projects</h2>\n`;
        resume.projects.forEach(p => {
            const end = p.endDate || 'Present';
            html += `<div class="entry">
  <div class="entry-header">
    <h3>${esc(p.name)}</h3>
    <span class="date">${esc(p.startDate)} – ${esc(end)}</span>
  </div>
  ${p.description ? `<p>${esc(p.description)}</p>` : ''}
  ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
  ${p.highlights && p.highlights.length ? `<ul>${p.highlights.map(h => `<li>${esc(h)}</li>`).join('\n')}</ul>` : ''}
</div>\n`;
        });
    }

    // Skills
    if (resume.skills && resume.skills.length) {
        html += `<h2>Skills</h2>\n<div class="skills-grid">\n`;
        resume.skills.forEach(s => {
            html += `  <div class="skill-group"><strong>${esc(s.name)}</strong><span>${s.keywords.map(esc).join(', ')}</span></div>\n`;
        });
        html += `</div>\n`;
    }

    // Education
    if (resume.education && resume.education.length) {
        html += `<h2>Education</h2>\n`;
        resume.education.forEach(e => {
            html += `<div class="entry">
  <div class="entry-header">
    <h3>${esc(e.studyType)} — ${esc(e.area)}</h3>
    <span class="date">${esc(e.startDate)} – ${esc(e.endDate)}</span>
  </div>
  <p>${esc(e.institution)}${e.score ? ` — GPA: ${esc(e.score)}` : ''}</p>
</div>\n`;
        });
    }

    // Awards
    if (resume.awards && resume.awards.length) {
        html += `<h2>Awards</h2>\n`;
        resume.awards.forEach(a => {
            html += `<div class="entry"><h3>${esc(a.title)}</h3><p>${esc(a.awarder)} — ${esc(a.date)}</p></div>\n`;
        });
    }

    html += `</body>\n</html>`;
    return html;
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

/**
 * Render HTML string to PDF using Puppeteer.
 */
export async function renderToPdf(html: string, outputPath: string): Promise<boolean> {
    let puppeteer: typeof import('puppeteer');
    try {
        puppeteer = require('puppeteer');
    } catch {
        console.warn('Puppeteer not installed. Skipping PDF generation. Run: npm install puppeteer');
        return false;
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.pdf({
            path: outputPath,
            format: 'A4',
            margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
            printBackground: true,
        });
        return true;
    } finally {
        await browser.close();
    }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node dist/renderResume.js <tailored_resume.json> [--output-dir <dir>]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const resumePath = args[0];
    if (!fs.existsSync(resumePath)) {
        console.error(`Error: Resume file not found: ${resumePath}`);
        process.exit(1);
    }

    const resume: JsonResume = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
    const name = (resume.basics && resume.basics.name) || 'Resume';
    const safeName = name.replace(/\s+/g, '_');

    // Determine output directory
    const outDirIdx = args.indexOf('--output-dir');
    const outDir = outDirIdx !== -1 ? args[outDirIdx + 1] : path.dirname(resumePath);
    fs.mkdirSync(outDir, { recursive: true });

    // Render HTML
    console.log('Rendering HTML...');
    const html = renderToHtml(resume);
    const htmlPath = path.join(outDir, `Resume_${safeName}.html`);
    fs.writeFileSync(htmlPath, html);
    console.log(`HTML → ${htmlPath}`);

    // Render PDF
    console.log('Rendering PDF...');
    const pdfPath = path.join(outDir, `Resume_${safeName}.pdf`);
    const pdfOk = await renderToPdf(html, pdfPath);
    if (pdfOk) {
        console.log(`PDF  → ${pdfPath}`);
    } else {
        console.log('PDF skipped (puppeteer not available).');
    }

    console.log('Done.');
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
