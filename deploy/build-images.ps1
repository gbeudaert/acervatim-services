#!/usr/bin/env pwsh
# Construit les dix images de la constellation : les neuf services + l'image de migration.
#
# Usage :
#   ./deploy/build-images.ps1                      # toutes, arch de l'hote
#   ./deploy/build-images.ps1 -Only gateway,search # un sous-ensemble
#   ./deploy/build-images.ps1 -Platform linux/arm64
#   ./deploy/build-images.ps1 -Tag 0.2.0
#
# **Construire sur l'architecture de deploiement.** Prisma genere l'engine de la plateforme du
# BUILD : une image construite en amd64 puis copiee sur un hote arm64 echoue au premier acces
# a la base, avec un message qui ne mentionne pas l'architecture. Le cross-build via
# `-Platform` fonctionne mais exige qemu-user-static + binfmt sur l'hote de build.
#
# PowerShell 5.1 : ni && ni || - on chaine avec `; if ($?) { ... }`. Source en ASCII pur.

[CmdletBinding()]
param(
    [string[]]$Only,
    [string]$Tag = '0.1.0',
    [string]$Platform,
    [string]$Engine = 'podman'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# Les trois catalogs se construisent depuis la racine : leur Dockerfile a besoin de
# `catalog-core/` en plus de leur propre dossier (voir catalog-core/README.md).
$Images = @(
    @{ Name = 'gateway';         Context = 'gateway';     File = 'gateway/Dockerfile' }
    @{ Name = 'identity';        Context = 'identity';    File = 'identity/Dockerfile' }
    @{ Name = 'billing';         Context = 'billing';     File = 'billing/Dockerfile' }
    @{ Name = 'connections';     Context = 'connections'; File = 'connections/Dockerfile' }
    @{ Name = 'sharing';         Context = 'sharing';     File = 'sharing/Dockerfile' }
    @{ Name = 'search';          Context = 'search';      File = 'search/Dockerfile' }
    @{ Name = 'catalog-generic'; Context = '.';           File = 'catalog-generic/Dockerfile' }
    @{ Name = 'catalog-manga';   Context = '.';           File = 'catalog-manga/Dockerfile' }
    @{ Name = 'catalog-vinyl';   Context = '.';           File = 'catalog-vinyl/Dockerfile' }
    @{ Name = 'migrate';         Context = '.';           File = 'deploy/Dockerfile.migrate' }
)

if ($Only) {
    $Images = $Images | Where-Object { $Only -contains $_.Name }
    if ($Images.Count -eq 0) {
        throw "Aucune image ne correspond a -Only. Choix : $(($Images | ForEach-Object { $_.Name }) -join ', ')"
    }
}

$built = @()
foreach ($img in $Images) {
    $ref = "localhost/acervatim-$($img.Name):$Tag"
    Write-Host "--- $ref" -ForegroundColor Cyan

    $buildArgs = @('build', '-f', $img.File, '-t', $ref)
    if ($Platform) { $buildArgs += @('--platform', $Platform) }
    $buildArgs += $img.Context

    & $Engine @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Echec du build de $ref"
    }
    $built += $ref
}

Write-Host ''
Write-Host "$($built.Count) image(s) construite(s) :" -ForegroundColor Green
$built | ForEach-Object { Write-Host "  $_" }

if ($Tag -ne '0.1.0') {
    Write-Host ''
    Write-Host "Le tag $Tag doit etre repercute dans deploy/acervatim.yaml (champs image:)." -ForegroundColor Yellow
    Write-Host 'Le manifeste epingle les versions a dessein : un `latest` rendrait indeterminee'
    Write-Host 'la version reellement en service apres un redemarrage.'
}
