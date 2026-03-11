# Smart Resume Builder — AI-Assisted JSON Resume Pipeline

Automatically **tailor**, **render**, and **score** resumes for specific job ads using a CLI-driven Node.js/TypeScript pipeline built on the [JSON Resume](https://jsonresume.org) standard. Upload an existing resume to **analyze its structure** and **generate a matching theme**, or specify a named theme to render with.

> **Demo:** [GitHub Pages](https://tpho216.github.io/smart-resume-builder/) — pre-generated outputs from dummy job ads and sample resumes.

---

## Architecture

The unified pipeline handles both workflows through a single entry-point (`pipeline.ts`):

- **`templateResume` set** → Phase 2 (parse template → analyze structure → custom theme → tailor → render)
- **`theme` set** → Phase 1 with a named JSON Resume theme (auto-installed if needed)
- **Neither** → Phase 1 with the default "elegant" theme

### Phase 1 — Tailor & Score

```
base-resume.json          ← Superset of all skills, projects, experience
        │
        ▼
 ┌─────────────┐    job_ads/*.txt
 │ parseJobAd  │◄──────────────
 └──────┬──────┘
        │ keywords
        ▼
 ┌──────────────┐
 │ tailorResume │──► tailored_resume.json  (filtered & prioritised)
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │ renderResume │──► Resume_Jane_Doe.html + .pdf + .docx
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │ scoreResume  │──► score.json  (match %, ATS pass/fail, missing keywords)
 └──────────────┘
```

### Phase 2 — Structure Analysis & Theme Generation

```
template_resume.pdf/.docx         ← Uploaded resume whose layout to replicate
        │
        ▼
 ┌─────────────────────┐
 │ parseUploadedResume │──► extracted text + heading candidates
 └──────────┬──────────┘
            │
            ▼
 ┌──────────────────┐
 │ analyzeStructure │──► section order, content styles, layout hints
 └──────────┬───────┘
            │
            ▼
 ┌───────────────┐
 │ generateTheme │──► custom jsonresume-theme (index.js + package.json)
 └───────┬───────┘
         │
         ▼
  [Phase 1 pipeline]  ──► Tailor + Render (with custom theme) + Score
```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your personal resume file from the example template
cp base-resume-example.json base-resume.json

# 3. Edit base-resume.json with your own data (see "Setting Up Your Resume" below)

# 4. Run the pipeline with a task file
npm run task:1

# 5. Or run for ALL job ads at once
npm run pipeline:all
```

> **Note:** `base-resume.json` is git-ignored to keep personal data out of version control.

---

## Setting Up Your Resume

`base-resume.json` is your **superset resume** — it contains *all* your skills, projects, and experience. The pipeline filters and tailors it for each job ad.

1. Copy the example template:
   ```bash
   cp base-resume-example.json base-resume.json
   ```
2. Open `base-resume.json` and replace the placeholder data with your own:
   - **basics** — name, email, phone, location, LinkedIn/GitHub profiles
   - **work** — all work experience entries with highlights and `_tags`
   - **education** — degrees, institutions, dates
   - **skills** — skill categories with keyword lists
   - **projects** — all notable projects with highlights, keywords, and `_tags`
   - **awards / certificates / languages** — as applicable
3. The `_tags` arrays on work and project entries help the tailoring engine select the most relevant items for each job ad. Use short descriptive tags like `"fullstack"`, `"backend"`, `"cloud"`, `"devops"`, etc.
4. The file follows the [JSON Resume](https://jsonresume.org/schema) schema. Validate with:
   ```bash
   npm run validate
   ```

### Output

```
outputs/
  job_senior_fullstack_engineer/
    tailored_resume.json
    Resume_Jane_Doe.html
    Resume_Jane_Doe.pdf
    Resume_Jane_Doe.docx
    score.json
  job_backend_nodejs_developer/
    ...
```

---

## Task Files

Tasks are the recommended way to configure pipeline runs. Each task file bundles all settings needed for one job:

```json
{
    "task": 1,
    "description": "Senior Fullstack Engineer — LLM-tailored",
    "baseResume": "base-resume.json",
    "jobAd": "inputs/job_ads/senior_fullstack_engineer.txt",
    "mode": "llm",
    "outputDir": "outputs/job_senior_fullstack_engineer",
    "templateResume": "inputs/job_templates/resume_template_1.docx",
    "theme": "elegant",
    "llm": {
        "provider": "github-copilot",
        "promptFile": "config/llm-prompt.md"
    }
}
```

| Field | Description |
|-------|-------------|
| `baseResume` | Path to the base JSON Resume |
| `jobAd` | Job ad file path, array of paths, or `"all"` |
| `mode` | `"programmatic"` (keyword matching) or `"llm"` (AI rewriting) |
| `outputDir` | Output directory for this run |
| `templateResume` | *(Phase 2)* Path to a template resume (PDF/DOCX) whose layout to replicate |
| `theme` | Named JSON Resume theme (e.g. `"elegant"`, `"even"`) — auto-installed if needed |
| `llm` | LLM provider config (only used when `mode` is `"llm"`) |

**Routing:** `templateResume` → Phase 2 custom theme. `theme` → named theme. Neither → default elegant.

---

## CLI Commands

### Unified pipeline (recommended)

```bash
# Via task file
tsx src/pipeline.ts --task inputs/tasks/task_1.json

# Shorthand (auto-detects .json as task file)
tsx src/pipeline.ts inputs/tasks/task_1.json

# Pure CLI (no task file)
tsx src/pipeline.ts --job-ad inputs/job_ads/senior_fullstack_engineer.txt

# With LLM tailoring
tsx src/pipeline.ts --job-ad inputs/job_ads/senior_fullstack_engineer.txt --mode llm

# Process all job ads
tsx src/pipeline.ts --all

# Phase 2 via CLI (template resume → custom theme)
tsx src/pipeline.ts --template-resume inputs/job_templates/resume_template_1.docx \
  --job-ad inputs/job_ads/senior_fullstack_engineer.txt

# Named theme
tsx src/pipeline.ts --theme even --job-ad inputs/job_ads/senior_fullstack_engineer.txt

# Override task file settings from CLI
tsx src/pipeline.ts --task inputs/tasks/task_1.json --mode programmatic --provider anthropic
```

### npm scripts

```bash
npm run pipeline          # Run pipeline (requires flags or task)
npm run pipeline:all      # Run for all job ads
npm run task:1            # Run task 1
npm run task:2            # Run task 2
npm run validate          # Validate JSON Resume schema
npm run build             # Compile TypeScript
```

### Individual steps

```bash
# Parse a job ad (extract keywords)
node dist/parseJobAd.js inputs/job_ads/senior_fullstack_engineer.txt

# Tailor resume for a job ad
node dist/tailorResume.js inputs/job_ads/senior_fullstack_engineer.txt

# Render tailored resume to HTML + PDF
node dist/renderResume.js outputs/job_senior_fullstack_engineer/tailored_resume.json

# Score resume against job ad
node dist/scoreResume.js inputs/job_ads/senior_fullstack_engineer.txt

# Parse an uploaded resume (Phase 2)
node dist/parseUploadedResume.js samples/sample_resume.txt

# Analyze structure (Phase 2)
node dist/analyzeStructure.js samples/sample_resume.txt

# Generate a custom theme from structure (Phase 2)
node dist/generateTheme.js outputs/phase2_sample/structure_analysis.json --output themes/my-theme

# Generate demo assets for GitHub Pages
node dist/generateDemo.js
```

### CLI flags reference

| Flag | Description |
|------|-------------|
| `--task <path>` | Task config JSON file |
| `--mode <mode>` | `programmatic` or `llm` |
| `--base <path>` | Base resume JSON path |
| `--job-ad <path>` | Job ad `.txt` file (repeatable) |
| `--all` | Process all `.txt` files in `inputs/job_ads/` |
| `--output <dir>` | Output directory |
| `--provider <name>` | LLM provider (overrides task) |
| `--model <name>` | LLM model name (overrides task) |
| `--template-resume <path>` | Template resume PDF/DOCX → Phase 2 flow |
| `--theme <name>` | Named JSON Resume theme |

---

## Project Structure

```
smart-resume-builder/
├── base-resume.json              ← Your personal resume data (git-ignored)
├── base-resume-example.json      ← Example template with placeholder data
├── inputs/
│   ├── job_ads/                  ← Job ad text files
│   │   ├── senior_fullstack_engineer.txt
│   │   └── backend_nodejs_developer.txt
│   ├── job_templates/            ← Template resumes for Phase 2 (DOCX/PDF)
│   │   └── resume_template_1.docx
│   ├── samples/                  ← Sample uploaded resumes
│   └── tasks/                    ← Task config files
│       ├── task_1.json
│       └── task_2.json
├── src/                          ← TypeScript source
│   ├── pipeline.ts               ← Unified pipeline (Phase 1 + Phase 2)
│   ├── parseJobAd.ts             ← Extract keywords from job ads
│   ├── tailorResume.ts           ← Filter resume by relevance
│   ├── llmTailorResume.ts        ← LLM-powered resume tailoring
│   ├── renderResume.ts           ← HTML + PDF rendering (named themes)
│   ├── renderDocx.ts             ← DOCX rendering
│   ├── scoreResume.ts            ← ATS match scoring
│   ├── parseUploadedResume.ts    ← Parse PDF/DOCX/TXT uploads (Phase 2)
│   ├── analyzeStructure.ts       ← Detect section structure & style (Phase 2)
│   ├── generateTheme.ts          ← Generate custom JSON Resume theme (Phase 2)
│   ├── generateDemo.ts           ← Generate demo outputs for Pages
│   └── types.ts                  ← Shared TypeScript types
├── config/
│   ├── llm-config.json           ← LLM provider configuration
│   └── llm-prompt.md             ← LLM tailoring prompt template
├── outputs/                      ← Generated files per job ad
├── docs/                         ← GitHub Pages demo
│   ├── index.html
│   ├── app.js
│   ├── demo-manifest.json
│   └── phase2-manifest.json
├── themes/                       ← Generated custom themes
├── .github/workflows/
│   └── resume-pipeline.yml       ← CI: validate → build → score → deploy
├── package.json
├── tsconfig.json
└── README.md
```

---

## GitHub Actions CI/CD

The workflow (`.github/workflows/resume-pipeline.yml`) runs on push to `main`:

| Job              | Purpose                                                        | Fails CI?              |
| ---------------- | -------------------------------------------------------------- | ---------------------- |
| **validate**     | Validate `base-resume-example.json` against JSON Resume schema | Yes                    |
| **build**        | Tailor + render resumes for all job ads                        | Yes                    |
| **score-report** | Print ATS match scores and missing keywords                    | **No** (informational) |
| **deploy-pages** | Deploy demo to GitHub Pages (on `main` push)                   | No                     |

> CI uses `base-resume-example.json` (anonymised) since `base-resume.json` is git-ignored.

---

## ATS Score Calculation

The scoring engine (`scoreResume.ts`) compares tailored resume content against job ad keywords:

- **Match Score** = `(matched keywords / total job ad keywords) × 100`
- **ATS Parsing** = structural check (name, email, summary, work dates, skills, education)
- **Missing Keywords** = job ad keywords not found in the tailored resume

Example output (`score.json`):
```json
{
  "matchScore": 97,
  "matchedCount": 32,
  "totalKeywords": 33,
  "matchedKeywords": ["React", "TypeScript", "Node.js", "AWS"],
  "missingKeywords": ["CloudFormation"],
  "atsParsing": "PASS",
  "atsIssues": []
}
```

---

## Phase 2: Structure Analysis & Theme Generation

Phase 2 enables uploading an existing resume and reproducing its layout as a JSON Resume theme. It's triggered by setting `templateResume` in a task file or using `--template-resume` on the CLI.

### How it works

1. **Parse** — `parseUploadedResume.ts` reads PDF (via `pdf-parse`), DOCX (via `mammoth`), or plain text files. It extracts paragraphs and identifies heading candidates (short lines, ALL CAPS lines, colon-ending lines).

2. **Analyze** — `analyzeStructure.ts` maps headings to 13 known section types (contact, summary, experience, education, skills, projects, certificates, awards, publications, languages, interests, references, volunteer) using regex patterns. For each section it detects content style:
   - **bullets** — majority of lines start with bullet characters
   - **list** — short lines without bullets (e.g., skill lists)
   - **prose** — long continuous sentences
   - **paragraph** — mixed content

3. **Theme** — `generateTheme.ts` produces a self-contained `index.js` (valid jsonresume-theme module) with section renderers ordered to match the uploaded resume. The generated theme respects the detected layout hints.

4. **Render** — The generated theme is applied to the tailored resume and rendered to HTML + PDF + DOCX.

### Layout Hints

| Hint                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `experienceBeforeEducation` | Experience section appears before Education          |
| `skillsEarly`               | Skills section appears in the top half of the resume |
| `hasSummarySection`         | Resume includes a summary/objective section          |

### Supported Input Formats

| Format  | Parser      | Notes                                       |
| ------- | ----------- | ------------------------------------------- |
| `.pdf`  | `pdf-parse` | Extracts text layer; scanned PDFs need OCR  |
| `.docx` | `mammoth`   | Converts to plain text preserving structure |
| `.txt`  | Built-in    | Direct text processing                      |

---

## Demo / Portfolio

The [GitHub Pages demo](https://tpho216.github.io/smart-resume-builder/) has two tabs:

### Phase 1: Tailor & Score
- Resume preview (rendered HTML)
- PDF download link
- ATS match score with matched/missing keywords
- Job ad selector between example outputs

### Phase 2: Structure & Theme
- Uploaded resume structure analysis
- Section flow visualisation (detected section order)
- Content style indicators (bullets, prose, list, paragraph)
- Layout hints (experience before education, skills early, has summary)
- Themed resume preview using the generated theme

> These are example outputs generated from dummy job ads and sample resumes for demonstration purposes.

---

## For Users Who Want to Run Their Own Pipeline

1. **Fork** this repository
2. Copy the example: `cp base-resume-example.json base-resume.json`
3. Fill in `base-resume.json` with your own resume data (see [Setting Up Your Resume](#setting-up-your-resume))
4. Add your job ads to `inputs/job_ads/`
5. Create a task file in `inputs/tasks/` (see [Task Files](#task-files))
6. Run: `npm run task:1` or `tsx src/pipeline.ts --all`
7. Check `outputs/` for your tailored resumes and scores

---

## Future Roadmap

- [ ] **Font/style detection** — Exact replication of fonts, colours, spacing from uploaded PDFs
- [ ] **Theme marketplace** — Share and reuse generated layout templates
- [ ] **Web UI** — Browser-based upload + preview interface

---

## Dependencies

| Package                    | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `resume-cli`               | JSON Resume schema validation                    |
| `jsonresume-theme-elegant` | Default HTML theme rendering                     |
| `puppeteer`                | PDF generation via headless Chrome               |
| `pdf-parse`                | Extract text from uploaded PDF resumes (Phase 2) |
| `mammoth`                  | Extract text from uploaded DOCX resumes (Phase 2)|
| `docx`                     | Generate DOCX output files                       |
| `dotenv`                   | Load environment variables for LLM API keys      |
| `tsx`                      | Run TypeScript directly without compiling         |
| `typescript`               | TypeScript compiler                              |

---

## License

MIT
