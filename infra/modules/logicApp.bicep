// Logic App for Teams Adaptive Card notifications (Consumption)
// All card operations go through a single Logic App with operationType switch:
//   - "sendCard"   → Post new card to organizer DM, return { messageId }
//   - "updateCard"  → Update existing card by messageId
//   - "ask"         → Post [Process][Skip] card, wait for response, call ManualTrigger

param project string
param environment string
param location string
param costCategoryTag object

// Capitalize first letter of project for PascalCase naming (Bicep has no capitalize())
var projectPascal = '${toUpper(substring(project, 0, 1))}${substring(project, 1)}'
// Match existing production name: TigerTeams (staging), TigerTeams-test (other envs)
var logicAppName = environment == 'staging' ? '${projectPascal}Teams' : '${projectPascal}Teams-${environment}'

// Logic App (Consumption) - Empty shell, configured in Portal
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
