@echo off
rem تشغيل ITrack على ويندوز. يحتاج Node.js 22 LTS أو أحدث من nodejs.org
rem للتشغيل الدائم كخدمة ويندوز: راجع itrack\server\INSTALL.md (NSSM).
cd /d "%~dp0\..\.."
node itrack\server\server.mjs
pause
