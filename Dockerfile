# Use official Node.js LTS with Claude Code CLI support
FROM node:18-slim

# Install dependencies (including ca-certificates for Claude SSL/TLS)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    bash \
    git \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install surge CLI with pinned version for reproducibility
RUN npm install -g surge@0.23.1

# Install Claude Code CLI as root
# The install script may put it in ~/.local/bin or similar
RUN curl -fsSL https://claude.ai/install.sh | bash

# Find Claude binary and copy (not symlink) to /usr/local/bin for all users
# Copy instead of symlink so nodejs user can access it
RUN if [ -f /root/.local/bin/claude ]; then \
        cp /root/.local/bin/claude /usr/local/bin/claude; \
    elif [ -f /root/.claude/claude ]; then \
        cp /root/.claude/claude /usr/local/bin/claude; \
    fi && \
    chmod +x /usr/local/bin/claude && \
    which claude && claude --version

# Set working directory
WORKDIR /app

# Copy application code
COPY processor.js ./
COPY CLAUDE.md ./
COPY templates/ ./templates/
COPY entrypoint.sh ./

# Create necessary directories
RUN mkdir -p /app/projects /app/output

# Run as non-root user for security
RUN useradd -m nodejs && chown -R nodejs:nodejs /app

# Make scripts executable
RUN chmod +x /app/entrypoint.sh

# Switch to nodejs user
USER nodejs

# Set environment variables
ENV NODE_ENV=production
ENV OUTPUT_DIR=/app/output
ENV PATH="/usr/local/bin:${PATH}"

# Verify nodejs user can access claude
RUN which claude && claude --version

HEALTHCHECK CMD which claude && node -v || exit 1

# Default command (will be overridden by docker-compose or command line)
ENTRYPOINT ["/app/entrypoint.sh"]
CMD []
