#!/usr/bin/env pwsh
# Construit l'archive de deploiement de la constellation : les douze images, Redis et un client
# MariaDB pour l'architecture de l'hote, et le script qui deroule le deploiement.
#
# Usage :
#   ./deploy/build-archive.ps1 -Version 0.1.0                                  # arm64
#   ./deploy/build-archive.ps1 -Version 0.1.0 -Architecture amd64 -Brouillon   # repetition
#
# Sortie, hors du depot : ..\archives\acervatim-services-<version>-<arch>\ avec
#   acervatim-services-<version>-<arch>.tar   l'archive (images comprises)
#   deploiement.sh                            le script, le meme que dans l'archive
# Copier ce dossier sur l'hote, puis : sh deploiement.sh acervatim-services-<version>-<arch>.tar
#
# Une archive correspond a une version etiquetee et a rien d'autre : arbre de travail propre,
# HEAD etiquete v<version>, la meme version dans les package.json et dans les images epinglees
# par deploy/acervatim.yaml. -Brouillon leve les deux premieres conditions pour une repetition ;
# l'archive est alors marquee, et deploiement.sh le signale.
#
# -SansConstruction reprend les images deja construites ; leur architecture est controlee
# quand meme. Construire en arm64 sur un poste amd64 passe par l'emulation de Docker Desktop :
# plusieurs fois plus lent qu'en natif.
#
# PowerShell 5.1 : ni && ni ||, et jamais de redirection de stderr d'une commande native sous
# ErrorActionPreference Stop. Source en ASCII pur.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [ValidateSet('arm64', 'amd64')][string]$Architecture = 'arm64',
    [string]$Sortie,
    [switch]$Brouillon,
    [switch]$SansConstruction
)

$ErrorActionPreference = 'Stop'
$Racine = Split-Path -Parent $PSScriptRoot
Set-Location $Racine
if (-not $Sortie) { $Sortie = Join-Path (Split-Path -Parent $Racine) 'archives' }
$debut = Get-Date

function Etape([string]$texte) { Write-Host "--- $texte" -ForegroundColor Cyan }

function Verifier([string]$description) {
    if ($LASTEXITCODE -ne 0) { throw "Echec : $description (code $LASTEXITCODE)" }
}

# Une commande native dont l'echec est attendu (git describe sur un commit non etiquete).
function Silencieux([scriptblock]$bloc) {
    $ancien = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $bloc 2>$null } finally { $ErrorActionPreference = $ancien }
}

# Le tar de Windows (bsdtar), pas celui de Git for Windows qu'un PATH herite de Git Bash ferait
# passer devant : il lit `C:` comme un hote distant.
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

$Services = @('gateway', 'identity', 'billing', 'connections', 'sharing', 'search',
    'catalog-generic', 'catalog-manga', 'catalog-vinyl', 'catalog-lego', 'rebrickable-data', 'migrate')
$Images = $Services | ForEach-Object { "localhost/acervatim-$($_):$Version" }
$Tiers = @(
    @{ Cle = 'redis'; Source = 'docker.io/library/redis:7-alpine'; Cible = 'localhost/acervatim-tiers/redis:7-alpine' }
    @{ Cle = 'client_sql'; Source = 'docker.io/library/mariadb:10.11'; Cible = 'localhost/acervatim-tiers/mariadb:10.11' }
)

# ------------------------------------------------------------------ 1. une version, et une seule
Etape "controles de version ($Version, $Architecture)"
$commit = (git rev-parse HEAD).Trim()
Verifier 'git rev-parse'
$modifie = git status --porcelain
$etiquette = Silencieux { git describe --exact-match --tags HEAD }
$reserves = @()
if ($modifie) { $reserves += 'arbre de travail modifie' }
if ("$etiquette".Trim() -ne "v$Version") { $reserves += "HEAD ($($commit.Substring(0, 7))) n'est pas etiquete v$Version" }
if ($reserves.Count -gt 0) {
    if (-not $Brouillon) { throw "Archive refusee : $($reserves -join ' ; '). -Brouillon pour une repetition." }
    Write-Host "  BROUILLON : $($reserves -join ' ; ')" -ForegroundColor Yellow
}

$paquets = @('gateway', 'identity', 'billing', 'connections', 'sharing', 'search', 'catalog-core',
    'catalog-generic', 'catalog-manga', 'catalog-vinyl', 'catalog-lego', 'rebrickable-data')
