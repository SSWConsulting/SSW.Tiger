// Storage Account - Required by Azure Function App
// Stores: Function code, logs, trigger state

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

// Storage account names must be 3-24 chars, lowercase alphanumeric only
var baseName = replace(replace('sa${project}${environment}', '-', ''), '_', '')
var name = length(baseName) > 24 ? substring(baseName, 0, 24) : baseName

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: costCategoryTag
  kind: 'StorageV2'
  sku: {
    name: environment == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

output name string = storageAccount.name
output id string = storageAccount.id
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
