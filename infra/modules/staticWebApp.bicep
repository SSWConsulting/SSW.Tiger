// Static Web App that hosts the Parrot portal SPA and links the Portal API
// Function App as its /api backend.
//
// Auth: SWA built-in Entra (AAD) provider, REUSING the existing Graph app
// registration (no new registration) — clientId + secret arrive as params and
// land in SWA app settings that staticwebapp.config.json references by name.
//
// Backend lockdown: the linkedBackends link auto-provisions an
// "Azure Static Web Apps (Linked)" EasyAuth provider on the Function App so only
// SWA-proxied requests are accepted. VERIFY it exists after deploy with
// infra/scripts/verify-portal-auth-boundary.sh — it is what makes the backend's
// anonymous functions safe.

param project string
param environment string
param costCategoryTag object

@description('Static Web Apps is only offered in a limited set of regions (australiaeast is NOT one). Pass a supported region; defaults to East Asia (closest to AU).')
param location string = 'eastasia'

@description('Resource ID of the Portal API Function App to link as the /api backend.')
param backendResourceId string

@description('Region of the linked backend Function App (may differ from the SWA region).')
param backendRegion string

@description('Write the Entra auth app settings below. Off by default: on both existing SWAs these were set by hand, and re-writing them costs the deployer a Key Vault Secrets User grant for no change. Off means ARM simply omits the resource, and incremental mode leaves the existing settings untouched.')
param manageAuthSettings bool = false

@secure()
@description('Entra (AAD) app registration client ID, reused from the Graph app for user login. Marked secure only so it can be sourced from Key Vault via getSecret(). Ignored unless manageAuthSettings is true.')
param entraClientId string = ''

@secure()
@description('Client secret for the reused Entra app registration. Ignored unless manageAuthSettings is true.')
param entraClientSecret string = ''

var staticWebAppName = toLower('swa-${project}-portal-${environment}')

resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticWebAppName
  location: location
  tags: costCategoryTag
  // Standard is REQUIRED for linked backends and custom Entra auth (Free supports neither).
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // Content is published by CI (SWA deploy); no source repo wired into the resource.
    allowConfigFileUpdates: true
    // Linked backends are unsupported in preview environments, so disable them.
    stagingEnvironmentPolicy: 'Disabled'
  }
}

// App settings referenced by staticwebapp.config.json's azureActiveDirectory
// registration (clientIdSettingName / clientSecretSettingName).
//
// ⚠️ This resource is a FULL REPLACE of the SWA's app settings — it does not merge.
// That is the other reason it is gated: an accidental run with only these two
// values would drop any other setting somebody added out of band.
//
// The setting NAME is literally "AZURE_CLIENT_SECRET_APP_SETTING_NAME" and it
// holds the secret VALUE, not a name. Confusing, but it is what the config file
// points clientSecretSettingName at — do not "fix" one without the other.
resource swaAppSettings 'Microsoft.Web/staticSites/config@2024-11-01' = if (manageAuthSettings) {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    AZURE_CLIENT_ID: entraClientId
    AZURE_CLIENT_SECRET_APP_SETTING_NAME: entraClientSecret
  }
}

// Link the Portal API Function App. This is the operation that provisions the
// "Azure Static Web Apps (Linked)" EasyAuth provider on the backend.
resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2025-03-01' = {
  parent: staticWebApp
  name: 'portalApi'
  properties: {
    backendResourceId: backendResourceId
    region: backendRegion
  }
}

output name string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname
output url string = 'https://${staticWebApp.properties.defaultHostname}'
// The Entra redirect URI to register on the existing Graph app registration.
output redirectUri string = 'https://${staticWebApp.properties.defaultHostname}/.auth/login/aad/callback'
