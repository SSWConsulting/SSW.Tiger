// Key Vault - Secure storage for all secrets
// Stores: API keys, tokens, Graph API credentials

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

var name = toLower('kv-${project}-${environment}')
var validatedName = length(name) > 24 ? substring(name, 0, 24) : name

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: validatedName
  location: location
  tags: costCategoryTag
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    softDeleteRetentionInDays: environment == 'prod' ? 90 : 7
    enabledForTemplateDeployment: true
    enableRbacAuthorization: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output name string = keyVault.name
output keyVaultUrl string = keyVault.properties.vaultUri
output id string = keyVault.id
