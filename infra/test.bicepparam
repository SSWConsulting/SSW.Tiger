using './main.bicep'

param project = 'tiger'
param environment = 'test'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'test'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

//az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file main.bicep --parameters test.bicepparam
