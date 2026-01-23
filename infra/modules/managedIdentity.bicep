// Managed Identity - User-assigned identity for all Tiger services
// Used for RBAC access to Key Vault, Container Registry, etc.

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

var name = toLower('id-${project}-${environment}')

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: costCategoryTag
}

output name string = managedIdentity.name
output id string = managedIdentity.id
output principalId string = managedIdentity.properties.principalId
output clientId string = managedIdentity.properties.clientId
