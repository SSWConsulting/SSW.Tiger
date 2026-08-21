// Function App - Webhook receiver for Microsoft Graph
// Receives notifications when Teams transcripts are created
// Triggers Container App Job with meeting ID and transcript ID

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object
param storageAccountName string
param keyVaultName string
param keyVaultUrl string
param containerAppJobName string
param containerAppJobResourceGroup string
param containerAppJobImage string
param managedIdentityId string
param managedIdentityClientId string
param dashboardStorageAccountName string
@description('Private container used for uploaded transcript sources')
param transcriptStorageContainerName string

// Application Insights for logging
param appInsightsConnectionString string

@description('Cosmos DB endpoint (passed through to Container App Job)')
param cosmosEndpoint string = ''

@description('Claude model ID (passed through to Container App Job)')
param claudeModel string = 'claude-opus-4-5-20251101'


var functionAppName = toLower('func-${project}-${environment}')
var hostingPlanName = toLower('plan-${project}-${environment}')
var dashboardBaseUrl = environment == 'staging' ? 'dashboards.sswtiger.com' : 'dashboards-${environment}.sswtiger.com'

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
      // Node 20 went out of support on 30/04/2026, and the Azure SDKs this app pulls
      // in (@azure/core-rest-pipeline, @typespec/ts-http-runtime) now declare
      // engines.node >=22. Node 22 is GA on Linux Functions and is the last version
      // Linux Consumption will support. Requires the v4 programming model, which this
      // app already uses. Keep in step with WEBSITE_NODE_DEFAULT_VERSION below,
      // package.json engines, and portalApiApp.bicep.
      linuxFxVersion: 'NODE|22'
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      cors: {
        allowedOrigins: [
          'https://portal.azure.com'
        ]
      }
      appSettings: [
        // Application Insights for logging
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
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
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        // Reject oversized HTTP bodies before multipart parsing allocates memory.
        { name: 'FUNCTIONS_REQUEST_BODY_SIZE_LIMIT', value: '12582912' }
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
        { name: 'CONTAINER_APP_JOB_IMAGE', value: containerAppJobImage }
        { name: 'DASHBOARD_STORAGE_ACCOUNT', value: dashboardStorageAccountName }
        { name: 'DASHBOARD_BASE_URL', value: dashboardBaseUrl }
        { name: 'TRANSCRIPT_STORAGE_ACCOUNT', value: storageAccountName }
        { name: 'TRANSCRIPT_STORAGE_CONTAINER', value: transcriptStorageContainerName }
        // Passed through to Container App Job at start time
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'COSMOS_PROJECT_POLICIES_CONTAINER', value: 'projectPolicies' }
        { name: 'COSMOS_MEETING_SECURITY_CONTAINER', value: 'meetingSecurity' }
        { name: 'CLAUDE_MODEL', value: claudeModel }
        // Subscription ID (for Container App API calls)
        { name: 'SUBSCRIPTION_ID', value: subscription().subscriptionId }
        // Graph Subscription ID (stored in Key Vault after creation via script)
        {
          name: 'GRAPH_SUBSCRIPTION_ID'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=graph-subscription-id)'
        }
        // Logic App URL (stored in Key Vault after Portal configuration)
        {
          name: 'LOGIC_APP_URL'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=logic-app-url)'
        }
        {
          name: 'WEBHOOK_CLIENT_STATE'
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=webhook-client-state)'
        }
        { name: 'KEY_VAULT_URL', value: keyVaultUrl }
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

// Shared with the Portal API app: creating a NEW Y1 Linux plan in this RG failed
// ("Dynamic SKU, Linux Worker not available in resource group") — the Linux
// webspace this RG maps to in Australia East won't place another one — so the
// Portal API rides this existing plan instead. Existing Y1 apps keep running and
// Y1 scales per-app, so the apps stay independent. (Flex Consumption is the
// modern alternative if a genuinely separate plan is ever needed.)
output hostingPlanId string = hostingPlan.id
