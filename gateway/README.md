# Gateway

Point d'entree de la constellation Acervatim. Il conserve le contrat `/v1/*` que l'app Android
connait deja, et n'implemente aucun metier.

- **Perimetre** : routage `/v1/*`, verification du JWT, principal signe, registre de routage,
  scatter-gather multi-catalogs, limitation de debit, agregation OpenAPI.
- **Schema SQL** : `acv_gateway`
- **Port** : 3100 - le seul expose a l'app
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Conventions API** : `../../../acervatim-docs/agent/backend/contrats-api-v1.md`

---

## 1. Ce qu'il fait, et ce qu'il ne fait pas

**Il fait** : etablir qui appelle et a quel titre, decider quel service sert la requete, la
transmettre, et relayer la reponse telle quelle.

**Il ne fait pas** : valider un corps metier, lire une donnee de domaine, reecrire une reponse.
Un seul champ de charge utile lui est visible - le `typeCode` de `POST /v1/collections`, sans
lequel il n'y a aucun catalog vers qui router.

C'est ce qui rend le fichier [`src/routing/route-table.ts`](src/routing/route-table.ts) central :
tout le comportement du gateway en decoule. Ajouter une route publique, c'est y ajouter une
ligne - pas ecrire un controleur.

---

## 2. Les trois choses non triviales

### 2.1 Le principal signe remplace trois gardes (3.6)

Le monolithe resolvait le premium **en base a chaque requete**, y compris celui du proprietaire
quand un membre lisait une collection partagee. En micro-services ce serait un aller-retour
reseau par requete.

Le gateway verifie donc le JWT **une seule fois**, resout le premium aupres de `billing` (cache
Redis, TTL 60 s) et l'acces aupres de `sharing`, puis propage un en-tete
`X-Acervatim-Principal` : JSON compact signe HMAC portant `{ userId, premium, role, statuses,
exp }`. Les services aval ne verifient plus que cette signature.

Les trois gardes du monolithe (`PremiumGuard`, `CollectionPremiumGuard`, `CollectionWriteGuard`)
vivent maintenant dans [`src/principal/principal.service.ts`](src/principal/principal.service.ts),
et leurs codes de refus sont inchanges :

| Cas | Reponse |
|---|---|
| Ni proprietaire ni membre | `404` - on ne confirme pas l'existence d'une ressource d'autrui |
| Membre d'un partage, en ecriture | `403` - il voit deja la ressource, un 404 mentirait |
| Proprietaire non premium | `402` - y compris pour ses membres |
| Identifiant malforme | `400` |

Deux consequences assumees : la fenetre de 60 s pendant laquelle une perte de premium n'est pas
encore effective (elle *suspend* les partages, elle ne detruit rien), et
`INTERNAL_PRINCIPAL_SECRET` qui devient un secret de production au meme titre que
`SUB_HASH_PEPPER`.

### 2.2 Le registre de routage, et pourquoi son job de reparation existe des maintenant (3.3)

`GET /v1/items/:id`, `PATCH /v1/nodes/:id` et `GET /v1/collections/:id` **ne portent pas le
type**. Le gateway ne peut pas router sans le connaitre, et diffuser chaque lecture aux trois
catalogs est exclu. D'ou deux tables dans `acv_gateway` :

```
collection_registry(collection_id PK, user_id, type_code)
resource_registry(resource_id PK, kind ENUM('item','node'), collection_id)
```

Ecrites **en synchrone** par les catalogs a la creation et a la suppression
(`PUT|DELETE /internal/registry`, idempotent).

Le job de reparation n'est pas une commodite : un registre divergent produit des `404` sur des
ressources qui existent, c'est-a-dire un symptome qui ressemble a une suppression normale et que
rien ne signale. Il tourne toutes les nuits, trace son ecart dans `registry_rebuild_runs`, et
**ne supprime rien si un catalog n'a pas repondu** - sinon un catalog momentanement indisponible
ferait purger toutes ses collections, et le reparateur deviendrait la panne.

