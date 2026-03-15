/**
 * Shared type definitions for the resume-builder pipeline.
 */

// ---------------------------------------------------------------------------
// JSON Resume schema types (subset used by this project)
// ---------------------------------------------------------------------------

export interface ResumeLocation {
    address?: string;
    postalCode?: string;
    city?: string;
    countryCode?: string;
    region?: string;
}

export interface ResumeProfile {
    network: string;
    username?: string;
    url: string;
}

export interface ResumeBasics {
    name: string;
    label?: string;
    image?: string;
    email?: string;
    phone?: string;
    url?: string;
    summary?: string;
    location?: ResumeLocation;
    profiles?: ResumeProfile[];
}

export interface ResumeWorkEntry {
    name: string;
    position: string;
    url?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    highlights?: string[];
    _tags?: string[];
    _score?: number;
}

export interface ResumeProject {
    name: string;
    description?: string;
    summary?: string;
    startDate?: string;
    endDate?: string;
    url?: string;
    highlights?: string[];
    keywords?: string[];
    roles?: string[];
    entity?: string;
    type?: string;
    _tags?: string[];
    _score?: number;
}

export interface ResumeSkillGroup {
    name: string;
    level?: string;
    keywords: string[];
    _matchCount?: number;
}

export interface ResumeEducation {
    institution: string;
    url?: string;
    area?: string;
    studyType?: string;
    startDate?: string;
    endDate?: string;
    score?: string;
    courses?: string[];
}

export interface ResumeAward {
    title: string;
    date?: string;
    awarder?: string;
    summary?: string;
}

export interface ResumeCertificate {
    name: string;
    date?: string;
    issuer?: string;
    url?: string;
}

export interface ResumePublication {
    name: string;
    publisher?: string;
    releaseDate?: string;
    url?: string;
    summary?: string;
}

export interface ResumeLanguage {
    language: string;
    fluency?: string;
}

export interface ResumeInterest {
    name: string;
    keywords?: string[];
}

export interface ResumeReference {
    name: string;
    reference?: string;
}

export interface ResumeVolunteer {
    organization?: string;
    position?: string;
    url?: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
    highlights?: string[];
}

