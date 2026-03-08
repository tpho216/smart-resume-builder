#!/bin/bash
export NVM_DIR="$HOME/.nvm"
export PATH="$NVM_DIR/versions/node/v22.22.0/bin:$PATH"
cd /home/peterho/projects/resume-builder

echo "Node: $(node --version)"
echo ""

# Test Phase 2 with sample_resume.txt (acts as an "uploaded" resume)
echo "=== Phase 2: sample_resume.txt ==="
node scripts/analyzeStructure.js samples/sample_resume.txt --output outputs/phase2_sample_resume/structure_analysis.json

echo ""
echo "=== Generating theme from structure ==="
node scripts/generateTheme.js outputs/phase2_sample_resume/structure_analysis.json \
  --output themes/custom-generated \
  --preview base-resume.json

echo ""
echo "=== Phase 2: sample_resume_devops.txt ==="
node scripts/analyzeStructure.js samples/sample_resume_devops.txt --output outputs/phase2_sample_devops/structure_analysis.json

echo ""
echo "=== Generating theme from devops structure ==="
node scripts/generateTheme.js outputs/phase2_sample_devops/structure_analysis.json \
  --output outputs/phase2_sample_devops/theme \
  --preview base-resume.json
