using './main.bicep'

param project = 'tiger'
param environment = 'test'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'test'

// Test reports are written to the private container and served via the Portal.
// Before applying, deploy and verify the Portal resources and Function code that forwards DASHBOARD_CONTAINER.
// Verify that the configured processor image supports private report publishing.
param dashboardBaseUrl = 'portal-test.sswtiger.com'
param dashboardContainer = 'reports'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

// Skip Logic App deployment to preserve Portal configuration
param deployLogicApp = false
param manageKeyVaultRoleAssignment = false

// From the repository root: az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file infra/main.bicep --parameters infra/test.bicepparam
