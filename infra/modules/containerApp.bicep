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

@description('Claude model ID for the processor (e.g. claude-opus-4-5-20251101)')
param claudeModel string = 'claude-opus-4-5-20251101'

@description('Storage account name for dashboard static website hosting')
param dashboardStorageAccountName string

@description('Cosmos DB endpoint for meeting metadata persistence')
param cosmosEndpoint string = ''

@description('Transcript hub repo (owner/repo) for raw .vtt archiving. Empty disables publishing.')
param transcriptHubRepo string = ''

@description('GitHub App ID for the transcript hub publisher')
param transcriptHubAppId string = ''

@description('Installation ID of that App on the transcript hub repo')
param transcriptHubAppInstallationId string = ''

var envName = toLower('ce-${project}-${environment}')
var jobName = toLower('job-${project}-${environment}')
var dashboardBaseUrl = environment == 'staging' ? 'dashboards.sswtiger.com' : 'dashboards-${environment}.sswtiger.com'

// Opt-in: without a repo the publisher no-ops, and the App secret need not exist
var transcriptHubEnabled = !empty(transcriptHubRepo)
var transcriptHubSecrets = transcriptHubEnabled ? [
  {
    name: 'transcript-hub-app-private-key'
    keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/TRANSCRIPT-HUB-APP-PRIVATE-KEY'
    identity: managedIdentityId
  }
] : []
var transcriptHubEnv = transcriptHubEnabled ? [
  { name: 'TRANSCRIPT_HUB_REPO', value: transcriptHubRepo }
  { name: 'TRANSCRIPT_HUB_APP_ID', value: transcriptHubAppId }
  { name: 'TRANSCRIPT_HUB_APP_INSTALLATION_ID', value: transcriptHubAppInstallationId }
  { name: 'TRANSCRIPT_HUB_APP_PRIVATE_KEY', secretRef: 'transcript-hub-app-private-key' }
] : []

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
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 0

      // Secrets from Key Vault (using managed identity)
      secrets: concat([
        {
          name: 'anthropic-oauth-token'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/anthropic-oauth-token'
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
        {
          name: 'storage-connection-string'
          keyVaultUrl: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/storage-connection-string'
          identity: managedIdentityId
        }
      ], transcriptHubSecrets)

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
          env: concat([
            { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: 'anthropic-oauth-token' }
            { name: 'DASHBOARD_STORAGE_ACCOUNT', value: dashboardStorageAccountName }
            { name: 'DASHBOARD_BASE_URL', value: dashboardBaseUrl }
            { name: 'CLAUDE_MODEL', value: claudeModel }
            { name: 'NODE_ENV', value: environment == 'prod' ? 'production' : 'development' }
            { name: 'GRAPH_CLIENT_ID', secretRef: 'graph-client-id' }
            { name: 'GRAPH_CLIENT_SECRET', secretRef: 'graph-client-secret' }
            { name: 'GRAPH_TENANT_ID', secretRef: 'graph-tenant-id' }
            { name: 'LOGIC_APP_URL', secretRef: 'logic-app-url' }
            { name: 'STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
            { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'COSMOS_PROJECT_POLICIES_CONTAINER', value: 'projectPolicies' }
            { name: 'COSMOS_MEETING_SECURITY_CONTAINER', value: 'meetingSecurity' }
            { name: 'KEY_VAULT_URL', value: 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}' }
          ], transcriptHubEnv)
        }
      ]
    }
  }
}

// NOTE: Managed identity has Contributor at resource group level (configured externally)
// This covers jobs.start/stop/list permissions needed by the Function App

output environmentId string = containerEnv.id
output environmentName string = containerEnv.name
output jobName string = processorJob.name
output jobId string = processorJob.id
