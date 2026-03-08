#!/usr/bin/env node
/**
 * renderDocx.ts — Render a tailored JSON Resume into a DOCX file that faithfully
 * replicates the section order and layout of a reference resume.
 *
 * Key design principles:
 *   - Section order comes from the reference resume's structure analysis
 *   - Sections present in the reference but empty in the candidate's data get
 *     placeholder text (e.g. "[YOUR CERTIFICATIONS HERE]") so you can fill in later
 *   - Content style (bullets vs prose) mirrors the reference
 *   - Produces an editable .docx you can open in Word/Google Docs
 *
 * Usage:
 *   node dist/renderDocx.js <tailored_resume.json> --structure <structure.json> [--output resume.docx]
 *
 * Programmatic:
 *   import { renderToDocx } from './renderDocx';
 *   const buffer = await renderToDocx(resume, structure);
 */

import fs from 'fs';
import path from 'path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  TabStopPosition,
  TabStopType,
  BorderStyle,
  ISectionOptions,
  convertInchesToTwip,
  ExternalHyperlink,
} from 'docx';
import type { JsonResume, StructureAnalysis, ContentStyle } from './types';

// ---------------------------------------------------------------------------
// Style constants matching a clean professional resume
// ---------------------------------------------------------------------------
const FONT = 'Calibri';
const FONT_SIZE_NAME = 28;      // 14pt
const FONT_SIZE_LABEL = 22;     // 11pt
const FONT_SIZE_HEADING = 22;   // 11pt
const FONT_SIZE_BODY = 20;      // 10pt
const FONT_SIZE_SMALL = 18;     // 9pt
const COLOR_PRIMARY = '2563EB';
const COLOR_DARK = '1A1A1A';
const COLOR_GREY = '666666';
const PLACEHOLDER_COLOR = 'CC0000';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function heading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        font: FONT,
        size: FONT_SIZE_HEADING,
        color: COLOR_PRIMARY,
      }),
    ],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 1, color: COLOR_PRIMARY },
    },
  });
}

function bodyText(text: string, opts: { bold?: boolean; italic?: boolean; color?: string; size?: number } = {}): TextRun {
  return new TextRun({
    text,
    font: FONT,
    size: opts.size || FONT_SIZE_BODY,
    bold: opts.bold || false,
    italics: opts.italic || false,
    color: opts.color || COLOR_DARK,
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    children: [bodyText(text)],
    bullet: { level: 0 },
    spacing: { after: 40 },
  });
}

function placeholder(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: `[${text}]`,
        font: FONT,
        size: FONT_SIZE_BODY,
        color: PLACEHOLDER_COLOR,
        italics: true,
      }),
    ],
    spacing: { after: 80 },
  });
}

