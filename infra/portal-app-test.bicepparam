using './portal.bicep'

param project = 'tiger'
param environment = 'test'
param location = 'australiaeast'
param portalOrigin = 'https://app-tiger-portal-test-d4dubvh9g5eeeaea.australiaeast-01.azurewebsites.net'
param legacyHosts = 'dashboards-test.sswtiger.com'
param identityServerIssuer = 'https://app-ssw-ident-staging-api.azurewebsites.net'
param oidcClientId = 'ssw-tiger-portal'
param apiAudience = 'tiger'
param dashboardStorageAccountName = 'satigertestweb'
param dashboardContainer = 'reports'
param managedIdentityName = 'id-tiger-test'
param sharedPlanName = 'plan-tiger-portal-test'
param sharedPlanResourceGroup = 'SSW.Transcript-Intelligence-Group-Event-Reasoning.Dev'
param manageRoleAssignments = false
param bindCustomDomains = false
