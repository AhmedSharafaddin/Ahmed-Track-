# ITrack — صورة التثبيت. من جذر المستودع:
#   docker build -f itrack/server/Dockerfile -t itrack .
#   docker run -d --name itrack -p 8080:8080 -v itrack-data:/data --restart unless-stopped itrack
FROM node:22-alpine
WORKDIR /app
# الواجهة + الخادم فقط (لا اختبارات ولا مستندات)
COPY styles.css ./
COPY js ./js
COPY fonts ./fonts
COPY icons ./icons
COPY itrack/index.html itrack/styles.css itrack/config.js itrack/sw.js itrack/manifest.webmanifest ./itrack/
COPY itrack/js ./itrack/js
COPY itrack/icons ./itrack/icons
COPY itrack/fonts ./itrack/fonts
COPY itrack/my ./itrack/my
COPY itrack/worker/worker.js ./itrack/worker/
COPY itrack/server/server.mjs itrack/server/d1.mjs ./itrack/server/
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "itrack/server/server.mjs"]