export interface JsonResume {
    basics?: ResumeBasics;
    work?: ResumeWorkEntry[];
    volunteer?: ResumeVolunteer[];
    education?: ResumeEducation[];
    awards?: ResumeAward[];
    certificates?: ResumeCertificate[];
    publications?: ResumePublication[];
    skills?: ResumeSkillGroup[];
    languages?: ResumeLanguage[];
    interests?: ResumeInterest[];
    references?: ResumeReference[];
    projects?: ResumeProject[];
    _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Job ad parsing types
// ---------------------------------------------------------------------------

export type Seniority = 'senior' | 'mid' | 'junior';

export interface JobAdSections {
    [key: string]: string;
}

export interface ExtractedKeywords {
    keywords: string[];
    sections: JobAdSections;
    rawText: string;
}

// ---------------------------------------------------------------------------
// Score types
// ---------------------------------------------------------------------------

export interface AtsResult {
    pass: boolean;
    issues: string[];
}

export interface ScoreReport {
    matchScore: number;
    matchedCount: number;
    totalKeywords: number;
    matchedKeywords: string[];
    missingKeywords: string[];
    atsParsing: 'PASS' | 'FAIL';
    atsIssues: string[];
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Structure analysis types (Phase 2)
// ---------------------------------------------------------------------------

export interface ContentStyle {
    type: 'bullets' | 'prose' | 'list' | 'paragraph' | 'empty';
    lineCount: number;
    bulletCount: number;
    dateCount?: number;
    avgLineLength?: number;
    hasDates?: boolean;
}

export interface SectionAnalysis {
    heading: string;
    sectionKey: string;
    order: number;
    paragraphIndex: number;
    contentStyle: ContentStyle;
    lineCount: number;
}

export interface HeaderBlock {
    lines: string[];
    lineCount: number;
    hasSummary: boolean;
}

export interface LayoutHints {
    hasContactSection: boolean;
    hasSummarySection: boolean;
    experienceBeforeEducation: boolean;
    skillsEarly: boolean;
    totalSections: number;
    detectedSections: number;
    unknownSections: number;
}

export interface StructureAnalysis {
    nameCandidate: string | null;
    sectionOrder: string[];
    sections: SectionAnalysis[];
    headerBlock: HeaderBlock | null;
    layoutHints: LayoutHints;
    totalParagraphs: number;
}

// ---------------------------------------------------------------------------
// Heading candidate types
// ---------------------------------------------------------------------------

export interface HeadingCandidate {
    index: number;
    text: string;
    isLikelyHeading: boolean;
    isAllCaps: boolean;
    endsWithColon: boolean;
    charCount: number;
}

// ---------------------------------------------------------------------------
// Parsed resume types (Phase 2 upload)
// ---------------------------------------------------------------------------

export interface ParsedPdf {
    format: 'pdf';
    pages: string[];
    fullText: string;
    meta: {
        pageCount: number;
        info: Record<string, unknown>;
    };
}

export interface ParsedDocx {
    format: 'docx';
    html: string;
    fullText: string;
    messages: unknown[];
    meta: Record<string, unknown>;
}

export interface ParsedResume {
    format: 'pdf' | 'docx';
    pages?: string[];
    html?: string;
    fullText: string;
    meta: Record<string, unknown>;
    messages?: unknown[];
    paragraphs: string[];
    headingCandidates: HeadingCandidate[];
    totalParagraphs: number;
    totalHeadingCandidates: number;
}

// ---------------------------------------------------------------------------
// Theme generation types
// ---------------------------------------------------------------------------

export interface GeneratedTheme {
    indexJs: string;
    sectionOrder: string[];
    styleMap: Record<string, ContentStyle>;
}

export interface SectionRenderer {
    render: (style?: ContentStyle | null) => string;
    label: string;
}

// ---------------------------------------------------------------------------
// LLM config types
// ---------------------------------------------------------------------------

export interface LlmProviderConfig {
    model: string;
    apiKeyEnv: string;
    baseUrl: string;
    maxTokens: number;
    temperature: number;
}

/**
 * Flat task-facing LLM config — specify a provider key plus optional per-field
 * overrides. Full provider details (model, API keys, URLs) live in
 * config/llm_providers.json so they are never duplicated across task files.
 */
export interface TaskLlmConfig {
    /** Key matching an entry in config/llm_providers.json. */
    provider: string;
    /** Override the prompt template path (relative to project root). */
    promptFile?: string;
    /** Override the provider's model name. */
    model?: string;
    /** Override the provider's base URL. */
    baseUrl?: string;
    /** Override max tokens. */
    maxTokens?: number;
    /** Override sampling temperature. */
    temperature?: number;
}

// ---------------------------------------------------------------------------
// Task config types  (replaces global config/llm-config.json)
// ---------------------------------------------------------------------------

/**
 * A task file (inputs/tasks/task_<n>.json) bundles every setting needed to
 * run one pipeline job.  CLI flags take precedence over anything set here.
 */
export interface TaskConfig {
    /** Human-readable task number (matches filename suffix). */
    task?: number;
    /** Short description shown in CLI output. */
    description?: string;