foreach ($p in $paquets) {
    $v = (Get-Content (Join-Path $Racine "$p\package.json") -Raw | ConvertFrom-Json).version
    if ($v -ne $Version) { throw "$p/package.json est en $v, pas en $Version" }
}
$epinglees = Select-String -Path (Join-Path $Racine 'deploy\acervatim.yaml') -Pattern '^\s+image:\s+(\S+)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value }
foreach ($i in $epinglees) {
    if (-not $i.EndsWith(":$Version")) { throw "deploy/acervatim.yaml epingle $i, pas la version $Version" }
}
Write-Host "  $($paquets.Count) package.json et $($epinglees.Count) images epinglees en $Version"

# ------------------------------------------------------------------ 2. les images
if (-not $SansConstruction) {
    Etape "construction des douze images en linux/$Architecture"
    & (Join-Path $PSScriptRoot 'build-images.ps1') -Engine docker -Platform "linux/$Architecture" -Tag $Version
}

# Les images tierces, prises par empreinte de plateforme : avec le stockage classique de Docker,
# tirer la variante arm64 d'une etiquette remplacerait l'image amd64 locale du meme nom.
Etape "images tierces en $Architecture"
foreach ($t in $Tiers) {
    $index = (docker buildx imagetools inspect $t.Source --raw) -join "`n" | ConvertFrom-Json
    Verifier "lecture de l'index de $($t.Source)"
    $m = $index.manifests | Where-Object {
        $_.platform.os -eq 'linux' -and $_.platform.architecture -eq $Architecture
    } | Select-Object -First 1
    if (-not $m) { throw "$($t.Source) n'existe pas en linux/$Architecture" }
    $depot = $t.Source.Substring(0, $t.Source.LastIndexOf(':'))
    docker pull -q "$depot@$($m.digest)" | Out-Null
    Verifier "docker pull $depot@$($m.digest)"
    docker tag "$depot@$($m.digest)" $t.Cible
    Verifier "docker tag $($t.Cible)"
    $t.Empreinte = $m.digest
    Write-Host "  $($t.Cible) <- $($t.Source)@$($m.digest)"
}

