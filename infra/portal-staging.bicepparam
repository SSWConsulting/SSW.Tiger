// Coordinated Portal cutover. See portal/README.md before deployment.
using './main.bicep'

param project = 'tiger'
param environment = 'staging'

// New meetings publish to the Portal; historical migration and legacy-domain redirects run separately.
// Before applying, deploy and verify the Portal resources and Function code that forwards DASHBOARD_CONTAINER.
// Verify that the configured processor image supports private report publishing.
param dashboardBaseUrl = 'portal.sswtiger.com'
param dashboardContainer = 'reports'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'latest'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

// Transcript hub - raw .vtt archive for opted-in projects
param transcriptHubRepo = 'SSWConsulting/SSW.Tiger-Transcripts'
param transcriptHubAppId = '4645246'
param transcriptHubAppInstallationId = '154848166'

// Skip Logic App deployment to preserve Portal configuration
param deployLogicApp = false

// From the repository root: az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file infra/main.bicep --parameters infra/portal-staging.bicepparam
