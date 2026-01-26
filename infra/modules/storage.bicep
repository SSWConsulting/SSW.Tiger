// Storage Account - Required by Azure Function App
// Stores: Function code, logs, trigger state, and transcript files (POC)
//
// Architecture Decision (POC Phase):
// - Using Blob Storage as intermediate layer for transcripts
// - Enables debugging: VTT files persist even if Job fails
// - See plan.md for full rationale (Option A vs Option B)

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

// Blob container for transcript files
param transcriptContainerName string = 'transcripts'
param transcriptRetentionDays int = 7  // Auto-delete after 7 days (POC)

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

// Transcripts container - stores VTT files downloaded from Graph API
resource transcriptsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: transcriptContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Lifecycle policy - auto-delete transcripts after retention period
// POC: 7 days is sufficient for debugging, reduces storage costs
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-old-transcripts'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${transcriptContainerName}/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: transcriptRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

output name string = storageAccount.name
output id string = storageAccount.id
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
output transcriptContainerName string = transcriptsContainer.name
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
