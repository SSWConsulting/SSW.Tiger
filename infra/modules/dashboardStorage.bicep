// Dashboard Storage - Azure Blob Storage with static website for hosting dashboards
// Separate from the Function App storage account
// Static website must be enabled post-deployment via:
//   az storage blob service-properties update --account-name <name> --static-website --index-document index.html

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object
param managedIdentityPrincipalId string

// Storage account names: 3-24 chars, lowercase alphanumeric only
var baseName = toLower(replace('sa${project}${environment}web', '-', ''))
var name = length(baseName) > 24 ? substring(baseName, 0, 24) : baseName

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: costCategoryTag
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: true // Required for static website public access
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Grant managed identity "Storage Blob Data Contributor" to upload dashboards
resource blobContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentityPrincipalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output name string = storageAccount.name
output staticWebsiteHost string = replace(replace(storageAccount.properties.primaryEndpoints.web, 'https://', ''), '/', '')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