```
POST /internal/registry/rebuild   declenche une reconstruction (admin)
GET  /internal/registry/rebuild   ecart des dernieres reconstructions
```

### 2.3 Le scatter-gather et son curseur composite (3.7)

`GET /v1/collections` traverse tous les types. Le gateway appelle les catalogs concernes en
parallele, fusionne et trie. Le piege n'est pas la fusion, c'est le **curseur** : un curseur
opaque unique ne decrit plus une position quand la liste est la fusion de N listes
independantes.

Retenu : une position par service, encodees ensemble et opaques vues du client, ordre stable
`(createdAt desc, id desc)` - **le meme que celui des catalogs** -, taille de page bornee a 100.
Un service epuise est marque comme tel et cesse d'etre interroge. Un curseur illisible est un
`400`, pas une page 1 silencieuse : repartir du debut au milieu d'une pagination rendrait les
doublons indiscernables d'un defaut de fusion.

Choix ecarte : n'interroger que les catalogs des types que le registre attribue a l'utilisateur.
Moins de requetes, mais un registre divergent produirait alors une liste **incomplete et
silencieuse** - le pire mode de defaillance pour une galerie. Le registre sert a router une
ressource nommee, pas a decider ce qui existe.

---

## 3. Demarrage

Le gateway ne se lance pas seul : il fait partie de la constellation.

```powershell
cd ..                              # backend-services/
Copy-Item .env.example .env        # puis remplir
./scripts/dev.ps1 build
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 health
```

Un service aval absent n'empeche pas le gateway de demarrer : ses routes repondent `503`, les
autres fonctionnent. C'est le mode de travail normal quand on developpe un seul service, et
`GET /health/ready` dit qui repond.

---

## 4. Limitation de debit

`ThrottlerModule` n'est **pas** utilise ici, contrairement au monolithe et aux services aval :
le gateway sert toutes ses routes par un controleur attrape-tout, ou `@Throttle` et
`@SkipThrottle` n'ont plus de handler sur lequel se poser. Les budgets sont donc declares dans
la table de routage, a cote du reste de la regle, et appliques par `RouteThrottleService` :
100 req/min par defaut, 10 pour `POST /v1/auth/google`, 5 pour `POST /v1/shares/redeem` et
`POST /v1/admin/invitations`, aucune limite pour le webhook RTDN (Pub/Sub retenterait en boucle
sur un `429`).

Les compteurs sont en memoire du processus. **Valable tant que le gateway est unique** ; s'il se
replique, chaque replique comptera sa propre fenetre et le plafond effectif sera multiplie - il
faudra passer les compteurs dans le Redis deja present pour le cache premium.

---

## 5. Ce que l'app voit

**Rien de nouveau, par construction.** Memes URLs, memes Problem Details RFC 9457 sous les memes
URI `type`, meme pagination cursor, memes codes de refus. `API_BASE_URL` et `NetworkModule.kt`
ne bougent pas.

Deux points de non-regression a surveiller, tous deux introduits par le decoupage :

- la latence de `GET /v1/collections` (scatter-gather) et **l'exactitude de sa pagination** ;
- la latence des ecritures, le premium etant desormais resolu en amont.

---

## 6. Reste a faire

- **Mesurer** ce que le 4 de l'architecture exige avant tout passage de palier : RSS total au
  repos, p95 de `GET /v1/collections` et de `GET /v1/collections/:id/items`, et l'ecart du
  registre apres re-scan complet. Rien de tout cela n'a encore ete observe sur des donnees
  reelles.
- **Verrou Redis** sur la reconstruction du registre et sur les compteurs de debit, le jour ou
  le gateway passe a plusieurs repliques. Les deux verrous actuels sont intra-processus.
- **Purger `resource_registry`** a la suppression d'un item par le catalog : la route existe et
  la cascade collection est faite, mais un catalog qui oublierait d'appeler `DELETE
  /internal/registry/:id` sur un item isole laisserait une entree orpheline jusqu'au passage
  nocturne.
