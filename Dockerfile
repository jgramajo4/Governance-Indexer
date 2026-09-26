FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
COPY docker ./docker
ENV NODE_ENV=production
USER node
EXPOSE 8080
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/jgramajo4/Governance-Indexer" org.opencontainers.image.revision="$VCS_REF"
ENV GOVERNANCE_INDEXER_SOURCE_SHA="$VCS_REF"
ENTRYPOINT ["node", "bin/gavel-indexer.js"]
CMD ["serve"]
