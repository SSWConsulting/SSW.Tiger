// Manage the single shared Portal plan separately from either application.
targetScope = 'resourceGroup'

param project string = 'tiger'
param location string = resourceGroup().location

// Reuse the plan already created for the test Portal. Its name is historical.
param sharedPlanName string = 'plan-${project}-portal-test'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: sharedPlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    capacity: 1
  }
  properties: { reserved: true }
}

output name string = plan.name
output id string = plan.id
output location string = plan.location
