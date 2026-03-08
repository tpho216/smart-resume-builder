#!/usr/bin/env node
/**
 * generateTheme.js — Generate a custom JSON Resume theme (self-contained HTML
 * template) based on a structure analysis from an uploaded resume.
 *
 * The generated theme respects:
 *   - Section order from the original resume
 *   - Content style per section (bullets, prose, grid, etc.)
 *   - Hierarchy and emphasis patterns
 *
 * Usage:
 *   node scripts/generateTheme.js <structure.json> [--output themes/custom-theme/]
 *   node scripts/generateTheme.js <structure.json> --preview resume.json
 *
 * The generated theme is a valid jsonresume-theme-* compatible module.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Section renderers — each produces an HTML fragment for a JSON Resume section
// ---------------------------------------------------------------------------

const SECTION_RENDERERS = {
    contact: {
        render: (data) => `
    <section class="section section-contact">
      <div class="contact-bar">
        \${basics.email ? \`<span>📧 \${basics.email}</span>\` : ''}
        \${basics.phone ? \`<span>📞 \${basics.phone}</span>\` : ''}
        \${basics.url ? \`<span>🔗 <a href="\${basics.url}">\${basics.url}</a></span>\` : ''}
        \${basics.location ? \`<span>📍 \${basics.location.city}, \${basics.location.region || basics.location.countryCode}</span>\` : ''}
        \${(basics.profiles || []).map(p => \`<span><a href="\${p.url}">\${p.network}</a></span>\`).join('')}
      </div>
    </section>`,
        label: 'Contact',
    },

    summary: {
        render: (style) => {
            return `
    <section class="section section-summary">
      <h2>Summary</h2>
      \${basics.summary ? \`<p class="summary-text">\${basics.summary}</p>\` : ''}
    </section>`;
        },
        label: 'Summary',
    },

    experience: {
        render: (style) => {
            const highlightTag = style && style.type === 'bullets' ? 'ul' : 'div';
            const highlightItem = style && style.type === 'bullets' ? 'li' : 'p';
            return `
    <section class="section section-experience">
      <h2>Experience</h2>
      \${(resume.work || []).map(w => \`
        <div class="entry">
          <div class="entry-header">
            <div>
              <strong>\${w.position}</strong> — \${w.name}
            </div>
            <span class="date">\${w.startDate || ''} – \${w.endDate || 'Present'}</span>
          </div>
          \${w.summary ? \`<p class="entry-summary">\${w.summary}</p>\` : ''}
          \${w.highlights && w.highlights.length ? \`<${highlightTag} class="highlights">\${w.highlights.map(h => \`<${highlightItem}>\${h}</${highlightItem}>\`).join('')}</${highlightTag}>\` : ''}
        </div>
      \`).join('')}
    </section>`;
        },
        label: 'Experience',
    },

    education: {
        render: (style) => `
    <section class="section section-education">
      <h2>Education</h2>
      \${(resume.education || []).map(e => \`
        <div class="entry">
          <div class="entry-header">
            <div>
              <strong>\${e.studyType || ''} — \${e.area || ''}</strong>
            </div>
            <span class="date">\${e.startDate || ''} – \${e.endDate || ''}</span>
          </div>
          <p>\${e.institution || ''}\${e.score ? \` — GPA: \${e.score}\` : ''}</p>
        </div>
      \`).join('')}
    </section>`,
        label: 'Education',
    },

    skills: {
        render: (style) => {
            const isGrid = !style || style.type === 'list' || style.type === 'bullets';
            if (isGrid) {
                return `
    <section class="section section-skills">
      <h2>Skills</h2>
      <div class="skills-grid">
        \${(resume.skills || []).map(s => \`
          <div class="skill-group">
            <strong>\${s.name}</strong>
            <span>\${(s.keywords || []).join(', ')}</span>
          </div>
        \`).join('')}
      </div>
    </section>`;
            }
            // Inline style
            return `
    <section class="section section-skills">
      <h2>Skills</h2>
      <div class="skills-inline">
        \${(resume.skills || []).map(s => \`
          <div><strong>\${s.name}:</strong> \${(s.keywords || []).join(' · ')}</div>
        \`).join('')}
      </div>
    </section>`;
        },
        label: 'Skills',
    },

    projects: {
        render: (style) => `
    <section class="section section-projects">
      <h2>Projects</h2>
      \${(resume.projects || []).map(p => \`
        <div class="entry">
          <div class="entry-header">
            <strong>\${p.name}</strong>
            <span class="date">\${p.startDate || ''} – \${p.endDate || 'Present'}</span>
          </div>
          \${p.description ? \`<p class="entry-summary">\${p.description}</p>\` : ''}
          \${p.highlights && p.highlights.length ? \`<ul class="highlights">\${p.highlights.map(h => \`<li>\${h}</li>\`).join('')}</ul>\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'Projects',
    },

    certificates: {
        render: () => `
    <section class="section section-certificates">
      <h2>Certificates</h2>
      \${(resume.certificates || []).filter(c => c.name && !c.name.startsWith('YOUR_')).map(c => \`
        <div class="entry-inline">
          <strong>\${c.name}</strong>\${c.issuer ? \` — \${c.issuer}\` : ''}\${c.date ? \` (\${c.date})\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'Certificates',
    },

    awards: {
        render: () => `
    <section class="section section-awards">
      <h2>Awards</h2>
      \${(resume.awards || []).map(a => \`
        <div class="entry-inline">
          <strong>\${a.title}</strong>\${a.awarder ? \` — \${a.awarder}\` : ''}\${a.date ? \` (\${a.date})\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'Awards',
    },

    publications: {
        render: () => `
    <section class="section section-publications">
      <h2>Publications</h2>
      \${(resume.publications || []).map(p => \`
        <div class="entry-inline">
          <strong>\${p.name}</strong>\${p.publisher ? \` — \${p.publisher}\` : ''}\${p.releaseDate ? \` (\${p.releaseDate})\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'Publications',
    },

    languages: {
        render: () => `
    <section class="section section-languages">
      <h2>Languages</h2>
      <div class="inline-list">
        \${(resume.languages || []).map(l => \`<span>\${l.language}\${l.fluency ? \` (\${l.fluency})\` : ''}</span>\`).join(' · ')}
      </div>
    </section>`,
        label: 'Languages',
    },

    interests: {
        render: () => `
    <section class="section section-interests">
      <h2>Interests</h2>
      <div class="inline-list">
        \${(resume.interests || []).filter(i => i.name && !i.name.startsWith('YOUR_')).map(i => \`<span>\${i.name}</span>\`).join(' · ')}
      </div>
    </section>`,
        label: 'Interests',
    },

    references: {
        render: () => `
    <section class="section section-references">
      <h2>References</h2>
      \${(resume.references || []).map(r => \`
        <div class="entry-inline">
          <strong>\${r.name}</strong>\${r.reference ? \`: \${r.reference}\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'References',
    },

    volunteer: {
        render: () => `
    <section class="section section-volunteer">
      <h2>Volunteer</h2>
      \${(resume.volunteer || []).map(v => \`
        <div class="entry">
          <div class="entry-header">
            <strong>\${v.position || ''}</strong> — \${v.organization || ''}
            <span class="date">\${v.startDate || ''} – \${v.endDate || ''}</span>
          </div>
          \${v.summary ? \`<p>\${v.summary}</p>\` : ''}
        </div>
      \`).join('')}
    </section>`,
        label: 'Volunteer',
    },
};

// Default section order when no structure analysis is provided
const DEFAULT_ORDER = [
    'contact', 'summary', 'experience', 'projects', 'skills',
    'education', 'certificates', 'awards', 'languages', 'references',
];

// ---------------------------------------------------------------------------
// Theme CSS generation
// ---------------------------------------------------------------------------

function generateCSS(layoutHints = {}) {
    const skillsLayout = layoutHints.skillsEarly ? 'grid' : 'inline';

    return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #333;
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 24px;
      line-height: 1.6;
      font-size: 14px;
    }
    h1 { font-size: 2em; color: #1a1a1a; margin-bottom: 4px; }
    h2 {
      font-size: 1.15em;
      color: #2563eb;
      border-bottom: 2px solid #2563eb;
      padding-bottom: 3px;
      margin: 24px 0 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .subtitle { color: #555; font-size: 1.05em; margin-bottom: 6px; }
    .contact-bar {
      display: flex; flex-wrap: wrap; gap: 12px;
      font-size: 0.88em; color: #555; margin-bottom: 6px;
    }
    .contact-bar a { color: #2563eb; text-decoration: none; }
    .summary-text { margin-bottom: 4px; }
    .section { margin-bottom: 8px; }
    .entry { margin-bottom: 14px; }
    .entry-header {
      display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap;
    }
    .entry-summary { color: #555; margin: 2px 0; font-size: 0.93em; }
    .date { color: #888; font-size: 0.88em; white-space: nowrap; }
    .highlights { padding-left: 20px; margin-top: 4px; }
    .highlights li, .highlights p { margin-bottom: 3px; font-size: 0.93em; }
    .skills-grid {
      display: flex; flex-wrap: wrap; gap: 10px;
    }
    .skill-group {
      background: #f0f4ff; border-radius: 8px; padding: 8px 12px; min-width: 180px;
    }
    .skill-group strong { display: block; margin-bottom: 2px; font-size: 0.9em; }
    .skill-group span { font-size: 0.85em; color: #555; }
    .skills-inline div { margin-bottom: 4px; }
    .inline-list { font-size: 0.93em; }
    .entry-inline { margin-bottom: 4px; }
    @media print { body { padding: 16px; font-size: 12px; } h2 { margin-top: 16px; } }
  `;
}

// ---------------------------------------------------------------------------
// Theme template generation
// ---------------------------------------------------------------------------

/**
 * Generate a JSON Resume theme module from a structure analysis.
 * @param {object} structure - Output of analyzeStructure()
 * @returns {{ indexJs: string, themeDir: string, sectionOrder: string[] }}
 */
