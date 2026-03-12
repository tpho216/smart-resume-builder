# Smart Resume Builder

LLM-powered resume tailoring pipeline. One task file → tailored HTML, PDF, and DOCX outputs scored against the job ad.

## Setup

```bash
npm install
cp .env.example .env   # add GITHUB_TOKEN (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
```

## Run

```bash
npm run task -- inputs/tasks/my_task.json
# or shorthand:
npm run task:1
npm run task:2
```

Outputs land in the directory set by `outputDir` in the task file, named:

```
PeterHo_Resume.html/pdf/docx            ← default elegant theme
PeterHo_Resume_elegant.html/pdf/docx    ← named theme
PeterHo_Resume_resume_template_2.docx   ← DOCX template render
```

---

## Task file

Create `inputs/tasks/my_task.json`:

```jsonc
{
  "description": "Senior Fullstack Engineer",

  "baseResume":  "base-resume.json",
  "jobAd":       "inputs/job_ads/revel_street.txt",
  "outputDir":   "outputs/my_job",
  "mode":        "llm",

  // Optional — pick one:
  "theme":        "elegant",                                    // named JSON Resume theme
  "templateDocx": "inputs/job_templates/resume_template_2.docx", // LLM-analysed DOCX template

  "llm": {
    "provider": "github-copilot"   // key from config/llm_providers.json

    // Optional per-task overrides:
    // "model":       "gpt-4.1",
    // "temperature": 0.2,
    // "promptFile":  "config/llm-prompt.md"
  }
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `baseResume` | yes | Path to your master JSON Resume (relative to project root) |
| `jobAd` | yes | Path to the job ad `.txt` file |
| `outputDir` | yes | Output directory (created if missing) |
| `mode` | yes | `"llm"` (LLM tailoring) or `"programmatic"` (keyword matching) |
| `theme` | no | Named [JSON Resume theme](https://jsonresume.org/themes/) — e.g. `"elegant"`, `"even"` |
| `templateDocx` | no | Path to a `.docx` template — pipeline analyses its layout and renders into it |
| `llm.provider` | if mode=llm | Provider key defined in `config/llm_providers.json` |

> `theme` and `templateDocx` are both optional; if neither is set the default elegant theme is used for HTML/PDF, and no template DOCX is produced.

---

## Job ads

Drop `.txt` files in `inputs/job_ads/` and reference them in the task:

```jsonc
"jobAd": "inputs/job_ads/my_company.txt"
```

Pass multiple job ads:

```jsonc
"jobAd": ["inputs/job_ads/job_a.txt", "inputs/job_ads/job_b.txt"]
```

Process every file in `inputs/job_ads/`:

```jsonc
"jobAd": "all"
```

---

## DOCX templates

Drop `.docx` files in `inputs/job_templates/` and reference one in the task:

```jsonc
"templateDocx": "inputs/job_templates/resume_template_2.docx"
```

The pipeline uses the LLM to analyse the template's layout (header columns, section order, font sizes) and renders your tailored resume into it. The analysis is cached in `outputs/llm_docx_analysis/` — delete the cache file to force a re-analysis.

---

## LLM providers

Provider definitions live in `config/llm_providers.json` — edit once, reference by name in any task.

```jsonc
// config/llm_providers.json
{
  "defaultProvider": "github-copilot",
  "promptFile": "config/llm-prompt.md",
  "providers": {
    "github-copilot": {
      "model": "gpt-4o",
      "apiKeyEnv": "GITHUB_TOKEN",
      "baseUrl": "https://models.inference.ai.azure.com",
      "maxTokens": 4096,
      "temperature": 0.3
    },
    "openai": { ... },
    "anthropic": { ... }
  }
}
```

To switch providers for one task, change `llm.provider`. To override a single field (e.g. try a newer model) without touching the global config:

```jsonc
"llm": {
  "provider": "openai",
  "model": "gpt-4.1"
}
```

---

## CLI overrides

```bash
# Override provider or model without editing the task file
npm run task -- inputs/tasks/task_1.json --provider anthropic --model claude-opus-4-5
```

---

## Outputs

| File | Description |
|---|---|
| `PeterHo_Resume.html` | Rendered HTML (default theme) |
| `PeterHo_Resume.pdf` | PDF (requires Puppeteer) |
| `PeterHo_Resume.docx` | DOCX (default elegant layout) |
| `PeterHo_Resume_<template>.docx` | DOCX rendered into the specified `.docx` template |
| `tailored_resume.json` | Raw tailored JSON Resume |
| `score.json` | ATS match score and missing keywords |

