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
var projectPoliciesContainerName = 'projectPolicies'
var meetingSecurityContainerName = 'meetingSecurity'

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
    enableAutomaticFailover: true
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

// SQL Containers
// All containers are partitioned by projectName so project-scoped reads stay efficient.
resource meetingsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: {
        paths: [
          '/projectName'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource projectPoliciesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: projectPoliciesContainerName
  properties: {
    resource: {
      id: projectPoliciesContainerName
      partitionKey: {
        paths: [
          '/projectName'
        ]
        kind: 'Hash'
      }
    }
  }
}

resource meetingSecurityContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: meetingSecurityContainerName
  properties: {
    resource: {
      id: meetingSecurityContainerName
      partitionKey: {
        paths: [
          '/projectName'
        ]
        kind: 'Hash'
      }
    }
  }
}

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
output containerName string = meetingsContainer.name
output projectPoliciesContainerName string = projectPoliciesContainer.name
output meetingSecurityContainerName string = meetingSecurityContainer.name