function generateTheme(structure) {
    // Determine section order
    let sectionOrder;
    if (structure && structure.sectionOrder && structure.sectionOrder.length > 0) {
        sectionOrder = structure.sectionOrder;

        // Ensure contact is present (always rendered at top)
        if (!sectionOrder.includes('contact')) {
            sectionOrder.unshift('contact');
        }
    } else {
        sectionOrder = [...DEFAULT_ORDER];
    }

    // Gather content styles per section for style-aware rendering
    const styleMap = {};
    if (structure && structure.sections) {
        structure.sections.forEach(s => {
            if (s.sectionKey && s.contentStyle) {
                styleMap[s.sectionKey] = s.contentStyle;
            }
        });
    }

    const layoutHints = (structure && structure.layoutHints) || {};
    const css = generateCSS(layoutHints);

    // Build section render calls
    const sectionCalls = sectionOrder
        .filter(key => SECTION_RENDERERS[key])
        .map(key => {
            const renderer = SECTION_RENDERERS[key];
            const style = styleMap[key] || null;
            const template = typeof renderer.render === 'function' ? renderer.render(style) : '';
            return { key, template };
        });

    // Build the render function body as a template literal string
    const sectionHtml = sectionCalls.map(s => s.template).join('\n');

    // Generate index.js — a valid jsonresume-theme-* module
    const indexJs = `/**
 * Auto-generated JSON Resume theme
 * Based on structure analysis of uploaded resume.
 * Section order: ${sectionOrder.join(' → ')}
 *
 * Generated: ${new Date().toISOString()}
 */

exports.render = function(resume) {
  const basics = resume.basics || {};
  const name = basics.name || 'Resume';

  return \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>\${name} — Resume</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>\${name}</h1>
    \${basics.label ? \`<div class="subtitle">\${basics.label}</div>\` : ''}
  </header>
${sectionHtml}
</body>
</html>\`;
};
`;

    return {
        indexJs,
        sectionOrder,
        styleMap,
    };
}

