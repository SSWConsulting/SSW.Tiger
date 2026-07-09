#!/bin/bash
# Post-deployment setup for Cosmos DB
# Run this AFTER bicep deployment to create the containers
# (ARM nested resource path fails for sqlContainers, so we use CLI)
#
# Usage:
#   ./setup-cosmos.sh staging
#   ./setup-cosmos.sh test

set -e

ENV="${1:?Usage: ./setup-cosmos.sh <environment>}"
ACCOUNT_NAME="cosmos-tiger-${ENV}"
RESOURCE_GROUP="SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev"
DATABASE_NAME="tiger"
CONTAINERS=("meetings" "security")

echo "Setting up Cosmos DB containers for ${ENV}..."

for CONTAINER_NAME in "${CONTAINERS[@]}"; do
  # Check if container already exists
  EXISTING=$(MSYS_NO_PATHCONV=1 az cosmosdb sql container show \
    --account-name "$ACCOUNT_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --database-name "$DATABASE_NAME" \
    --name "$CONTAINER_NAME" \
    --query "name" -o tsv 2>/dev/null || echo "")

  if [ -n "$EXISTING" ]; then
    echo "Container '${CONTAINER_NAME}' already exists in '${ACCOUNT_NAME}/${DATABASE_NAME}'. Skipping."
    continue
  fi

  # Create the container
  MSYS_NO_PATHCONV=1 az cosmosdb sql container create \
    --account-name "$ACCOUNT_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --database-name "$DATABASE_NAME" \
    --name "$CONTAINER_NAME" \
    --partition-key-path /projectName \
    -o none

  echo "Container '${CONTAINER_NAME}' created."
done

echo "Done. Cosmos DB containers are ready."
