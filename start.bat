@echo off
cd /d "%~dp0"
echo Starting Campus Info Hub...
bun run index.ts
pause
