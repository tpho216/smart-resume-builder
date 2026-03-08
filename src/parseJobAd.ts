#!/usr/bin/env node
/**
 * parseJobAd.ts — Extract keywords and required skills from a job ad text file.
 *
 * Usage:
 *   node dist/parseJobAd.js <path-to-job-ad.txt>
 *   node dist/parseJobAd.js job_ads/senior_fullstack_engineer.txt
 *
 * Output: JSON with extracted keywords, skills, and metadata to stdout.
 * Optionally writes to a file with --output flag.
 *
 * Phase 2 hook: This module exports extractKeywords() for programmatic use.
 */

import fs from 'fs';
import path from 'path';
import type { Seniority, JobAdSections, ExtractedKeywords } from './types';

// ---------------------------------------------------------------------------
// Skill / keyword dictionary — maps common resume terms to canonical names.
// Extend this list as needed; keeps matching deterministic without NLP deps.
// ---------------------------------------------------------------------------
export const SKILL_DICTIONARY: Record<string, string> = {
    // Frontend
    react: 'React', 'react.js': 'React', reactjs: 'React',
    typescript: 'TypeScript', ts: 'TypeScript',
    javascript: 'JavaScript', js: 'JavaScript',
    vite: 'Vite', redux: 'Redux', 'react native': 'React Native',
    pwa: 'PWAs', pwas: 'PWAs',
    html: 'HTML5', html5: 'HTML5', css: 'CSS3', css3: 'CSS3',
    'responsive design': 'Responsive Design',
    angular: 'Angular', vue: 'Vue', 'vue.js': 'Vue', vuejs: 'Vue',
    nextjs: 'Next.js', 'next.js': 'Next.js',

    // Backend
    node: 'Node.js', 'node.js': 'Node.js', nodejs: 'Node.js',
    nestjs: 'NestJS', 'nest.js': 'NestJS',
    express: 'Express', 'express.js': 'Express',
    fastapi: 'FastAPI', python: 'Python',
    'rest api': 'REST APIs', 'rest apis': 'REST APIs', restful: 'REST APIs',
    graphql: 'GraphQL',
    microservices: 'Microservices', microservice: 'Microservices',
    websocket: 'WebSockets', websockets: 'WebSockets',

    // Database
    postgresql: 'PostgreSQL', postgres: 'PostgreSQL',
    mysql: 'MySQL', mongodb: 'MongoDB', mongo: 'MongoDB',
    redis: 'Redis',
    mikroorm: 'MikroORM', typeorm: 'TypeORM', prisma: 'Prisma',
    sql: 'SQL', 'database design': 'Database Design',

    // Cloud & DevOps
    aws: 'AWS', 'amazon web services': 'AWS',
    lambda: 'Lambda', ecs: 'ECS', rds: 'RDS', s3: 'S3',
    iam: 'IAM', route53: 'Route53', cloudwatch: 'CloudWatch',
    cloudfront: 'CloudFront',
    azure: 'Azure',
    terraform: 'Terraform', 'infrastructure as code': 'Terraform',
    cloudformation: 'CloudFormation',
    docker: 'Docker', 'docker compose': 'Docker Compose',
    'github actions': 'GitHub Actions', 'gitlab ci': 'GitLab CI',
    cicd: 'CI/CD', 'ci/cd': 'CI/CD',
    nginx: 'Nginx',
    kubernetes: 'Kubernetes', k8s: 'Kubernetes',

    // AI
    copilot: 'GitHub Copilot', 'github copilot': 'GitHub Copilot',
    claude: 'Claude CLI', 'claude cli': 'Claude CLI', 'claude code': 'Claude Code',
    'prompt engineering': 'Prompt Engineering',
    'ai agent': 'AI Agent Orchestration', agentic: 'AI Agent Orchestration',
    llm: 'LLM', llms: 'LLM', 'large language model': 'LLM',
    openai: 'OpenAI', codex: 'OpenAI Codex',

    // Modern stack
    tanstack: 'TanStack', 'tanstack start': 'TanStack Start', tanstackstart: 'TanStack Start',
    cloudflare: 'Cloudflare', 'cloudflare workers': 'Cloudflare Workers',
    supabase: 'Supabase',
    django: 'Django',
    dbt: 'dbt',
    dagster: 'Dagster',

    // Testing
    jest: 'Jest', supertest: 'Supertest', cypress: 'Cypress',
    'unit test': 'Unit testing', 'unit testing': 'Unit testing',
    'integration test': 'Integration testing', 'integration testing': 'Integration testing',
    'e2e test': 'E2E testing', 'e2e testing': 'E2E testing', 'end-to-end': 'E2E testing',
    tdd: 'TDD',

    // Architecture
    'event-driven': 'Event-driven architecture', 'event driven': 'Event-driven architecture',
    'domain-driven': 'Domain-Driven Design', ddd: 'Domain-Driven Design',
    rbac: 'RBAC', oauth: 'OAuth2', oauth2: 'OAuth2', jwt: 'OAuth2',
    'api gateway': 'API Gateway',

    // General
    git: 'Git', agile: 'Agile', scrum: 'Scrum',
};