    // ── Pipeline inputs ─────────────────────────────────────
    /** Path to the base JSON Resume (relative to project root). */
    baseResume?: string;
    /**
     * Job ad(s) to process.
     *  - string path  → single job ad
     *  - string[]     → multiple job ads
     *  - "all"        → every .txt file in inputs/job_ads/
     */
    jobAd?: string | string[];
    /** Path to an uploaded resume (PDF/DOCX) for Phase-2 pipeline. */
    uploadedResume?: string;
    /**
     * Path to a template resume (PDF/DOCX) whose layout should be replicated.
     * When set, the pipeline runs Phase 2: analyze structure → generate
     * custom theme → render with that theme.
     */
    templateResume?: string;
    /**
     * Name of a JSON Resume theme to render with (e.g. "elegant", "even").
     * The theme package `jsonresume-theme-<name>` is installed on the fly if
     * it is not already available.  Ignored when templateResume is set.
     */
    theme?: string;
    /**
     * Path to a pre-built *_tpl.docx (produced by scripts/buildDocxTemplate.ts).
     * Uses docxtemplater for pixel-accurate rendering without an LLM call at render time.
     * Requires a companion *_mapping.json in outputs/llm_docx_analysis/.
     */
    templateDocxTpl?: string;

    // ── Pipeline behaviour ──────────────────────────────────
    /** "programmatic" (default) or "llm". */
    mode?: 'programmatic' | 'llm';
    /** Override the default outputs/ root directory. */
    outputDir?: string;

    // ── LLM settings ────────────────────────────────────────
    /**
     * LLM selector — specifies the provider and optional per-field overrides.
     * Full provider definitions live in config/llm_providers.json.
     * Only consulted when mode is "llm".
     */
    llm?: TaskLlmConfig;
}

// ---------------------------------------------------------------------------
// Pipeline types
// ---------------------------------------------------------------------------

export interface PipelineResult {
    jobName: string;
    outDir: string;
    score: ScoreReport;
}

export interface Phase2PipelineOptions {
    uploadedResumePath: string;
    jobAdPath?: string | null;
    basePath?: string;
    outputDir?: string | null;
    mode?: 'programmatic' | 'llm';
    /** Optional LLM selector from a task file. */
    llmConfig?: TaskLlmConfig;
}

export interface Phase2PipelineResult {
    outDir: string;
    structure: StructureAnalysis;
    theme: GeneratedTheme;
    score: ScoreReport | null;
}

// ---------------------------------------------------------------------------
// DocxMapping — shared schema for buildDocxTemplate + renderDocxFromTemplate
// ---------------------------------------------------------------------------

export interface DocxMapping {
    version: '1';
    simpleReplacements: Array<{ anchor: string; template: string }>;
    paragraphLoops: Array<{
        loopVar: string; itemField: string; anchors: string[];
    }>;
    tableRowLoops: Array<{
        loopVar: string; sectionAnchor: string; columnFields: string[];
    }>;
    tableCellFields: Array<{
        sectionAnchor: string; columnPlaceholders: string[];
    }>;
    sectionLoops: Array<{
        loopVar: string;
        startAnchor: string;
        endAnchor: string;
        headingTemplate: string;
        headingStyle?: 'heading2' | 'bold';
        bodyPatterns: Array<{
            prefix: string;
            field?: string;
            template?: string;
            keepLiteral?: boolean;
        }>;
        summaryField?: string;
        highlights?: { loopVar: string; itemField: string };
    }>;
    data: Record<string, DocxDataSpec>;
}

export type DocxDataSpec =
    | { type: 'path'; path: string }
    | { type: 'split'; path: string; by: string; index: number }
    | { type: 'literal'; value: string }
    | { type: 'concat'; paths: string[]; sep: string }
    | { type: 'profile'; network: string; field: string }
    | { type: 'splitSentences'; path: string; itemField: string }
    | { type: 'formatDate'; path: string }
    | { type: 'array'; path: string; itemMap: Record<string, DocxDataSpec> }
    | { type: 'extractPrefix'; prefix: string }
    | { type: 'filterRest'; exclude: string[]; itemField: string }
    | { type: 'certs'; inProgress: boolean };

export type SectionKey =
    | 'contact'
    | 'summary'
    | 'experience'
    | 'education'
    | 'skills'
    | 'projects'
    | 'certificates'
    | 'awards'
    | 'publications'
    | 'languages'
    | 'interests'
    | 'references'
    | 'volunteer';
