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

// 4. Storage Account - Required by Function App
module storage 'modules/storage.bicep' = {
  name: 'provision-storage-${suffix}'
  params: {
    project: project
    environment: environment
    costCategoryTag: costCategoryTag
    location: location
  }
}

// 5. Container App Environment + Job - Runs the Claude processor
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
  }
}

// 6. Function App - Webhook receiver, triggers Container App Job
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
    managedIdentityId: id.outputs.id
    managedIdentityClientId: id.outputs.clientId
  }
}

output keyVault object = {
  name: kv.outputs.name
  uri: kv.outputs.keyVaultUrl
}

output storage object = {
  name: storage.outputs.name
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