/**
 * Preview: render a resume using the generated theme.
 */
function previewWithTheme(themeIndexJs, resumeJson) {
    // Create a temporary module
    const m = { exports: {} };
    const fn = new Function('exports', 'module', themeIndexJs);
    fn(m.exports, m);
    return m.exports.render(resumeJson);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node scripts/generateTheme.js <structure.json> [--output themes/custom/] [--preview resume.json]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const structurePath = args[0];
    if (!fs.existsSync(structurePath)) {
        console.error(`Error: File not found: ${structurePath}`);
        process.exit(1);
    }

    const structure = JSON.parse(fs.readFileSync(structurePath, 'utf-8'));
    const theme = generateTheme(structure);

    console.log(`Section order: ${theme.sectionOrder.join(' → ')}`);
    console.log(`Style map: ${Object.keys(theme.styleMap).join(', ') || '(none)'}`);

    // Output theme
    const outputIdx = args.indexOf('--output');
    const themeDir = outputIdx !== -1 ? args[outputIdx + 1] : path.join(__dirname, '..', 'themes', 'custom-generated');
    fs.mkdirSync(themeDir, { recursive: true });

    const indexPath = path.join(themeDir, 'index.js');
    fs.writeFileSync(indexPath, theme.indexJs);
    console.log(`Theme → ${indexPath}`);

    // Write package.json for the theme
    const themePkg = {
        name: 'jsonresume-theme-custom-generated',
        version: '1.0.0',
        description: 'Auto-generated JSON Resume theme based on uploaded resume structure',
        main: 'index.js',
    };
    fs.writeFileSync(path.join(themeDir, 'package.json'), JSON.stringify(themePkg, null, 2));

    // Optional preview
    const previewIdx = args.indexOf('--preview');
    if (previewIdx !== -1 && args[previewIdx + 1]) {
        const resumePath = args[previewIdx + 1];
        const resumeJson = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
        const html = previewWithTheme(theme.indexJs, resumeJson);
        const previewPath = path.join(themeDir, 'preview.html');
        fs.writeFileSync(previewPath, html);
        console.log(`Preview → ${previewPath}`);
    }
}

module.exports = { generateTheme, previewWithTheme, SECTION_RENDERERS, DEFAULT_ORDER };

if (require.main === module) main();
