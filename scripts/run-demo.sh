#!/bin/bash
export NVM_DIR="$HOME/.nvm"
export PATH="$NVM_DIR/versions/node/v22.22.0/bin:$PATH"
cd /home/peterho/projects/resume-builder
node scripts/generateDemo.js