function entryHeader(left: string, right: string): Paragraph {
  return new Paragraph({
    children: [
      bodyText(left, { bold: true }),
      new TextRun({
        text: '\t',
        font: FONT,
      }),
      bodyText(right, { color: COLOR_GREY, size: FONT_SIZE_SMALL }),
    ],
    tabStops: [
      { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
    ],
    spacing: { before: 120, after: 40 },
  });
}

function formatDate(d: string | undefined): string {
  if (!d) return 'Present';
  // Try to make "2023-01-01" into "Jan 2023"
  const m = d.match(/^(\d{4})-(\d{2})/);
  if (m) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Section builders — each returns Paragraph[] for that section
// ---------------------------------------------------------------------------

function buildContact(resume: JsonResume): Paragraph[] {
  const b = resume.basics;
  if (!b) return [placeholder('YOUR CONTACT INFORMATION HERE')];
  const parts: Paragraph[] = [];

  // Name
  parts.push(new Paragraph({
    children: [
      new TextRun({ text: b.name || '', font: FONT, size: FONT_SIZE_NAME, bold: true, color: COLOR_DARK }),
    ],
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
  }));

  // Label / title
  if (b.label) {
    parts.push(new Paragraph({
      children: [bodyText(b.label, { size: FONT_SIZE_LABEL, color: COLOR_GREY })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    }));
  }

  // Contact line
  const contactBits: string[] = [];
  if (b.location) contactBits.push(`${b.location.city || ''}, ${b.location.region || b.location.countryCode || ''}`);
  if (b.email) contactBits.push(`Email: ${b.email}`);
  if (b.phone) contactBits.push(`Phone: ${b.phone}`);
  if (contactBits.length) {
    parts.push(new Paragraph({
      children: [bodyText(contactBits.join('  |  '), { size: FONT_SIZE_SMALL, color: COLOR_GREY })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
    }));
  }

  // Profiles
  if (b.profiles && b.profiles.length) {
    const profileTexts = b.profiles.map(p => `${p.network}: ${p.url}`).join('  |  ');
    parts.push(new Paragraph({
      children: [bodyText(profileTexts, { size: FONT_SIZE_SMALL, color: COLOR_GREY })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }));
  }

  return parts;
}

function buildSummary(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Summary')];
  const summary = resume.basics?.summary;
  if (summary) {
    parts.push(new Paragraph({
      children: [bodyText(summary)],
      spacing: { after: 80 },
    }));
  } else {
    parts.push(placeholder('YOUR PROFESSIONAL SUMMARY HERE'));
  }
  return parts;
}

function buildSkills(resume: JsonResume, style?: ContentStyle | null): Paragraph[] {
  const parts: Paragraph[] = [heading('Skills')];
  if (!resume.skills || resume.skills.length === 0) {
    parts.push(placeholder('YOUR SKILLS HERE'));
    return parts;
  }
  for (const group of resume.skills) {
    const keywords = (group.keywords || []).join(', ');
    parts.push(new Paragraph({
      children: [
        bodyText(`${group.name}: `, { bold: true }),
        bodyText(keywords),
      ],
      spacing: { after: 40 },
    }));
  }
  return parts;
}

function buildExperience(resume: JsonResume, style?: ContentStyle | null): Paragraph[] {
  const parts: Paragraph[] = [heading('Work Experience')];
  if (!resume.work || resume.work.length === 0) {
    parts.push(placeholder('YOUR WORK EXPERIENCE HERE'));
    return parts;
  }
  for (const w of resume.work) {
    const dateRange = `${formatDate(w.startDate)} – ${formatDate(w.endDate)}`;
    parts.push(entryHeader(`${w.name}: ${w.position}`, dateRange));
    if (w.summary) {
      parts.push(new Paragraph({
        children: [bodyText(w.summary, { italic: true, color: COLOR_GREY })],
        spacing: { after: 40 },
      }));
    }
    if (w.highlights && w.highlights.length) {
      for (const h of w.highlights) {
        parts.push(bullet(h));
      }
    }
  }
  return parts;
}

function buildProjects(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Projects')];
  if (!resume.projects || resume.projects.length === 0) {
    parts.push(placeholder('YOUR PROJECTS HERE'));
    return parts;
  }
  for (const p of resume.projects) {
    const dateRange = `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`;
    parts.push(entryHeader(p.name, dateRange));
    if (p.description) {
      parts.push(new Paragraph({
        children: [bodyText(p.description, { italic: true, color: COLOR_GREY })],
        spacing: { after: 40 },
      }));
    }
    if (p.highlights && p.highlights.length) {
      for (const h of p.highlights) {
        parts.push(bullet(h));
      }
    }
  }
  return parts;
}

function buildEducation(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Education')];
  if (!resume.education || resume.education.length === 0) {
    parts.push(placeholder('YOUR EDUCATION HERE'));
    return parts;
  }
  for (const e of resume.education) {
    const title = [e.studyType, e.area].filter(Boolean).join(', ');
    const score = e.score ? ` (GPA ${e.score})` : '';
    const dateRange = `${formatDate(e.startDate)} – ${formatDate(e.endDate)}`;
    parts.push(entryHeader(`${title}${score}`, dateRange));
    parts.push(new Paragraph({
      children: [bodyText(e.institution || '')],
      spacing: { after: 60 },
    }));
  }
  return parts;
}

function buildCertificates(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Certifications / Courses')];
  if (!resume.certificates || resume.certificates.length === 0) {
    parts.push(placeholder('YOUR CERTIFICATIONS HERE'));
    return parts;
  }
  for (const c of resume.certificates) {
    const date = c.date ? ` (${c.date})` : '';
    const issuer = c.issuer ? ` — ${c.issuer}` : '';
    parts.push(new Paragraph({
      children: [bodyText(`${c.name}${issuer}${date}`)],
      spacing: { after: 40 },
    }));
  }
  return parts;
}

function buildAwards(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Awards')];
  if (!resume.awards || resume.awards.length === 0) {
    parts.push(placeholder('YOUR AWARDS HERE'));
    return parts;
  }
  for (const a of resume.awards) {
    const date = a.date ? ` (${a.date})` : '';
    parts.push(new Paragraph({
      children: [
        bodyText(a.title, { bold: true }),
        bodyText(`${a.awarder ? ` — ${a.awarder}` : ''}${date}`),
      ],
      spacing: { after: 40 },
    }));
  }
  return parts;
}

function buildLanguages(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Languages')];
  if (!resume.languages || resume.languages.length === 0) {
    parts.push(placeholder('YOUR LANGUAGES HERE'));
    return parts;
  }
  const langs = resume.languages.map(l => `${l.language}${l.fluency ? ` (${l.fluency})` : ''}`).join(' · ');
  parts.push(new Paragraph({
    children: [bodyText(langs)],
    spacing: { after: 80 },
  }));
  return parts;
}

function buildInterests(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Hobbies and Interests')];
  if (!resume.interests || resume.interests.length === 0) {
    parts.push(placeholder('YOUR INTERESTS HERE'));
    return parts;
  }
  const items = resume.interests.map(i => i.name).filter(Boolean).join(', ');
  parts.push(new Paragraph({
    children: [bodyText(items)],
    spacing: { after: 80 },
  }));
  return parts;
}

function buildReferences(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('References')];
  if (!resume.references || resume.references.length === 0) {
    parts.push(placeholder('YOUR REFERENCES HERE'));
    return parts;
  }
  for (const r of resume.references) {
    parts.push(new Paragraph({
      children: [
        bodyText(r.name, { bold: true }),
        r.reference ? bodyText(`: ${r.reference}`) : bodyText(''),
      ],
      spacing: { after: 40 },
    }));
  }
  return parts;
}

function buildVolunteer(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Volunteer')];
  if (!resume.volunteer || resume.volunteer.length === 0) {
    parts.push(placeholder('YOUR VOLUNTEER EXPERIENCE HERE'));
    return parts;
  }
  for (const v of resume.volunteer) {
    const dateRange = `${formatDate(v.startDate)} – ${formatDate(v.endDate)}`;
    parts.push(entryHeader(`${v.position || ''} — ${v.organization || ''}`, dateRange));
    if (v.summary) {
      parts.push(new Paragraph({
        children: [bodyText(v.summary)],
        spacing: { after: 40 },
      }));
    }
  }
  return parts;
}

function buildPublications(resume: JsonResume): Paragraph[] {
  const parts: Paragraph[] = [heading('Publications')];
  if (!resume.publications || resume.publications.length === 0) {
    parts.push(placeholder('YOUR PUBLICATIONS HERE'));
    return parts;
  }
  for (const p of resume.publications) {
    const date = p.releaseDate ? ` (${p.releaseDate})` : '';
    parts.push(new Paragraph({
      children: [
        bodyText(p.name, { bold: true }),
        bodyText(`${p.publisher ? ` — ${p.publisher}` : ''}${date}`),
      ],
      spacing: { after: 40 },
    }));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Section builder dispatch
// ---------------------------------------------------------------------------

const SECTION_BUILDERS: Record<string, (resume: JsonResume, style?: ContentStyle | null) => Paragraph[]> = {
  contact: (r) => buildContact(r),
  summary: (r) => buildSummary(r),
  skills: (r, s) => buildSkills(r, s),
  experience: (r, s) => buildExperience(r, s),
  projects: (r) => buildProjects(r),
  education: (r) => buildEducation(r),
  certificates: (r) => buildCertificates(r),
  awards: (r) => buildAwards(r),
  languages: (r) => buildLanguages(r),
  interests: (r) => buildInterests(r),
  references: (r) => buildReferences(r),
  volunteer: (r) => buildVolunteer(r),
  publications: (r) => buildPublications(r),
};

// Default section order when no structure provided
const DEFAULT_ORDER = [
  'contact', 'summary', 'skills', 'experience', 'projects',
  'education', 'certificates', 'awards', 'languages', 'references',
];

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render a JSON Resume to DOCX, replicating the section order from a reference
 * resume's structure analysis.
 *
 * Sections present in the structure but without data in the resume get
 * placeholder text so the user can fill them in manually.
 */
export async function renderToDocx(
  resume: JsonResume,
  structure?: StructureAnalysis | null,
): Promise<Buffer> {
  // Determine section order from the reference structure
  let sectionOrder: string[];
  const styleMap: Record<string, ContentStyle> = {};

  if (structure && structure.sectionOrder && structure.sectionOrder.length > 0) {
    sectionOrder = [...structure.sectionOrder];
    if (!sectionOrder.includes('contact')) {
      sectionOrder.unshift('contact');
    }
    // Build style map
    if (structure.sections) {
      for (const s of structure.sections) {
        if (s.sectionKey && s.contentStyle) {
          styleMap[s.sectionKey] = s.contentStyle;
        }
      }
    }
  } else {
    sectionOrder = [...DEFAULT_ORDER];
  }

  // Build all paragraphs in order
  const paragraphs: Paragraph[] = [];

  for (const sectionKey of sectionOrder) {
    const builder = SECTION_BUILDERS[sectionKey];
    if (!builder) continue;
    const style = styleMap[sectionKey] || null;
    const sectionParagraphs = builder(resume, style);
    paragraphs.push(...sectionParagraphs);
  }

  // Create document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: FONT_SIZE_BODY },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.5),
            bottom: convertInchesToTwip(0.5),
            left: convertInchesToTwip(0.6),
            right: convertInchesToTwip(0.6),
          },
        },
      },
      children: paragraphs,
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node dist/renderDocx.js <resume.json> [--structure structure.json] [--output resume.docx]');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  const resumePath = args[0];
  if (!fs.existsSync(resumePath)) {
    console.error(`Error: File not found: ${resumePath}`);
    process.exit(1);
  }

  const resume: JsonResume = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));

  // Optional structure analysis
  let structure: StructureAnalysis | null = null;
  const structIdx = args.indexOf('--structure');
  if (structIdx !== -1 && args[structIdx + 1]) {
    structure = JSON.parse(fs.readFileSync(args[structIdx + 1], 'utf-8'));
  }

  // Output path
  const outIdx = args.indexOf('--output');
  const name = (resume.basics?.name || 'Resume').replace(/\s+/g, '_');
  const outputPath = outIdx !== -1 ? args[outIdx + 1] : `Resume_${name}.docx`;

  const buffer = await renderToDocx(resume, structure);
  fs.writeFileSync(outputPath, buffer);
  console.log(`DOCX → ${outputPath}`);
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
