using './main.bicep'

param project = 'tiger'
param environment = 'staging'
param costCategoryTag = { 'cost-category': 'dev/test' }

// GitHub Container Registry settings
param githubOrg = 'sswconsulting'
param imageTag = 'latest'

// Claude model for the processor
param claudeModel = 'claude-opus-4-5-20251101'

// Skip Logic App deployment to preserve Portal configuration
param deployLogicApp = false

// Parrot portal: Portal API Function App + Static Web App + the transcript-submissions
// blob container and the Cosmos submissions container.
//
// NOTE: swa-tiger-portal-staging was created by hand BEFORE Bicep ever ran, so its
// default hostname could be registered as an Entra callback in one pass with the
// sysadmin. Same name / region / SKU means this ADOPTS it in place rather than
// creating anything. Never delete and recreate that SWA — a new hostname
// invalidates every callback URI that was registered against it.
param deployPortal = true

// The three "don't touch what the sysadmin configured" flags. All three are also
// the module defaults; they are written out so the intent is stated rather than
// merely implied by silence.
//
// The role assignments were granted MANUALLY (the RG-level Owner / User Access
// Administrator needed to write Microsoft.Authorization/roleAssignments is not
// something we hold). Setting these true would fail outright, or collide with the
// existing manual grants — and with them false Bicep emits no role-assignment
// resource at all, so a plain Contributor can run this deployment.
param manageKeyVaultRoleAssignment = false
param manageTranscriptBlobRoleAssignment = false

// The SWA's Entra app settings are likewise already set by hand. Leaving this false
// keeps getSecret() out of the deployment, which is what stops the DEPLOYING
// principal from needing Key Vault Secrets User on the RBAC-enabled vault. It also
// avoids re-writing that config resource, which is a full replace rather than a merge.
param manageSwaAuthSettings = false

// Deploy with: az deployment group create --resource-group "SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev" --template-file main.bicep --parameters staging.bicepparam
// Dry run first:  az deployment group what-if  (same arguments)
// After deploying: ./scripts/verify-portal-auth-boundary.sh staging
