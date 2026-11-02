## acervatim-gateway

Point d'entree de la constellation micro-services Acervatim (NestJS, Prisma, MariaDB). Conserve
le contrat `/v1/*` que l'app Android connait, route vers les services, et n'implemente aucun
metier. Cible : `../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Aucune logique metier ici.** Le gateway ne valide pas un corps, ne lit pas une donnee de
  domaine, ne reecrit pas une reponse. La seule exception est le `typeCode` de
  `POST /v1/collections`, sans lequel il n'y a aucun catalog vers qui router.
- **Le corps des reponses est relaye tel quel**, Problem Details compris. L'app discrimine sur
  les URI `type` du monolithe : les reemballer casserait le contrat sans changer une signature.
- **`Authorization` n'est jamais retransmis** vers l'aval, sauf deux exceptions decidees par
  `forwardsAuthorization` (`route-table.ts`) : le webhook RTDN (JWT signe par Google) et les
  routes `auth: 'admin'` (`ADMIN_API_TOKEN`, deja detenu par chaque service, qui le reverifie).
  L'identite d'un utilisateur passe par `X-Acervatim-Principal`, et par lui seul.
- **Aucune route `/internal/*` n'est exposee** par la table de routage. Un test le verifie.
- Ne nommer aucun materiel ni hebergeur (Raspberry Pi, NAS, AWS...) dans le code ou un
  commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- **`src/routing/route-table.ts` est le fichier central** : tout le comportement du gateway en
  decoule. Ajouter une route publique, c'est y ajouter une ligne - pas ecrire un controleur.
  L'ordre de declaration fait foi (premiere regle qui matche).
- `src/principal/` : les trois gardes du monolithe (`PremiumGuard`, `CollectionPremiumGuard`,
  `CollectionWriteGuard`), remontees ici par le 3.6.
- `src/registry/` : registre de routage `collectionId -> typeCode` (3.3) et son job de reparation.
- `src/proxy/` : transmission, curseur composite et scatter-gather (3.7).
- `src/common/internal/contracts.ts` : le contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Le gateway ne se lance pas seul. Tout passe par le wrapper de la racine :
  `../scripts/dev.ps1 up-bg`, `../scripts/dev.ps1 health`, `../scripts/dev.ps1 logs gateway`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> gateway`, qui les execute dans le conteneur. Un lancement hote
  produit des artefacts Prisma inutilisables dans le conteneur.
- Verification de compilation : `../scripts/dev.ps1 build-ts gateway`. Tests :
  `../scripts/dev.ps1 test gateway`.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate gateway`, sinon le conteneur tourne avec l'ancienne
  configuration et les symptomes sont trompeurs (JWT « invalide », service « injoignable »).

## Conventions that differ from defaults

- **Pas de `setGlobalPrefix('v1')`**, contrairement a tous les autres services : le gateway
  apparie l'URL complete contre sa table. Un prefixe global la decalerait silencieusement.
- **Pas de `ThrottlerModule`** : un controleur attrape-tout n'offre aucun handler ou poser
  `@Throttle`. Les budgets sont dans la table de routage, appliques par `RouteThrottleService`.
- `ProxyModule` s'importe **en dernier** dans `AppModule` : son controleur est un attrape-tout
  et Nest apparie dans l'ordre d'enregistrement. Place avant, il capterait `/health` et
  `/internal/*`.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **L'ordre des regles de route est du code, pas de la mise en forme.** `/v1/shares/received`
  doit preceder `/v1/shares/:id`, sinon `received` part au registre comme un identifiant. Un
  test le verrouille ; ne pas le contourner en reordonnant la table.
- **Le curseur composite est le point le plus facile a casser en silence.** Une pagination qui
  saute ou duplique des lignes ne leve aucune erreur : elle fait disparaitre des collections
  d'une galerie. L'ordre `(createdAt desc, id desc)` doit rester **identique** a celui des
  catalogs ; changer l'un sans l'autre ne casse aucun test d'un cote comme de l'autre.
- Un catalog qui ne repond pas pendant une reconstruction du registre **ne doit provoquer aucune
  suppression**. Le code le garantit ; ne pas « simplifier » cette branche.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Garder les sources `.ps1` en
  ASCII pur.
