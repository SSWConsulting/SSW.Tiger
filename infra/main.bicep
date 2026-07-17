// Project T.I.G.E.R. - Main Infrastructure Orchestration
// Transcript Intelligence Group Event Reasoning
//
// Deploys to EXISTING resource group: SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev
// Images pulled from ghcr.io (GitHub Container Registry)

targetScope = 'resourceGroup'

type CostCategoryTag = {
  'cost-category': 'dev/test' | 'value' | 'core'
}

@description('Project name prefix for all resources')
param project string

@description('Environment: dev or prod')
param environment string

@description('Cost category tag for billing')
param costCategoryTag CostCategoryTag

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('GitHub organization/username for container registry')
param githubOrg string

@description('Container image tag')
param imageTag string = 'latest'

@description('Claude model ID for the processor')
param claudeModel string = 'claude-opus-4-5-20251101'

@description('Unique suffix for deployment names')
param suffix string = take(uniqueString(utcNow()), 6)

@description('Skip Logic App deployment to preserve Portal configuration')
param deployLogicApp bool = false

@description('Manage the Key Vault Secrets User assignment. Requires Owner or User Access Administrator.')
param manageKeyVaultRoleAssignment bool = false

@description('Deploy the Parrot portal stack (Portal API Function App + Static Web App). Off by default until the portal is ready to go live.')
param deployPortal bool = false

@description('Region for the Static Web App. SWA is region-limited (australiaeast is NOT supported); defaults to East Asia.')
param staticWebAppLocation string = 'eastasia'


var containerImage = 'ghcr.io/${githubOrg}/tiger-processor:${imageTag}'

// 1. Managed Identity - Used by all services for RBAC
module id 'modules/managedIdentity.bicep' = {
  name: 'provision-managed-identity-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 2. Key Vault - Secure storage for all secrets
module kv 'modules/keyVault.bicep' = {
  name: 'provision-keyvault-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 3. Key Vault Role Assignment - Grant managed identity access to secrets
module kvRoleAssignment 'modules/keyVaultRoleAssignment.bicep' = if (manageKeyVaultRoleAssignment) {
  name: 'provision-keyvault-role-assignment-${suffix}'
  params: {
    keyVaultName: kv.outputs.name
    principalId: id.outputs.principalId
    roleName: 'Key Vault Secrets User'
  }
}

// 4a. Storage Account - Required by Function App runtime only
module storage 'modules/storage.bicep' = {
  name: 'provision-storage-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
    managedIdentityPrincipalId: id.outputs.principalId
  }
}

// 4b. Dashboard Storage - Static website hosting for meeting dashboards
module dashboardStorage 'modules/dashboardStorage.bicep' = {
  name: 'provision-dashboard-storage-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 4c. Cosmos DB - Meeting metadata and consolidated analysis
module cosmosDb 'modules/cosmosDb.bicep' = {
  name: 'provision-cosmos-db-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
    managedIdentityPrincipalId: id.outputs.principalId
  }
}

// 5. Monitoring - Log Analytics + Application Insights
module monitoring 'modules/monitoring.bicep' = {
  name: 'provision-monitoring-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 6. Container App Environment + Job - Runs the Claude processor
module containerApp 'modules/containerApp.bicep' = {
  name: 'provision-container-app-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
    keyVaultName: kv.outputs.name
    containerImage: containerImage
    ghcrUsername: githubOrg
    managedIdentityId: id.outputs.id
    managedIdentityClientId: id.outputs.clientId
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    logAnalyticsPrimaryKey: monitoring.outputs.logAnalyticsPrimaryKey
    claudeModel: claudeModel
    dashboardStorageAccountName: dashboardStorage.outputs.name
    cosmosEndpoint: cosmosDb.outputs.endpoint
    transcriptStorageAccountName: storage.outputs.name
    transcriptStorageContainerName: storage.outputs.transcriptSubmissionsContainerName
  }
}

// 7. Logic App - Teams notification via meeting chat
// Conditional: skip to preserve Portal-configured workflow definition
module logicApp 'modules/logicApp.bicep' = if (deployLogicApp) {
  name: 'provision-logic-app-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 8. Function App - Webhook receiver, triggers Container App Job
module functionApp 'modules/functionApp.bicep' = {
  name: 'provision-function-app-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
    storageAccountName: storage.outputs.name
    keyVaultName: kv.outputs.name
    keyVaultUrl: kv.outputs.keyVaultUrl
    containerAppJobName: containerApp.outputs.jobName
    containerAppJobResourceGroup: resourceGroup().name
    containerAppJobImage: containerImage
    managedIdentityId: id.outputs.id
    managedIdentityClientId: id.outputs.clientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    dashboardStorageAccountName: dashboardStorage.outputs.name
    cosmosEndpoint: cosmosDb.outputs.endpoint
    claudeModel: claudeModel
    transcriptStorageContainerName: storage.outputs.transcriptSubmissionsContainerName
  }
}

// 9. Portal API Function App - browser transcript uploads, fronted by SWA.
//    Separate app so its SWA-only auth boundary never affects the Graph webhook.
module portalApiApp 'modules/portalApiApp.bicep' = if (deployPortal) {
  name: 'provision-portal-api-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
    storageAccountName: storage.outputs.name
    managedIdentityId: id.outputs.id
    managedIdentityClientId: id.outputs.clientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    transcriptStorageContainerName: storage.outputs.transcriptSubmissionsContainerName
    cosmosEndpoint: cosmosDb.outputs.endpoint
    submissionsContainerName: cosmosDb.outputs.submissionsContainerName
  }
}

