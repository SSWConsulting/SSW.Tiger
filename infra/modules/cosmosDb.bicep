// Cosmos DB - Serverless NoSQL database for meeting metadata and consolidated analysis
// Stores meeting records partitioned by projectName for efficient querying

param project string
param environment string
param location string = resourceGroup().location
param costCategoryTag object

@description('Principal ID of the managed identity to grant data access')
param managedIdentityPrincipalId string

var accountName = toLower('cosmos-${project}-${environment}')
var databaseName = 'tiger'
var containerName = 'meetings'

// Cosmos DB Account (Serverless)
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
  location: location
  tags: costCategoryTag
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      { name: 'EnableServerless' }
    ]
    locations: [
      {
        locationName: location
        failoverPriority: 0
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    // Key-based auth disabled — code uses DefaultAzureCredential (managed identity)
    disableLocalAuth: true
  }
}

// SQL Database
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

// NOTE: Container is created via post-deploy script (ARM nested resource path fails for sqlContainers)
// Run: az cosmosdb sql container create --account-name <name> -g <rg> -d tiger -n meetings -p /projectName

// Grant managed identity "Cosmos DB Built-in Data Contributor" role
// This allows read/write without using account keys
resource cosmosRoleAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, managedIdentityPrincipalId, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: managedIdentityPrincipalId
    scope: cosmosAccount.id
  }
}

output endpoint string = cosmosAccount.properties.documentEndpoint
output accountName string = cosmosAccount.name
output databaseName string = databaseName
output containerName string = containerName
