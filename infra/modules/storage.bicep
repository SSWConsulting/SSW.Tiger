// Storage Account - Required by Azure Function App
// Stores: Function code, logs, trigger state


param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object
@description('Principal that uploads and downloads private transcript submissions')
param managedIdentityPrincipalId string

@description('Create the Blob Data Contributor assignment on the transcript container. Requires Owner or User Access Administrator — Contributor cannot write Microsoft.Authorization/roleAssignments, so this is off by default to keep the deployment runnable by a Contributor. Mirrors manageKeyVaultRoleAssignment in main.bicep.')
param manageTranscriptBlobRoleAssignment bool = false

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

// Queue service for Function App messaging
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Queue for transcript notifications from Graph webhook
resource transcriptQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'transcript-notifications'
}

// Private source container for browser-submitted transcripts.
resource transcriptSubmissionsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'transcript-submissions'
  properties: {
    publicAccess: 'None'
  }
}

// The shared user-assigned identity is used by the Function to upload and by
// the Container App Job to download. Scope is limited to this container.
// Gated: see manageTranscriptBlobRoleAssignment above. The assignment is NOT
// optional at runtime — without it the Container App Job cannot download an
// uploaded transcript — it is only opt-in at deploy time so that a Contributor
// (who cannot write role assignments) can still deploy everything else.
resource transcriptBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (manageTranscriptBlobRoleAssignment) {
  name: guid(transcriptSubmissionsContainer.id, managedIdentityPrincipalId, 'transcript-blob-data-contributor')
  scope: transcriptSubmissionsContainer
  properties: {
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

output name string = storageAccount.name
output id string = storageAccount.id
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output transcriptSubmissionsContainerName string = transcriptSubmissionsContainer.name