// Multi-word phrases to check first (longest match wins)
const PHRASE_KEYS: string[] = Object.keys(SKILL_DICTIONARY)
    .filter(k => k.includes(' ') || k.includes('-') || k.includes('/'))
    .sort((a, b) => b.length - a.length);

const SINGLE_KEYS: string[] = Object.keys(SKILL_DICTIONARY)
    .filter(k => !k.includes(' ') && !k.includes('-') && !k.includes('/'));

/**
 * Extract keywords from job ad text.
 */
export function extractKeywords(text: string): ExtractedKeywords {
    const lower = text.toLowerCase();
    const found = new Set<string>();

    // 1. Match multi-word phrases first
    for (const phrase of PHRASE_KEYS) {
        if (lower.includes(phrase)) {
            found.add(SKILL_DICTIONARY[phrase]);
        }
    }

    // 2. Match single-word keywords with word-boundary awareness
    const words = lower.replace(/[(),;:!?]/g, ' ').split(/\s+/);
    for (const word of words) {
        const clean = word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
        if (SKILL_DICTIONARY[clean]) {
            found.add(SKILL_DICTIONARY[clean]);
        }
    }

    // 3. Extract soft sections
    const sections = extractSections(text);

    return {
        keywords: [...found].sort(),
        sections,
        rawText: text.trim(),
    };
}

/**
 * Best-effort section extraction from job ad.
 */
function extractSections(text: string): JobAdSections {
    const sections: JobAdSections = {};
    const sectionPattern = /^(About|Responsibilities|Requirements|Nice to Have|Qualifications|Skills|Experience|Benefits)[:\s—–-]*/gim;
    let match: RegExpExecArray | null;
    const positions: { name: string; index: number }[] = [];
    while ((match = sectionPattern.exec(text)) !== null) {
        positions.push({ name: match[1].trim(), index: match.index + match[0].length });
    }
    for (let i = 0; i < positions.length; i++) {
        const end = i + 1 < positions.length ? positions[i + 1].index - 20 : text.length;
        sections[positions[i].name.toLowerCase()] = text.slice(positions[i].index, end).trim();
    }
    return sections;
}

/**
 * Derive seniority level from ad text.
 */
export function deriveSeniority(text: string): Seniority {
    const lower = text.toLowerCase();
    if (/\bsenior\b|\bsr\.?\b|\blead\b|\bstaff\b|\bprincipal\b/.test(lower)) return 'senior';
    if (/\bjunior\b|\bjr\.?\b|\bgrad(uate)?\b|\bentry[\s-]level\b/.test(lower)) return 'junior';
    return 'mid';
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main(): void {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help')) {
        console.log('Usage: node dist/parseJobAd.js <job-ad.txt> [--output <file>]');
        process.exit(args.includes('--help') ? 0 : 1);
    }

    const inputPath = args[0];
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File not found: ${inputPath}`);
        process.exit(1);
    }

    const text = fs.readFileSync(inputPath, 'utf-8');
    const result: ExtractedKeywords & { seniority?: Seniority; sourceFile?: string } = extractKeywords(text);
    result.seniority = deriveSeniority(text);
    result.sourceFile = path.basename(inputPath, '.txt');

    const outputIdx = args.indexOf('--output');
    if (outputIdx !== -1 && args[outputIdx + 1]) {
        const outPath = args[outputIdx + 1];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.log(`Parsed job ad → ${outPath}`);
    } else {
        console.log(JSON.stringify(result, null, 2));
    }
}

if (require.main === module) main();