// 10. Static Web App - hosts the Parrot SPA, links the Portal API as /api, and
//     provisions the "Azure Static Web Apps (Linked)" EasyAuth boundary on it.
//     Login reuses the existing Graph app registration (clientId + secret from KV).
//     POST-DEPLOY: (1) verify the backend now has the "Azure Static Web Apps (Linked)"
//     identity provider under Authentication; (2) register the output redirect URI
//     on the Graph app registration.
resource keyVaultRef 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: kv.outputs.name
}

module staticWebApp 'modules/staticWebApp.bicep' = if (deployPortal) {
  name: 'provision-swa-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: staticWebAppLocation
    backendResourceId: portalApiApp.outputs.id
    backendRegion: location
    entraClientId: keyVaultRef.getSecret('graph-client-id')
    entraClientSecret: keyVaultRef.getSecret('graph-client-secret')
  }
}

output keyVault object = {
  name: kv.outputs.name
  uri: kv.outputs.keyVaultUrl
}

output portalApiName string = deployPortal ? portalApiApp.outputs.name : ''
output portalSwaUrl string = deployPortal ? staticWebApp.outputs.url : ''
// Register this on the existing Graph app registration once the SWA exists.
output portalEntraRedirectUri string = deployPortal ? staticWebApp.outputs.redirectUri : ''

output storage object = {
  name: storage.outputs.name
  blobEndpoint: storage.outputs.blobEndpoint
}

output dashboardStorage object = {
  name: dashboardStorage.outputs.name
  staticWebsiteHost: dashboardStorage.outputs.staticWebsiteHost
}

output containerApp object = {
  environmentName: containerApp.outputs.environmentName
  jobName: containerApp.outputs.jobName
}

output functionApp object = {
  name: functionApp.outputs.name
  url: functionApp.outputs.endpoint
}

output managedIdentity object = {
  id: id.outputs.id
  principalId: id.outputs.principalId
  clientId: id.outputs.clientId
  name: id.outputs.name
}


output cosmosDb object = {
  endpoint: cosmosDb.outputs.endpoint
  accountName: cosmosDb.outputs.accountName
  databaseName: cosmosDb.outputs.databaseName
  containerName: cosmosDb.outputs.containerName
  projectPoliciesContainerName: cosmosDb.outputs.projectPoliciesContainerName
  meetingSecurityContainerName: cosmosDb.outputs.meetingSecurityContainerName
}

output monitoring object = {
  logAnalyticsName: monitoring.outputs.logAnalyticsName
  appInsightsName: monitoring.outputs.appInsightsName
}
