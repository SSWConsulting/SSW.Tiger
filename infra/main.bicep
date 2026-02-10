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
module kvRoleAssignment 'modules/keyVaultRoleAssignment.bicep' = {
  name: 'provision-keyvault-role-assignment-${suffix}'
  params: {
    keyVaultName: kv.outputs.name
    principalId: id.outputs.principalId
    roleName: 'Key Vault Secrets User'
  }
}

// 4. Storage Account - Required by Function App runtime only
module storage 'modules/storage.bicep' = {
  name: 'provision-storage-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
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
  }
}

// 7. Logic App - Teams notification via meeting chat
module logicApp 'modules/logicApp.bicep' = {
  name: 'provision-logic-app-${suffix}'
  params: {
    project: project
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
    containerAppJobName: containerApp.outputs.jobName
    containerAppJobResourceGroup: resourceGroup().name
    containerAppJobImage: containerImage
    managedIdentityId: id.outputs.id
    managedIdentityClientId: id.outputs.clientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
  }
}

output keyVault object = {
  name: kv.outputs.name
  uri: kv.outputs.keyVaultUrl
}

output storage object = {
  name: storage.outputs.name
  blobEndpoint: storage.outputs.blobEndpoint
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

output logicApp object = {
  name: logicApp.outputs.name
}

output monitoring object = {
  logAnalyticsName: monitoring.outputs.logAnalyticsName
  appInsightsName: monitoring.outputs.appInsightsName
}
