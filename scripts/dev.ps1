#!/usr/bin/env pwsh
# Wrapper docker compose de la constellation micro-services Acervatim.
# Usage : ./scripts/dev.ps1 <command> [service] [args...]
#
# Les commandes "passe-plat" (npm, npx, prisma) s'executent DANS le conteneur du service
# vise : c'est le seul endroit ou elles tournent sur le bon reseau (hostname `db`) et avec
# les bons binaires Linux. Un lancement depuis Windows produit des artefacts Prisma
# inutilisables dans le conteneur.
#
# PowerShell 5.1 : ni && ni || - on chaine avec `; if ($?) { ... }`. Source en ASCII pur.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [string]$Service,

    [Parameter(Position = 2, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($null -eq $Rest) { $Rest = @() }

# Ordre de demarrage et de migration : les dependances d'abord. `identity` avant tout
# (il emet les JWT), les catalogs en dernier (ils enregistrent leurs collections aupres
# du registre de routage du gateway au boot). `rebrickable-data` ne depend de personne.
$AllServices = @(
    'gateway', 'identity', 'billing', 'connections', 'sharing', 'search',
    'rebrickable-data', 'catalog-generic', 'catalog-manga', 'catalog-vinyl'
)

# Port publie de rebrickable-data : ses routes /admin/* ne passent pas par le gateway.
$RebrickableDataPort = 3190

function Show-Help {
    @"
Acervatim - constellation micro-services

Cycle de vie :
  build [svc]          Rebuild l'image d'un service (toutes si omis)
  up                   Demarre toute la stack en foreground (logs)
  up-bg                Demarre en background (-d)
  up-one <svc>         Demarre un seul service et ses dependances
  restart <svc>        Redemarre un service
  down                 Stoppe (garde le volume db)
  reset                Stoppe + supprime le volume db (RESET TOTAL de toutes les bases)

Inspection :
  ps                   Etat des services
  logs [svc]           Tail des logs (tous si omis)
  shell <svc>          Shell sh dans le conteneur
  db-shell [schema]    CLI MariaDB (defaut : acv_gateway)
  health               Appelle /health/ready sur chaque service

Prisma (par service) :
  migrate <svc> <nom>  Cree + applique une migration
  migrate-deploy [svc] Applique les migrations existantes (toutes si omis)
  generate [svc]       Regenere le client Prisma
  studio <svc>         Prisma Studio (port 5555)

Bibliotheque partagee :
  link-core            (Re)cree la jonction catalog-*/catalog-core -> ../catalog-core

Qualite :
  lint <svc>           eslint --fix
  format <svc>         prettier --write
  test <svc> [args]    jest
  build-ts [svc]       nest build - verification de compilation (toutes si omis)

Catalogue LEGO (rebrickable-data, jeton ADMIN_API_TOKEN lu dans .env) :
  lego-status          Comptes, budget Brickset du jour, 10 derniers runs
  lego-import [force]  Import des CSV Rebrickable (force : ignore Last-Modified)
  lego-brickset        Campagne Brickset des codes-barres, dans le budget du jour

Services : $($AllServices -join ', ')
Ports    : gateway 3100, identity 3110, billing 3120, connections 3130,
           sharing 3140, search 3150, catalog-generic 3160, catalog-manga 3170,
           catalog-vinyl 3180, rebrickable-data 3190 - MariaDB 3320, Redis 6390.
"@ | Write-Host
}

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    & docker compose @ComposeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Resolve-Service {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Cette commande exige un service. Choix : $($AllServices -join ', ')"
    }
    if ($AllServices -notcontains $Name) {
        throw "Service inconnu : $Name. Choix : $($AllServices -join ', ')"
    }
    return $Name
}

function Invoke-InService {
    param([string]$Name, [string[]]$AppArgs)
    Invoke-Compose (@('exec', (Resolve-Service $Name)) + $AppArgs)
}

# Applique une commande a un service, ou a tous quand aucun n'est nomme.
function Invoke-EachOrOne {
    param([string]$Name, [string[]]$AppArgs)
    $targets = if ([string]::IsNullOrWhiteSpace($Name)) { $AllServices } else { @(Resolve-Service $Name) }
    foreach ($t in $targets) {
        Write-Host "--- $t" -ForegroundColor Cyan
        Invoke-Compose (@('exec', $t) + $AppArgs)
    }
}

# `catalog-core` est compile DANS chaque catalog, depuis ses sources, et non installe comme
# paquet npm. Le conteneur le recoit sous /app/catalog-core (voir Dockerfile.dev) ; sur l'hote,
# une jonction reproduit la meme disposition pour que l'editeur resolve les memes chemins.
function Invoke-LinkCore {
    $base = (Get-Location).Path
    foreach ($svc in @('catalog-generic', 'catalog-manga', 'catalog-vinyl')) {
        $link = Join-Path $base "$svc\catalog-core"
        if (Test-Path $link) {
            Write-Host "$svc : jonction deja en place"
            continue
        }
        New-Item -ItemType Junction -Path $link -Target (Join-Path $base 'catalog-core') | Out-Null
        Write-Host "$svc : jonction creee"
    }
}

function Invoke-Health {
    $ports = @{
        'gateway' = 3100; 'identity' = 3110; 'billing' = 3120; 'connections' = 3130
        'sharing' = 3140; 'search' = 3150; 'catalog-generic' = 3160
        'catalog-manga' = 3170; 'catalog-vinyl' = 3180; 'rebrickable-data' = 3190
    }
    foreach ($svc in $AllServices) {
        $uri = "http://localhost:$($ports[$svc])/health/ready"
        try {
            $res = Invoke-RestMethod -Method GET -Uri $uri -TimeoutSec 5
            Write-Host ("{0,-16} {1}" -f $svc, ($res | ConvertTo-Json -Compress -Depth 6))
        }
        catch {
            Write-Host ("{0,-16} INJOIGNABLE ({1})" -f $svc, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

# Lit une variable du .env de la racine (le meme que celui des conteneurs), quel que soit le
# repertoire courant. Valeur entre guillemets : prise telle quelle. Sinon, un commentaire de fin
# de ligne (espace puis #) est retire, comme le fait docker compose.
function Get-DotEnvValue {
    param([string]$Name)
    $envFile = Join-Path $PSScriptRoot '..\.env'
    if (-not (Test-Path $envFile)) { throw ".env absent : copier .env.example puis le remplir" }
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)$'
    foreach ($line in Get-Content $envFile) {
        if ($line -match $pattern) {
            $raw = $Matches[1].Trim()
            if ($raw -match '^"([^"]*)"') { return $Matches[1] }
            if ($raw -match "^'([^']*)'") { return $Matches[1] }
            return ($raw -replace '\s+#.*$', '').Trim()
        }
    }
    return ''
}

# Appel d'une route /admin/* de rebrickable-data. Delai long : un import complet attend la fin
# du telechargement et de l'ecriture des ~28 000 sets avant de repondre. Sur erreur HTTP, le
# corps Problem Details (RFC 9457) est affiche tel quel : c'est lui qui dit pourquoi.
function Invoke-LegoAdmin {
    param([string]$Method, [string]$Path)
    $token = Get-DotEnvValue 'ADMIN_API_TOKEN'
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'ADMIN_API_TOKEN vide dans .env' }
    $uri = "http://localhost:$RebrickableDataPort/$Path"
    try {
        $res = Invoke-RestMethod -Method $Method -Uri $uri -TimeoutSec 900 `
            -Headers @{ Authorization = "Bearer $token" }
    }
    catch {
        $err = $_
        $body = $null
        if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
            $body = $err.ErrorDetails.Message
        }
        elseif ($err.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($err.Exception.Response.GetResponseStream())
                $body = $reader.ReadToEnd()
            }
            catch { $body = $null }
        }
        Write-Host ("{0} /{1} : {2}" -f $Method, $Path, $err.Exception.Message) -ForegroundColor Red
        if ($body) { Write-Host $body -ForegroundColor Red }
        exit 1
    }
    $res | ConvertTo-Json -Depth 8 | Write-Host
}

switch ($Command) {
    'help' { Show-Help }
    'build' {
        if ([string]::IsNullOrWhiteSpace($Service)) { Invoke-Compose @('build') }
        else { Invoke-Compose @('build', (Resolve-Service $Service)) }
    }
    'up' { Invoke-Compose @('up') }
    'up-bg' { Invoke-Compose @('up', '-d') }
    'up-one' { Invoke-Compose @('up', '-d', (Resolve-Service $Service)) }
    'restart' { Invoke-Compose @('restart', (Resolve-Service $Service)) }
    'down' { Invoke-Compose @('down') }
    'reset' { Invoke-Compose @('down', '-v') }
    'ps' { Invoke-Compose @('ps') }
    'logs' {
        if ([string]::IsNullOrWhiteSpace($Service)) { Invoke-Compose @('logs', '-f') }
        else { Invoke-Compose @('logs', '-f', (Resolve-Service $Service)) }
    }
    'shell' { Invoke-InService $Service @('sh') }
    'db-shell' {
        $schema = if ([string]::IsNullOrWhiteSpace($Service)) { 'acv_gateway' } else { $Service }
        Invoke-Compose @('exec', 'db', 'mariadb', '-u', 'acervatim', '-p', $schema)
    }
    'health' { Invoke-Health }
    'link-core' { Invoke-LinkCore }
    'migrate' {
        $svc = Resolve-Service $Service
        if ($Rest.Count -eq 0) { throw 'migrate exige un nom de migration' }
        Invoke-Compose (@('exec', $svc, 'npx', 'prisma', 'migrate', 'dev', '--name') + $Rest)
    }
    'migrate-deploy' { Invoke-EachOrOne $Service @('npx', 'prisma', 'migrate', 'deploy') }
    'generate' { Invoke-EachOrOne $Service @('npx', 'prisma', 'generate') }
    'studio' { Invoke-InService $Service @('npx', 'prisma', 'studio', '--port', '5555') }
    'lint' { Invoke-InService $Service @('npm', 'run', 'lint') }
    'format' { Invoke-InService $Service @('npm', 'run', 'format') }
    'test' { Invoke-InService $Service (@('npm', 'run', 'test', '--') + $Rest) }
    'build-ts' { Invoke-EachOrOne $Service @('npm', 'run', 'build') }
    'lego-status' { Invoke-LegoAdmin 'GET' 'admin/status' }
    'lego-import' {
        $extra = -not [string]::IsNullOrWhiteSpace($Service) -and $Service -ne 'force'
        if ($extra -or $Rest.Count -gt 0) {
            throw "lego-import n'accepte qu'un argument optionnel : force"
        }
        $query = if ($Service -eq 'force') { '?force=true' } else { '' }
        Invoke-LegoAdmin 'POST' "admin/import/rebrickable$query"
    }
    'lego-brickset' { Invoke-LegoAdmin 'POST' 'admin/harvest/brickset' }
    default {
        Write-Host "Commande inconnue : $Command"
        Show-Help
        exit 1
    }
}