# ------------------------------------------------------------------ 3. controle de chaque image
Etape "controle des images (node et moteurs Prisma en $Architecture)"
$outils = Join-Path $PSScriptRoot 'outils'
foreach ($img in $Images) {
    $a = (docker image inspect --format '{{.Architecture}}' $img)
    Verifier "docker image inspect $img"
    if ($a -ne $Architecture) { throw "$img est en $a, pas en $Architecture" }
    $resultat = docker run --rm --platform "linux/$Architecture" -v "$($outils):/controle:ro" `
        --entrypoint node $img /controle/controle-image.js $Architecture
    if ($LASTEXITCODE -ne 0) { throw "controle KO pour $img : $($resultat -join ' ')" }
    Write-Host "  OK  $img : $($resultat -join ' ')"
}
foreach ($t in $Tiers) {
    $a = (docker image inspect --format '{{.Architecture}}' $t.Cible)
    if ($a -ne $Architecture) { throw "$($t.Cible) est en $a, pas en $Architecture" }
    Write-Host "  OK  $($t.Cible) : $a"
}

# ------------------------------------------------------------------ 4. assemblage
$nom = "acervatim-services-$Version"
$suffixe = if ($Brouillon) { "-$Architecture-brouillon" } else { "-$Architecture" }
$dossierSortie = Join-Path $Sortie "$nom$suffixe"
$travail = Join-Path $env:TEMP "acv-archive-$([guid]::NewGuid().ToString('N'))"
$contenu = Join-Path $travail $nom
New-Item -ItemType Directory -Force $contenu | Out-Null
# Chemin long : les chemins relatifs de SHA256SUMS se calculent par soustraction.
$contenu = (Get-Item $contenu).FullName

try {
    Etape 'fichiers de deploiement, depuis git'
    # Depuis git et non depuis l'arbre de travail : fins de ligne LF, aucun fichier ignore (pas
    # de secret rempli). En brouillon, un index temporaire capte l'arbre de travail sans toucher
    # a l'index reel ni a HEAD.
    $arbre = 'HEAD'
    if ($Brouillon) {
        $env:GIT_INDEX_FILE = Join-Path $travail 'index'
        try {
            git read-tree HEAD
            Verifier 'git read-tree'
            git -c core.safecrlf=false add -A -- deploy db CHANGELOG.md
            Verifier 'git add (index temporaire)'
            $arbre = (git write-tree).Trim()
            Verifier 'git write-tree'
        } finally {
            Remove-Item Env:GIT_INDEX_FILE
        }
    }
    $sources = Join-Path $travail 'sources.tar'
    git -c core.autocrlf=false archive --format=tar -o $sources $arbre deploy db CHANGELOG.md
    Verifier 'git archive'
    & $Tar -xf $sources -C $contenu
    Verifier 'extraction des sources'
    Remove-Item $sources
    Copy-Item (Join-Path $contenu 'deploy\deploiement.sh') (Join-Path $contenu 'deploiement.sh')

    Etape 'docker save des quatorze images (plusieurs minutes)'
    $tarImages = Join-Path $travail 'images.tar'
    $refs = @($Images) + @($Tiers | ForEach-Object { $_.Cible })
    docker save -o $tarImages @refs
    Verifier 'docker save'
    $brut = (Get-Item $tarImages).Length
    $entree = [IO.File]::OpenRead($tarImages)
    $sortieGz = [IO.File]::Create((Join-Path $contenu 'images.tar.gz'))
    $gz = New-Object IO.Compression.GZipStream($sortieGz, [IO.Compression.CompressionLevel]::Optimal)
    try { $entree.CopyTo($gz, 4MB) } finally { $gz.Dispose(); $sortieGz.Dispose(); $entree.Dispose() }
    Remove-Item $tarImages
    $compresse = (Get-Item (Join-Path $contenu 'images.tar.gz')).Length

    Etape 'MANIFEST et empreintes'
    $mio = 1024 * 1024
    $lf = New-Object Text.UTF8Encoding $false
    $manifeste = @(
        "version=$Version"
        "commit=$commit"
        "brouillon=$(if ($Brouillon) { 'oui' } else { 'non' })"
        "architecture=$Architecture"
        "construite=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
        "images=$($Images -join ' ')"
        "redis=$(($Tiers | Where-Object { $_.Cle -eq 'redis' }).Cible)"
        "client_sql=$(($Tiers | Where-Object { $_.Cle -eq 'client_sql' }).Cible)"
        "tiers=$(($Tiers | ForEach-Object { "$($_.Source)@$($_.Empreinte)" }) -join ' ')"
        "images_brut_mio=$([math]::Ceiling($brut / $mio))"
        "espace_requis_mio=$([math]::Ceiling($brut * 1.15 / $mio) + 512)"
    )
    [IO.File]::WriteAllText((Join-Path $contenu 'MANIFEST'), ($manifeste -join "`n") + "`n", $lf)

    $empreintes = Get-ChildItem -Path $contenu -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relatif = $_.FullName.Substring($contenu.Length + 1).Replace('\', '/')
        "$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower())  $relatif"
    }
    [IO.File]::WriteAllText((Join-Path $contenu 'SHA256SUMS'), ($empreintes -join "`n") + "`n", $lf)

    Etape 'archive'
    New-Item -ItemType Directory -Force $dossierSortie | Out-Null
    $archive = Join-Path $dossierSortie "$nom$suffixe.tar"
    if (Test-Path $archive) { Remove-Item $archive }
    & $Tar -cf $archive -C $travail $nom
    Verifier "creation de $archive"
    Copy-Item (Join-Path $contenu 'deploiement.sh') (Join-Path $dossierSortie 'deploiement.sh') -Force
} finally {
    Remove-Item -Recurse -Force $travail -ErrorAction SilentlyContinue
}

$taille = [math]::Round((Get-Item $archive).Length / $mio)
$duree = [math]::Round(((Get-Date) - $debut).TotalMinutes, 1)
Write-Host ''
Write-Host "Archive : $archive ($taille Mio ; images $([math]::Round($brut / $mio)) Mio brut, $([math]::Round($compresse / $mio)) Mio compressees ; $duree min)" -ForegroundColor Green
Write-Host "Sur l'hote, apres copie du dossier $dossierSortie :"
Write-Host "  sh deploiement.sh $nom$suffixe.tar"
