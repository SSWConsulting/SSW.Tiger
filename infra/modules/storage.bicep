// Storage Account - Required by Azure Function App
// Stores: Function code, logs, trigger state


param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

// Storage account names must be 3-24 chars, lowercase alphanumeric only
var baseName = toLower(replace(replace('sa${project}${environment}', '-', ''), '_', ''))
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
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

output name string = storageAccount.name
output id string = storageAccount.id
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
