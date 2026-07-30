// Portal API Function App — browser transcript submissions, fronted by Static
// Web Apps. Deliberately SEPARATE from the Graph webhook Function App so its
// SWA-only auth boundary (the auto-provisioned "Azure Static Web Apps (Linked)"
// EasyAuth provider) never touches the public Graph webhook.
//
// Security model: functions are authLevel:"anonymous". A linked backend does
// NOT inject a function key; the trust boundary is the EasyAuth provider created
// by the staticSites/linkedBackends link, which rejects any request not proxied
// through the linked SWA. Do NOT add IP restrictions / private endpoints here —
// they are unsupported on a linked backend and break the link.

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

@description('Existing storage account — shared with the Graph app so the transcript-notifications queue connects producer (this app) to consumer (Graph app).')
param storageAccountName string

@description('Shared user-assigned managed identity (writes blob + queue via DefaultAzureCredential).')
param managedIdentityId string
param managedIdentityClientId string

param appInsightsConnectionString string

@description('Private container that holds browser-uploaded transcript sources.')
param transcriptStorageContainerName string

@description('Cosmos DB endpoint (for the submissions history list).')
param cosmosEndpoint string = ''

@description('Cosmos container holding per-user submission records.')
param submissionsContainerName string = 'submissions'

@description('Resource id of the Graph app\'s existing Consumption plan. The Portal API rides it because creating a new Y1 Linux plan in this RG fails ("Dynamic SKU, Linux Worker not available") — the Linux webspace this RG maps to in Australia East won\'t place another. Y1 scales per-app, so isolation is preserved.')
param hostingPlanId string

var functionAppName = toLower('func-${project}-portal-${environment}')

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

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
    serverFarmId: hostingPlanId
    publicNetworkAccess: 'Enabled' // Must stay public; SWA reaches it over the public path, EasyAuth is the boundary.
    httpsOnly: true
    keyVaultReferenceIdentity: managedIdentityId
    siteConfig: {
      keyVaultReferenceIdentity: managedIdentityId
      linuxFxVersion: 'NODE|20'
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        // NOTE: no WEBSITE_CONTENTSHARE / WEBSITE_CONTENTAZUREFILECONNECTIONSTRING.
        // Those are Windows Consumption + Premium settings; a LINUX Consumption app
        // runs its code from the deployment package (scm-releases/scm-latest-<app>.zip),
        // not from an Azure Files content share. Setting them here only created an
        // empty file share and injected a storage ACCOUNT KEY that nothing read.
        // Likewise do NOT add WEBSITE_RUN_FROM_PACKAGE: the value `1` is Windows-only,
        // and the Linux form is a blob SAS URL that the deployment tooling owns.
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        // Reject oversized HTTP bodies before multipart parsing allocates memory.
        { name: 'FUNCTIONS_REQUEST_BODY_SIZE_LIMIT', value: '12582912' }
        { name: 'TRANSCRIPT_STORAGE_ACCOUNT', value: storageAccountName }
        { name: 'TRANSCRIPT_STORAGE_CONTAINER', value: transcriptStorageContainerName }
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'COSMOS_SUBMISSIONS_CONTAINER', value: submissionsContainerName }
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
