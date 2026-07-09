// Admin Function App - authenticated console/API for Tiger dashboard security

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object
param storageAccountName string
param managedIdentityId string
param managedIdentityClientId string
param appInsightsConnectionString string
param cosmosEndpoint string
param dashboardStorageAccountName string
param keyVaultName string
param keyVaultUrl string

@description('Comma-separated seed Tiger Admin email allowlist')
param tigerAdminEmails string = ''

@description('Microsoft Entra tenant ID allowed to sign into the admin app')
param adminAuthAllowedTenantId string = ''

@description('Microsoft Entra app registration client ID for Easy Auth')
param adminAuthClientId string = ''

@description('Key Vault secret name containing the Microsoft provider client secret')
param adminAuthClientSecretName string = 'tiger-admin-auth-client-secret'

var functionAppName = toLower('func-${project}-admin-${environment}')
var hostingPlanName = toLower('plan-${project}-admin-${environment}')
var authSecretSettingName = 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
var authEnabled = !empty(adminAuthClientId) && !empty(adminAuthAllowedTenantId)

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  tags: costCategoryTag
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

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
    serverFarmId: hostingPlan.id
    publicNetworkAccess: 'Enabled'
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
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};EndpointSuffix=${az.environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        { name: 'WEBSITE_CONTENTSHARE', value: toLower(functionAppName) }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
        { name: 'DASHBOARD_STORAGE_ACCOUNT', value: dashboardStorageAccountName }
        { name: 'KEY_VAULT_URL', value: keyVaultUrl }
        { name: 'TIGER_ADMIN_EMAILS', value: tigerAdminEmails }
        { name: 'WEBSITE_AUTH_AAD_ALLOWED_TENANTS', value: adminAuthAllowedTenantId }
        {
          name: authSecretSettingName
          value: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${adminAuthClientSecretName})'
        }
      ]
    }
  }
}

resource authSettings 'Microsoft.Web/sites/config@2023-12-01' = if (authEnabled) {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: adminAuthClientId
          clientSecretSettingName: authSecretSettingName
          openIdIssuer: 'https://login.microsoftonline.com/${adminAuthAllowedTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${adminAuthClientId}'
            adminAuthClientId
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
  }
}

output id string = functionApp.id
output name string = functionApp.name
output endpoint string = 'https://${functionApp.properties.defaultHostName}'
