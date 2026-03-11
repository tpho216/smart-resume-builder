#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
    Document, Packer, Paragraph, TextRun,
    Table, TableRow, TableCell,
    WidthType, BorderStyle, TableLayoutType,
    convertInchesToTwip,
} from 'docx';

const FONT = 'Calibri';
const MARGIN = convertInchesToTwip(0.5);
const PAGE_W = convertInchesToTwip(7.5);

const BORDER_SOLID = {
    top: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    left: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
    right: { style: BorderStyle.SINGLE, size: 6, color: '000000' },
};

const BORDER_NONE = {
    top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    bottom: { style: BorderStyle.NONE, size: 0, color: '000000' },
    left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
};

function p(text: string, bold = false, sizePt = 11, indentTwip = 0): Paragraph {
    return new Paragraph({
        indent: indentTwip ? { left: indentTwip } : undefined,
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text, font: FONT, size: sizePt * 2, bold })],
    });
}

function heading(text: string): Paragraph {
    return new Paragraph({
        spacing: { before: 160, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2563EB' } },
        children: [new TextRun({ text, font: FONT, size: 28, bold: true, color: '2563EB' })],
    });
}

function empty(): Paragraph {
    return new Paragraph({ children: [new TextRun({ text: '', font: FONT, size: 22 })] });
}

// ── Table 1: Header (1×2) ───────────────────────────────────────────────────
function headerTable(): Table {
    const lw = convertInchesToTwip(4.5);
    const rw = PAGE_W - lw;
    return new Table({
        width: { size: PAGE_W, type: WidthType.DXA },
        columnWidths: [lw, rw],
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({
            children: [
                new TableCell({
                    borders: BORDER_SOLID, width: { size: lw, type: WidthType.DXA },
                    children: [
                        p('Alex Smith', true, 20),
                        p('Backend Developer', true, 14),
                        p('Node.js · TypeScript · AWS · Postgres · Docker', false, 10),
                    ],
                }),
                new TableCell({
                    borders: BORDER_SOLID, width: { size: rw, type: WidthType.DXA },
                    children: [
                        p('Melbourne, VIC', false, 10),
                        p('Australian Citizen', false, 10),
                        p('alex.smith@placeholder.io', false, 10),
                        p('+61 400 111 222', false, 10),
                        p('linkedin.com/in/alexsmith', false, 10),
                        p('github.com/alexsmith', false, 10),
                        p('alexsmith.dev', false, 10),
                    ],
                }),
            ],
        })],
    });
}

// ── Table 2: Skills grid (3×2) ──────────────────────────────────────────────
function skillsTable(): Table {
    const lw = convertInchesToTwip(1.4);
    const rw = PAGE_W - lw;
    const rows: [string, string][] = [
        ['Expert', 'TypeScript, Python, PostgreSQL, Node.js, REST APIs, Docker, Git, GitHub Actions'],
        ['Proficient', 'React, Next.js, Redis, Terraform, AWS Lambda & ECS, Jest, OpenTelemetry'],
        ['Familiar', 'Go, Kubernetes, MongoDB, GraphQL, Azure, Datadog, Ansible'],
    ];
    return new Table({
        width: { size: PAGE_W, type: WidthType.DXA },
        columnWidths: [lw, rw],
        layout: TableLayoutType.FIXED,
        rows: rows.map(([label, skills]) => new TableRow({
            children: [
                new TableCell({
                    borders: BORDER_SOLID, width: { size: lw, type: WidthType.DXA },
                    children: [p(label, true, 11)],
                }),
                new TableCell({
                    borders: BORDER_SOLID, width: { size: rw, type: WidthType.DXA },
                    children: [p(skills, false, 11)],
                }),
            ],
        })),
    });
}

