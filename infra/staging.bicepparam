using './main.bicep'

param project = 'tiger'
param environment = 'staging'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'SSWConsulting'
param imageTag = 'latest'

// Note: location defaults to resource group's location
// Deploy with: az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file main.bicep --parameters main.bicepparam
