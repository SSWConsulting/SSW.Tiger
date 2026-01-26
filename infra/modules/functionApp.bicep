// Function App - Webhook receiver for Microsoft Graph
// Receives notifications when Teams transcripts are created
// Downloads VTT from Graph API, stores in Blob, triggers Container App Job
//
// Architecture Decision (POC Phase - Option A):
// - Function downloads VTT and stores in Blob Storage
// - Enables debugging: VTT files persist even if Job fails
// - See plan.md for full rationale

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object
param storageAccountName string
param keyVaultName string
param containerAppJobName string
param containerAppJobResourceGroup string
param managedIdentityId string
param managedIdentityClientId string
param transcriptContainerName string = 'transcripts'

var functionAppName = toLower('func-${project}-${environment}')
var hostingPlanName = toLower('plan-${project}-${environment}')

// App Service Plan (Consumption - serverless)
resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  tags: costCategoryTag
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true  // Linux
  }
}

// Reference existing storage account
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Function App
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: costCategoryTag
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    serverFarmId: hostingPlan.id
    publicNetworkAccess: 'Enabled'
    httpsOnly: true
    keyVaultReferenceIdentity: managedIdentityId
    siteConfig: {
      keyVaultReferenceIdentity: managedIdentityId
      linuxFxVersion: 'NODE|20'
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: [
          'https://portal.azure.com'
        ]
      }
      appSettings: [
        // Azure Managed Identity
        { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
        // Storage connection (required for Function runtime)
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower(functionAppName) }
        // Function runtime settings
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        // Key Vault references for Graph API credentials
        {
          name: 'GRAPH_CLIENT_ID'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=graph-client-id)'
        }
        {
          name: 'GRAPH_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=graph-client-secret)'
        }
        {
          name: 'GRAPH_TENANT_ID'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=graph-tenant-id)'
        }
        // Container App Job reference
        { name: 'CONTAINER_APP_JOB_NAME', value: containerAppJobName }
        { name: 'CONTAINER_APP_JOB_RESOURCE_GROUP', value: containerAppJobResourceGroup }
        // Subscription ID (for Container App API calls)
        { name: 'SUBSCRIPTION_ID', value: subscription().subscriptionId }
        // Blob Storage for transcripts (Option A - POC)
        { name: 'STORAGE_ACCOUNT_NAME', value: storageAccountName }
        { name: 'TRANSCRIPT_CONTAINER_NAME', value: transcriptContainerName }
      ]
    }
  }

  resource scm 'basicPublishingCredentialsPolicies@2023-12-01' = {
    name: 'scm'
    properties: {
      allow: true
    }
  }
}

output id string = functionApp.id
output name string = functionApp.name
output endpoint string = 'https://${functionApp.properties.defaultHostName}'
