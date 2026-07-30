using './main.bicep'

param project = 'tiger'
param environment = 'test'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'test'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

// Skip Logic App deployment to preserve Portal configuration
param deployLogicApp = false

// Role assignments need Owner / User Access Administrator; a Contributor deploying
// TEST leaves these to a privileged one-off run. The transcript-blob one must exist
// before the Container App Job can download an uploaded transcript.
param manageKeyVaultRoleAssignment = false
param manageTranscriptBlobRoleAssignment = false

// Same principle for the SWA's Entra app settings: already set by hand, and
// letting Bicep read them from Key Vault would require the deployer to hold
// Key Vault Secrets User on the RBAC-enabled vault.
param manageSwaAuthSettings = false

//az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file main.bicep --parameters test.bicepparam
