using './main.bicep'

param project = 'tiger'
param environment = 'staging'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'latest'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

// Deploy with: az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file main.bicep --parameters main.bicepparam
