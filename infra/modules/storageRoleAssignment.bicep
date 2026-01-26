// Storage Role Assignment - Assigns RBAC roles for Blob Storage access
// Used by Container App Job to read transcript files

param storageAccountName string
param principalId string

@allowed([
  'Storage Blob Data Contributor'
  'Storage Blob Data Reader'
  'Storage Blob Data Owner'
])
param roleName string

@allowed(['Device', 'ForeignGroup', 'Group', 'ServicePrincipal', 'User'])
param principalType string = 'ServicePrincipal'

// Built-in Roles - Storage
// https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#storage
var roleIdMapping = {
  'Storage Blob Data Contributor': 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  'Storage Blob Data Reader': '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
  'Storage Blob Data Owner': 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, principalId, roleIdMapping[roleName])
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIdMapping[roleName])
    principalId: principalId
    principalType: principalType
  }
}

output id string = roleAssignment.id
