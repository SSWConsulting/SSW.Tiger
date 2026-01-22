# Use official Node.js LTS with Claude Code CLI support
FROM node:18-alpine

# Install Claude Code CLI, surge, and dependencies
RUN apk add --no-cache curl bash git && \
    npm install -g @anthropic-ai/claude-cli surge

# Set working directory
WORKDIR /app

# Copy application code
COPY processor.js ./
COPY CLAUDE.md ./
COPY templates/ ./templates/

# Create necessary directories
RUN mkdir -p /app/projects /app/output

# Set environment variables
ENV NODE_ENV=production
ENV OUTPUT_DIR=/app/output

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Default command (will be overridden by docker-compose or command line)
ENTRYPOINT ["node", "processor.js"]
