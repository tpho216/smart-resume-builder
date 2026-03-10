/**
 * app.js — GitHub Pages demo UI controller.
 * Loads demo-manifest.json (Phase 1) and phase2-manifest.json and wires up
 * both interactive tabs.
 */

(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    let manifest = [];
    let phase2Manifest = [];
    let currentJob = null;
    let currentSample = null;

    // ── Bootstrap ──────────────────────────────────────────────
    async function init() {
        // Phase 1 data
        try {
            const res = await fetch('demo-manifest.json');
            manifest = await res.json();
        } catch (e) {
            $('#job-selector').innerHTML = '<p style="color:red;">Failed to load Phase 1 demo data.</p>';
        }

        // Phase 2 data
        try {
            const res = await fetch('phase2-manifest.json');
            phase2Manifest = await res.json();
        } catch (e) {
            $('#p2-selector').innerHTML = '<p style="color:var(--muted);">No Phase 2 demo data.</p>';
        }

        // Phase 1
        renderSelector();
        if (manifest.length > 0) selectJob(manifest[0].jobName);

        // Phase 2
        renderPhase2Selector();
        if (phase2Manifest.length > 0) selectSample(phase2Manifest[0].sampleName);

        // Tab switching
        $$('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
    }

    // ── Tabs ───────────────────────────────────────────────────
    function switchTab(tabId) {
        $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
        $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabId}`));
    }

    // ══════════════════════════════════════════════════════════
    //  PHASE 1
    // ══════════════════════════════════════════════════════════

    function renderSelector() {
        const container = $('#job-selector');
        container.innerHTML = '';
        manifest.forEach((entry) => {
            const btn = document.createElement('button');
            btn.className = 'job-btn';
            btn.dataset.job = entry.jobName;
            btn.textContent = formatName(entry.jobName);
            btn.addEventListener('click', () => selectJob(entry.jobName));
            container.appendChild(btn);
        });
    }

    function selectJob(jobName) {
        currentJob = manifest.find((e) => e.jobName === jobName);
        if (!currentJob) return;
        $$('#job-selector .job-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.job === jobName);
        });
        updatePreview();
        updateScore();
        updateActions();
    }

    function updatePreview() {
        const frame = $('#resume-frame');
        frame.src = `${currentJob.outputDir}_resume.html`;
        $('#preview-header').textContent = `Resume Preview — ${formatName(currentJob.jobName)}`;
    }

    function updateScore() {
        const score = currentJob.matchScore;
        const display = $('#score-display');
        let cls = 'score-good';
        if (score < 70) cls = 'score-low';
        else if (score < 85) cls = 'score-ok';
        display.className = `score-big ${cls}`;
        display.querySelector('.number').textContent = `${score}%`;

        const badge = $('#ats-badge');
        badge.textContent = currentJob.atsParsing;
        badge.className = `badge badge-${currentJob.atsParsing === 'PASS' ? 'pass' : 'fail'}`;

        renderKeywords('#matched-section', '#matched-keywords', currentJob.matchedKeywords, 'kw-matched');
        renderKeywords('#missing-section', '#missing-keywords', currentJob.missingKeywords, 'kw-missing');
    }

    function renderKeywords(sectionSel, listSel, keywords, cls) {
        const section = $(sectionSel);
        const list = $(listSel);
        if (keywords && keywords.length > 0) {
            section.style.display = '';
            list.innerHTML = keywords.map((kw) => `<span class="kw-tag ${cls}">${esc(kw)}</span>`).join('');
        } else {
            section.style.display = 'none';
        }
    }

    function updateActions() {
        const dir = currentJob.outputDir;
        const name = currentJob.safeName;
        $('#pdf-link').href = `../outputs/${dir}/Resume_${name}.pdf`;
        $('#pdf-link').download = `Resume_${name}.pdf`;
        $('#html-link').href = `${dir}_resume.html`;
        $('#json-link').href = `${dir}_score.json`;
    }

    // ══════════════════════════════════════════════════════════
    //  PHASE 2
    // ══════════════════════════════════════════════════════════

    function renderPhase2Selector() {
        const container = $('#p2-selector');
        container.innerHTML = '';
        phase2Manifest.forEach((entry) => {
            const btn = document.createElement('button');
            btn.className = 'job-btn';
            btn.dataset.sample = entry.sampleName;
            btn.textContent = formatName(entry.sampleName);
            btn.addEventListener('click', () => selectSample(entry.sampleName));
            container.appendChild(btn);
        });
    }

    function selectSample(sampleName) {
        currentSample = phase2Manifest.find((e) => e.sampleName === sampleName);
        if (!currentSample) return;
        $$('#p2-selector .job-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.sample === sampleName);
        });
        updatePhase2Preview();
        updatePhase2Structure();
        updatePhase2Actions();
    }

    function updatePhase2Preview() {
        const frame = $('#p2-frame');
        frame.src = `phase2_${currentSample.sampleName}_preview.html`;
        $('#p2-preview-header').textContent = `Themed Preview — Structure from: ${currentSample.nameCandidate || formatName(currentSample.sampleName)}`;
    }

    function updatePhase2Structure() {
        $('#p2-name').textContent = currentSample.nameCandidate || 'N/A';

        const flowEl = $('#p2-sections');
        const sections = currentSample.sectionOrder || [];
        flowEl.innerHTML = sections
            .map((s, i) => {
                const tag = `<span class="section-tag">${esc(s)}</span>`;
                const arrow = i < sections.length - 1 ? '<span class="arrow">→</span>' : '';
                return tag + arrow;
            })
            .join('');

        const hints = currentSample.layoutHints || {};
        const hintsEl = $('#p2-hints');
        hintsEl.innerHTML = `
      <div>${icon(hints.hasSummarySection)} Summary section</div>
      <div>${icon(hints.experienceBeforeEducation)} Experience before Education</div>
      <div>${icon(hints.skillsEarly)} Skills in top sections</div>
      <div>${icon(hints.hasContactSection)} Explicit contact section</div>
      <div>Total sections detected: <strong>${hints.detectedSections || 0}</strong></div>
      ${hints.unknownSections > 0 ? `<div style="color:var(--warning);">Unknown sections: ${hints.unknownSections}</div>` : ''}
    `;
    }

    function updatePhase2Actions() {
        $('#p2-html-link').href = `phase2_${currentSample.sampleName}_preview.html`;
        $('#p2-structure-link').href = `phase2_${currentSample.sampleName}_structure.json`;
    }

    // ── Utils ──────────────────────────────────────────────────

    function formatName(name) {
        return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function esc(s) {
        const el = document.createElement('span');
        el.textContent = s;
        return el.innerHTML;
    }

    function icon(val) {
        return val ? '<span class="check">✓</span>' : '<span class="cross">✗</span>';
    }
}

  // ── Utils ──────────────────────────────────────────────────
  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
}

// ── Start ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
}) ();
