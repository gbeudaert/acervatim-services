#!/usr/bin/env pwsh
# Wrapper docker compose pour le dev local du service LEGO.
# Usage : ./scripts/dev.ps1 <command> [args...]
# Les commandes "passe-plat" s'executent dans le conteneur "app" : c'est le seul
# endroit ou npm/npx/prisma tournent sur le bon reseau (hostname db) et avec les
# bons binaires Linux. Un lancement depuis Windows produit des artefacts Prisma
# inutilisables dans le conteneur.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($null -eq $Rest) { $Rest = @() }

function Show-Help {
    @"
Acervatim LEGO - dev wrapper

Setup / lifecycle :
  build              Rebuild l'image app (apres modif Dockerfile.dev ou package.json)
  up                 Demarre tous les services en foreground (logs)
  up-bg              Demarre en background (-d)
  restart            Redemarre le conteneur app
  down               Stoppe (garde le volume db)
  reset              Stoppe + supprime le volume db (RESET total de la base)

Inspection :
  ps                 Liste les services
  logs               Tail des logs de app
  shell              Shell sh dans le conteneur app
  db-shell           CLI MariaDB (user acervatim, demande le password)

Prisma :
  migrate <nom>      Cree + applique une nouvelle migration
  migrate-deploy     Applique les migrations existantes (CI-style)
  generate           Regenere le client Prisma
  studio             Lance Prisma Studio (port 5555)

Qualite :
  lint               eslint --fix
  format             prettier --write
  test [args...]     jest
  build-ts           nest build (verification de compilation)

Index LEGO (necessite ADMIN_API_TOKEN dans .env) :
  index-status       Etat de l'index, budget Brickset et dernieres campagnes
  sync-themes        Synchronise l'arbre des themes Rebrickable
  harvest-catalog    Moissonne le catalogue Rebrickable
  harvest-barcodes   Moissonne les codes-barres Brickset (dans la limite du budget)
"@ | Write-Host
}

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    & docker compose @ComposeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Invoke-InApp {
    param([string[]]$AppArgs)
    Invoke-Compose (@('exec', 'app') + $AppArgs)
}

function Get-AdminToken {
    if (-not (Test-Path '.env')) { throw '.env absent' }
    $line = Select-String -Path '.env' -Pattern '^ADMIN_API_TOKEN=' | Select-Object -First 1
    if ($null -eq $line) { throw 'ADMIN_API_TOKEN absent de .env' }
    return $line.Line.Substring('ADMIN_API_TOKEN='.Length).Trim().Trim('"')
}

function Invoke-Admin {
    param([string]$Method, [string]$Path)
    $token = Get-AdminToken
    $port = 3010
    $uri = "http://localhost:$port$Path"
    $res = Invoke-RestMethod -Method $Method -Uri $uri -Headers @{ Authorization = "Bearer $token" }
    $res | ConvertTo-Json -Depth 8 | Write-Host
}

switch ($Command) {
    'help'             { Show-Help }
    'build'            { Invoke-Compose @('build', 'app') }
    'up'               { Invoke-Compose @('up') }
    'up-bg'            { Invoke-Compose @('up', '-d') }
    'restart'          { Invoke-Compose @('restart', 'app') }
    'down'             { Invoke-Compose @('down') }
    'reset'            { Invoke-Compose @('down', '-v') }
    'ps'               { Invoke-Compose @('ps') }
    'logs'             { Invoke-Compose @('logs', '-f', 'app') }
    'shell'            { Invoke-Compose @('exec', 'app', 'sh') }
    'db-shell'         { Invoke-Compose @('exec', 'db', 'mariadb', '-u', 'acervatim', '-p', 'acv_cat_lego') }
    'migrate'          { Invoke-InApp (@('npx', 'prisma', 'migrate', 'dev', '--name') + $Rest) }
    'migrate-deploy'   { Invoke-InApp @('npx', 'prisma', 'migrate', 'deploy') }
    'generate'         { Invoke-InApp @('npx', 'prisma', 'generate') }
    'studio'           { Invoke-InApp @('npx', 'prisma', 'studio', '--port', '5555') }
    'lint'             { Invoke-InApp @('npm', 'run', 'lint') }
    'format'           { Invoke-InApp @('npm', 'run', 'format') }
    'test'             { Invoke-InApp (@('npm', 'run', 'test', '--') + $Rest) }
    'build-ts'         { Invoke-InApp @('npm', 'run', 'build') }
    'index-status'     { Invoke-Admin 'GET'  '/admin/lego/index' }
    'sync-themes'      { Invoke-Admin 'POST' '/admin/lego/themes/sync' }
    'harvest-catalog'  { Invoke-Admin 'POST' '/admin/lego/index/rebrickable' }
    'harvest-barcodes' { Invoke-Admin 'POST' '/admin/lego/index/brickset' }
    default {
        Write-Host "Commande inconnue : $Command"
        Show-Help
        exit 1
    }
}
