// Container Apps Environment + Job
// Runs the Claude meeting processor from ghcr.io

param project string
param environment string
param location string
param costCategoryTag object
param keyVaultName string
param containerImage string
param ghcrUsername string
param managedIdentityId string
param managedIdentityClientId string

// Log Analytics for container logs
param logAnalyticsCustomerId string
@secure()
param logAnalyticsPrimaryKey string

// Parameters for container resources
param cpu string = '2.0'
param memory string = '4Gi'
param replicaTimeout int = 3600 

var envName = toLower('ce-${project}-${environment}')
var jobName = toLower('job-${project}-${environment}')

// Container Apps Environment (the "cluster")
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  tags: costCategoryTag
  properties: {
    zoneRedundant: false
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    // Log Analytics integration - logs are automatically collected
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsPrimaryKey
      }
    }
  }
}

// Container App Job (the actual processor)
resource processorJob 'Microsoft.App/jobs@2025-01-01' = {
  name: jobName
  location: location
  tags: costCategoryTag
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: containerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 1

      // Secrets from Key Vault (using managed identity)
      secrets: [
        {
          name: 'anthropic-oauth-token'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/anthropic-oauth-token'
          identity: managedIdentityId
        }
        {
          name: 'surge-email'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/surge-email'
          identity: managedIdentityId
        }
        {
          name: 'surge-token'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/surge-token'
          identity: managedIdentityId
        }
        {
          name: 'ghcr-token'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/ghcr-token'
          identity: managedIdentityId
        }
        // Graph API credentials
        {
          name: 'graph-client-id'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/graph-client-id'
          identity: managedIdentityId
        }
        {
          name: 'graph-client-secret'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/graph-client-secret'
          identity: managedIdentityId
        }
        {
          name: 'graph-tenant-id'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/graph-tenant-id'
          identity: managedIdentityId
        }
        {
          name: 'logic-app-url'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/logic-app-url'
          identity: managedIdentityId
        }
      ]

      // Pull image from GitHub Container Registry
      registries: [
        {
          server: 'ghcr.io'
          username: ghcrUsername
          passwordSecretRef: 'ghcr-token'
        }
      ]
    }

    template: {
      containers: [
        {
          name: 'tiger-processor'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'anthropic-oauth-token' }
            { name: 'SURGE_EMAIL', secretRef: 'surge-email' }
            { name: 'SURGE_TOKEN', secretRef: 'surge-token' }
            { name: 'NODE_ENV', value: environment == 'prod' ? 'production' : 'development' }
            { name: 'GRAPH_CLIENT_ID', secretRef: 'graph-client-id' }
            { name: 'GRAPH_CLIENT_SECRET', secretRef: 'graph-client-secret' }
            { name: 'GRAPH_TENANT_ID', secretRef: 'graph-tenant-id' }
            { name: 'LOGIC_APP_URL', secretRef: 'logic-app-url' }
          ]
        }
      ]
    }
  }
}

output environmentId string = containerEnv.id
output environmentName string = containerEnv.name
output jobName string = processorJob.name
output jobId string = processorJob.id