// ── Table 3: Certifications (1×2) ───────────────────────────────────────────
function certsTable(): Table {
    const hw = Math.round(PAGE_W / 2);
    const left = [
        ['Completed in 2024:', true],
        ['AWS Solutions Architect – Associate', false],
        ['Node.js: The Complete Guide (Udemy)', false],
        ['PostgreSQL: Up and Running (O\'Reilly)', false],
        ['Docker & Kubernetes: The Practical Guide', false],
    ] as [string, boolean][];
    const right = [
        ['Completed in 2025:', true],
        ['AWS Developer – Associate', false],
        ['Terraform: Getting Started', false],
        ['Advanced TypeScript (Frontend Masters)', false],
        ['System Design Fundamentals (Educative)', false],
    ] as [string, boolean][];
    return new Table({
        width: { size: PAGE_W, type: WidthType.DXA },
        columnWidths: [hw, hw],
        layout: TableLayoutType.FIXED,
        rows: [new TableRow({
            children: [
                new TableCell({
                    borders: BORDER_SOLID, width: { size: hw, type: WidthType.DXA },
                    children: left.map(([t, b]) => p(t, b, 11)),
                }),
                new TableCell({
                    borders: BORDER_SOLID, width: { size: hw, type: WidthType.DXA },
                    children: right.map(([t, b]) => p(t, b, 11)),
                }),
            ],
        })],
    });
}

const IND36 = convertInchesToTwip(0.5);   // 36pt ≈ 0.5"
const IND54 = convertInchesToTwip(0.75);  // 54pt ≈ 0.75"
const IND72 = convertInchesToTwip(1.0);   // 72pt ≈ 1"

const doc = new Document({
    sections: [{
        properties: {
            page: {
                size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
                margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
            },
        },
        children: [
            // Header
            headerTable(),

            // Summary
            empty(),
            heading('SUMMARY'),
            p('Results-driven backend developer with 3+ years building high-throughput REST APIs.', false, 11, IND36),
            p('Strong ownership mindset — delivered a full rewrite of a legacy billing service solo.', false, 11, IND36),
            p('Passionate about clean architecture, observability, and developer experience.', false, 11, IND36),
            p('Continuously exploring better approaches to distributed systems and API design.', false, 11, IND72),

            // Skills
            empty(),
            heading('SKILLS'),
            skillsTable(),

            // Work Experience
            empty(),
            heading('WORK EXPERIENCE'),
            p('Placeholder Tech  –  Backend Engineer  •  Jan 2023 – PRESENT', true, 12),
            p('Fast-growing SaaS platform serving 50k+ daily active users across ANZ.', false, 11),
            p('Key contributions:', true, 11),
            p('Rewrote legacy billing service in TypeScript, cutting p99 latency from 2s to 180ms.', true, 11, IND54),
            p('Designed self-serve onboarding API used by 12 enterprise clients.', true, 11, IND54),
            p('Introduced contract testing (Pact), reducing integration failures in CI by 60%.', true, 11, IND54),
            p('Built real-time webhook delivery with exponential back-off and dead-letter queues.', true, 11, IND54),
            p('Established OpenAPI-first workflow; improved external docs coverage 40% → 100%.', true, 11, IND54),

            empty(),
            p('Example Consultancy  –  Junior Developer  •  Feb 2021 – Dec 2022', true, 12),
            p('Boutique consultancy delivering bespoke web apps for SME clients.', false, 11),
            p('Key contributions:', true, 11),
            p('Delivered three client projects end-to-end using React + Express + PostgreSQL.', true, 11, IND54),
            p('Automated deployment pipelines with GitHub Actions, reducing release effort by 80%.', true, 11, IND54),
            p('Mentored two junior developers through onboarding and code-review practices.', true, 11, IND54),

            // Education
            empty(),
            heading('EDUCATION'),
            p('BSc, Computer Science  (GPA 6.8 / 7.0)  2018 – 2021', true, 11),
            p('Placeholder University', false, 11),
            p('Graduated with distinction; Dean\'s List 2019–2021.', false, 11),
            empty(),
            p('NSW Higher School Certificate  (ATAR 96)  2017', true, 11),

            // Certifications
            empty(),
            heading('CERTIFICATIONS / COURSES'),
            certsTable(),

            // Hobbies
            empty(),
            heading('HOBBIES AND INTERESTS'),
            p('Reading technical and philosophy books — recent: Designing Data-Intensive Applications.', true, 11, IND36),
            p('Contributing to open-source; maintain a small CLI utility for local AWS Lambda testing.', true, 11, IND36),
            p('Sport — Brazilian jiu-jitsu (blue belt), trail running, rock climbing.', true, 11, IND36),
        ],
    }],
});

const outPath = path.resolve(process.cwd(), 'outputs/replica_test.docx');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
Packer.toBuffer(doc).then(buf => {
    fs.writeFileSync(outPath, buf);
    console.log('Written:', outPath);
});
