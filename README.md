# Resume Builder — AI-Assisted JSON Resume Pipeline

Automatically **tailor**, **render**, and **score** resumes for specific job ads using a CLI-driven Node.js pipeline built on the [JSON Resume](https://jsonresume.org) standard. Upload an existing resume to **analyze its structure** and **generate a matching theme**.

> **Demo:** [GitHub Pages](https://tpho216.github.io/resume-builder/) — pre-generated outputs from dummy job ads.

---

## Architecture

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
 │ tailorResume │──► tailored_resume.json  (filtered & prioritized)
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │ renderResume │──► Resume_Peter_Ho.html + Resume_Peter_Ho.pdf
 └──────┬───────┘
        │
        ▼
 ┌──────────────┐
 │ scoreResume  │──► score.json  (match %, ATS pass/fail, missing keywords)
 └──────────────┘
```

### Phase 2 — Structure Analysis & Theme Generation

```
uploaded_resume.pdf/.docx/.txt
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
         ├──► (optional) tailorResume  ──► tailored_resume.json
         │
         ▼
 ┌──────────────┐
 │ renderResume │──► Themed HTML + PDF using the generated theme
 └──────────────┘
```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your personal resume file from the example template
cp base-resume-example.json base-resume.json

# 3. Edit base-resume.json with your own data (see "Setting Up Your Resume" below)

# 4. Run the full pipeline for a single job ad
node scripts/pipeline.js job_ads/senior_fullstack_engineer.txt

# 5. Or run for ALL job ads at once
node scripts/pipeline.js --all
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
   npx resume validate base-resume.json
   ```

### Output

```
outputs/
  job_senior_fullstack_engineer/
    tailored_resume.json
    Resume_Peter_Ho.html
    Resume_Peter_Ho.pdf
    score.json
  job_backend_nodejs_developer/
    ...
```

---

## CLI Commands

### Parse a job ad (extract keywords)
```bash
node scripts/parseJobAd.js job_ads/senior_fullstack_engineer.txt
```

### Tailor resume for a job ad
```bash
node scripts/tailorResume.js job_ads/senior_fullstack_engineer.txt
```

### Render tailored resume to HTML + PDF
```bash
node scripts/renderResume.js outputs/job_senior_fullstack_engineer/tailored_resume.json
```

### Score resume against job ad
```bash
node scripts/scoreResume.js job_ads/senior_fullstack_engineer.txt outputs/job_senior_fullstack_engineer/tailored_resume.json
```

### Full pipeline (parse → tailor → render → score)
```bash
node scripts/pipeline.js job_ads/senior_fullstack_engineer.txt
```

### Run for ALL job ads
```bash
node scripts/pipeline.js --all
```

### Generate demo assets for GitHub Pages
```bash
node scripts/generateDemo.js
```

### Validate JSON Resume schema
```bash
npx resume validate base-resume.json
```

### Phase 2 — Upload & analyze a resume
```bash
node scripts/parseUploadedResume.js samples/sample_resume.txt
```

### Phase 2 — Analyze structure
```bash
node scripts/analyzeStructure.js samples/sample_resume.txt
```

### Phase 2 — Generate a custom theme from structure
```bash
node scripts/generateTheme.js samples/sample_resume.txt --output themes/my-theme
```

### Phase 2 — Full pipeline (parse → analyze → theme → render)
```bash
node scripts/phase2Pipeline.js samples/sample_resume.txt --base base-resume.json
```

### Phase 2 — Full pipeline + tailor for a job ad
```bash
node scripts/phase2Pipeline.js samples/sample_resume.txt --base base-resume.json --job-ad job_ads/senior_fullstack_engineer.txt
```

---

## Project Structure

```
resume-builder/
├── base-resume.json              ← Your personal resume data (git-ignored)
├── base-resume-example.json      ← Example template with placeholder data
├── job_ads/                      ← Job ad text files
│   ├── senior_fullstack_engineer.txt
│   └── backend_nodejs_developer.txt
├── samples/                      ← Sample uploaded resumes (Phase 2)
│   ├── sample_resume.txt
│   └── sample_resume_devops.txt
├── scripts/
│   ├── parseJobAd.js             ← Extract keywords from job ad
│   ├── tailorResume.js           ← Filter resume by relevance
│   ├── renderResume.js           ← HTML + PDF rendering
│   ├── scoreResume.js            ← ATS match scoring
│   ├── pipeline.js               ← Full Phase 1 pipeline orchestrator
│   ├── generateDemo.js           ← Generate demo outputs for Pages
│   ├── parseUploadedResume.js    ← Parse PDF/DOCX/TXT uploads (Phase 2)
│   ├── analyzeStructure.js       ← Detect section structure & style (Phase 2)
│   ├── generateTheme.js          ← Generate custom JSON Resume theme (Phase 2)
│   └── phase2Pipeline.js         ← Full Phase 2 pipeline orchestrator
├── outputs/                      ← Generated files per job ad
│   ├── job_senior_fullstack_engineer/
│   └── job_backend_nodejs_developer/
├── docs/                         ← GitHub Pages demo
│   ├── index.html
│   ├── app.js
│   ├── demo-manifest.json
│   └── phase2-manifest.json
├── themes/                       ← Generated custom themes (Phase 2)
├── .github/workflows/
│   └── resume-pipeline.yml       ← CI: validate → build → score → deploy
├── package.json
└── README.md
```

---

## GitHub Actions CI/CD

The workflow (`.github/workflows/resume-pipeline.yml`) runs:

| Job              | Purpose                                                | Fails CI?              |
| ---------------- | ------------------------------------------------------ | ---------------------- |
| **validate**     | Validate `base-resume.json` against JSON Resume schema | Yes                    |
| **build**        | Tailor + render resumes for all job ads                | Yes                    |
| **score-report** | Print ATS match scores and missing keywords            | **No** (informational) |
| **deploy-pages** | Deploy demo to GitHub Pages (on `main` push)           | No                     |

---

## ATS Score Calculation

The scoring engine (`scoreResume.js`) compares tailored resume content against job ad keywords:

- **Match Score** = `(matched keywords / total job ad keywords) × 100`
- **ATS Parsing** = structural check (name, email, summary, work dates, skills, education)
- **Missing Keywords** = job ad keywords not found in the tailored resume

Example output (`score.json`):
```json
{
  "matchScore": 97,
  "matchedCount": 32,
  "totalKeywords": 33,
  "matchedKeywords": ["React", "TypeScript", "Node.js", "AWS", ...],
  "missingKeywords": ["CloudFormation"],
  "atsParsing": "PASS",
  "atsIssues": []
}
```

---

## Demo / Portfolio

The GitHub Pages demo has two tabs:

### Phase 1: Tailor & Score
- ✅ Resume preview (rendered HTML)
- ✅ PDF download link
- ✅ ATS match score with matched/missing keywords
- ✅ Job ad selector between dummy outputs

### Phase 2: Structure & Theme
- ✅ Uploaded resume structure analysis
- ✅ Section flow visualization (detected section order)
- ✅ Content style indicators (bullets, prose, list, paragraph)
- ✅ Layout hints (experience before education, skills early, has summary)
- ✅ Themed resume preview using the generated theme

> **These are example outputs generated from dummy job ads and sample resumes. For a live demo with your own documents, please contact Peter.**

---

## For Users Who Want to Run Their Own Pipeline

1. **Fork** this repository
2. Copy the example: `cp base-resume-example.json base-resume.json`
3. Fill in `base-resume.json` with your own resume data (see [Setting Up Your Resume](#setting-up-your-resume))
4. Add your job ads to `job_ads/`
5. Run: `node scripts/pipeline.js --all`
6. Check `outputs/` for your tailored resumes and scores

---

## Phase 2: Structure Analysis & Theme Generation

Phase 2 enables uploading an existing resume and reproducing its layout as a JSON Resume theme.

### How it works

1. **Parse** — `parseUploadedResume.js` reads PDF (via `pdf-parse`), DOCX (via `mammoth`), or plain text files. It extracts paragraphs and identifies heading candidates (short lines, ALL CAPS lines, colon-ending lines).

2. **Analyze** — `analyzeStructure.js` maps headings to 13 known section types (contact, summary, experience, education, skills, projects, certificates, awards, publications, languages, interests, references, volunteer) using regex patterns. For each section it detects content style:
   - **bullets** — majority of lines start with bullet characters
   - **list** — short lines without bullets (e.g., skill lists)
   - **prose** — long continuous sentences
   - **paragraph** — mixed content

3. **Theme** — `generateTheme.js` produces a self-contained `index.js` (valid jsonresume-theme module) with section renderers ordered to match the uploaded resume. The generated theme respects the detected layout hints.

4. **Render** — The generated theme is applied to `base-resume.json` (optionally tailored for a job ad) and rendered to HTML + PDF.

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

## Future Roadmap

- [ ] **Font/style detection** — Exact replication of fonts, colors, spacing from uploaded PDFs
- [ ] **Theme marketplace** — Share and reuse generated layout templates
- [ ] **Web UI** — Browser-based upload + preview interface
- [ ] **AI-powered tailoring** — LLM integration for rewriting bullet points

---

## Dependencies

| Package                    | Phase | Purpose                                 |
| -------------------------- | ----- | --------------------------------------- |
| `resume-cli`               | 1     | JSON Resume validation                  |
| `jsonresume-theme-elegant` | 1     | HTML theme rendering                    |
| `puppeteer`                | 1+2   | PDF generation via headless Chrome      |
| `pdf-parse`                | 2     | Extract text from uploaded PDF resumes  |
| `mammoth`                  | 2     | Extract text from uploaded DOCX resumes |

Phase 1 works with zero dependencies (built-in HTML renderer). Phase 2 parsing requires `pdf-parse` and/or `mammoth` depending on input format.

---

## License

MIT
