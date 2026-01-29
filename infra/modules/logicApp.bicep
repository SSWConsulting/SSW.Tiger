// Logic App for Teams Notification (Consumption)

param project string
param location string
param costCategoryTag object

var logicAppName = toLower('${project}Notify')

// Logic App (Consumption) - Empty, ready for Portal configuration
resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  tags: costCategoryTag
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {}
      triggers: {}
      actions: {}
      outputs: {}
    }
  }
}

output name string = logicApp.name
output id string = logicApp.id
output resourceGroup string = resourceGroup().name
