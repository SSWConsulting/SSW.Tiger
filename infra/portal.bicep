// Deploy the Portal independently without changing Graph webhook authentication.
targetScope = 'resourceGroup'

param project string = 'tiger'
param environment string
param location string = resourceGroup().location
param portalOrigin string
param legacyHosts string
param identityServerIssuer string = 'https://identity.ssw.com.au'
param oidcClientId string
param employeeSubjects string = ''
param employeeClaim string = ''
param employeeValue string = 'true'
param dashboardStorageAccountName string
param dashboardContainer string = 'reports'
param keyVaultName string
param clientSecretName string = 'tiger-portal-oidc-client-secret'
param manageRoleAssignments bool = false
param bindCustomDomains bool = false
// Keep the existing test plan name to adopt it without moving the test app.
// Both test and staging apps must reference the same separately managed plan.
param sharedPlanName string = 'plan-${project}-portal-test'
param sharedPlanResourceGroup string = resourceGroup().name

var appName = 'app-${project}-portal-${environment}'
var host = replace(portalOrigin, 'https://', '')
var domains = concat([host], empty(legacyHosts) ? [] : split(legacyHosts, ','))

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${project}-portal-${environment}'
  location: location
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: dashboardStorageAccountName
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource reports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: dashboardContainer
  properties: { publicAccess: 'None' }
}
resource sessions 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'portal-sessions'
  properties: { publicAccess: 'None' }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (manageRoleAssignments) {
  name: guid(reports.id, identity.id, 'reader')
  scope: reports
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  }
}
resource sessionWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (manageRoleAssignments) {
  name: guid(sessions.id, identity.id, 'writer')
  scope: sessions
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (manageRoleAssignments) {
  name: guid(vault.id, identity.id, 'secrets')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}
// App deployments reference the plan; only portal-plan.bicep manages its SKU/capacity.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: sharedPlanName
  scope: resourceGroup(sharedPlanResourceGroup)
}
resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: identity.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm start'
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
      appSettings: [
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'PORTAL_ORIGIN', value: portalOrigin }
        { name: 'PORTAL_LEGACY_HOSTS', value: legacyHosts }
        { name: 'OIDC_ISSUER', value: identityServerIssuer }
        { name: 'OIDC_CLIENT_ID', value: oidcClientId }
        { name: 'OIDC_CLIENT_SECRET', value: '@Microsoft.KeyVault(SecretUri=${vault.properties.vaultUri}secrets/${clientSecretName})' }
        { name: 'PORTAL_EMPLOYEE_SUBJECTS', value: employeeSubjects }
        { name: 'PORTAL_EMPLOYEE_CLAIM', value: employeeClaim }
        { name: 'PORTAL_EMPLOYEE_VALUE', value: employeeValue }
        { name: 'DASHBOARD_STORAGE_ACCOUNT', value: dashboardStorageAccountName }
        { name: 'DASHBOARD_CONTAINER', value: dashboardContainer }
        { name: 'PORTAL_SESSION_CONTAINER', value: 'portal-sessions' }
      ]
    }
  }
}
// Verify DNS ownership first, then configure TLS certificate bindings in Azure.
resource bindings 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = [for domain in domains: if (bindCustomDomains) {
  parent: app
  name: domain
  properties: { hostNameType: 'Verified' }
}]
output name string = app.name
output sharedPlanId string = plan.id
output azureHost string = app.properties.defaultHostName
output customDomainVerificationId string = app.properties.customDomainVerificationId
output portalIdentity object = {
  principalId: identity.properties.principalId
  clientId: identity.properties.clientId
}
