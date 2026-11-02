# Sharing

Codes de partage, membres, portees par statut - et la **resolution d'acces** dont depend tout
le domaine collection.

- **Perimetre** : creer / lister / renommer / revoquer un partage, rejoindre par code,
  `GET /internal/access`.
- **Schema SQL** : `acv_sharing` · **Port** : 3140
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Modele et decisions** : `../../../acervatim-docs/agent/backend/partage-de-collection.md`

---

## 1. La couture la plus dure du decoupage passe ici (3.1)

Dans le monolithe, la dependance etait **bidirectionnelle** :

- `sharing` lisait `collections` (jointure Prisma) et `items` (SQL brut joignant
  `collection_share_entries` a `items` pour filtrer par statut) ;
- et symetriquement, `ShareFilterService` etait **injecte dans trois services du domaine
  collection** - `collections`, `items`, `nodes` - qui l'appelaient a chaque lecture.

Aucune des deux directions ne survit a la separation des schemas. L'inversion retenue :

```
avant :  items  ──appelle──>  ShareFilterService  ──lit──>  items
apres :  gateway ──GET /internal/access──> sharing
         gateway ──principal signe { role, statuses }──> catalog
         catalog ──applique le filtre sur SES tables──
```

`sharing` rend les **statuts autorises** ; le catalog applique le filtre localement. C'est
possible parce que le `status` d'un item vit dans son `userData`, donc chez lui : le `IN` /
`NOT IN` SQL de `share-filter` devient un predicat sur ses propres tables, et `sharing` n'a
plus besoin de connaitre `items`.

`GET /internal/access` est litteralement le contrat de `CollectionAccessService.resolveAccess`
du monolithe, deplace de `premium/` vers ce service comme l'architecture le prevoit.

---

## 2. Ce que la disparition de la jointure a coute

Deux colonnes denormalisees dans `collection_share_entries` : `collection_name` et `type_code`.
Elles venaient d'une jointure vers `collections`, qui n'existe plus. Il y avait trois options :

1. **interroger le catalog a chaque lecture** - une requete reseau par entree et par partage,
   sur une liste non plafonnee. C'est exactement le cout que le monolithe refusait deja pour
   l'`itemCount` du proprietaire ;
2. **ne plus rendre le nom** - un ecran de gestion qui liste des UUID ;
3. **denormaliser a la creation**.

La 3 est retenue, avec son defaut : **le nom peut vieillir** si le proprietaire renomme sa
collection apres coup. Il est rattrape la ou c'est gratuit - la reponse de
`POST /internal/items/count`, que la lecture d'un membre declenche deja, porte le nom courant.
L'ecran du proprietaire, lui, ne fait aucun appel au catalog : il peut afficher un nom perime
jusqu'a la prochaine lecture par un membre.

`type_code` n'est pas denormalise pour l'affichage mais pour le **routage** : sans lui,
`sharing` devrait diffuser ses demandes de comptage aux trois catalogs au lieu de viser le bon.

---

## 3. `itemCount: null` n'est pas `itemCount: 0`

Quand un catalog ne repond pas, les entrees concernees sortent avec `itemCount: null`. Servir
`0` ferait croire au membre que le partage est vide - un mode de defaillance qui ressemble a
une donnee, pas a une panne. Il doit pouvoir voir **quelles** collections on lui partage meme
quand un catalog est indisponible.

Les comptes sont demandes **en un seul lot par catalog**, pour tous les partages a la fois : un
membre avec cinq partages de trois collections declenche trois appels reseau, pas quinze.

---

## 4. Ce qui n'a pas change

Tout le reste, et ce n'est pas un hasard : les partages, leurs entrees et leurs membres vivent
tous ici, aucun de ces liens ne franchissait de frontiere.

- **Aucun oracle d'existence** : code inconnu, revoque, expire, epuise ou membre ejecte
  renvoient tous le meme `404` `/probs/share-code-invalid`, meme `detail`. Seul le
  proprietaire qui tente de rejoindre son propre partage obtient un `400` distinct - il
  connait deja son code.
- **Consommation atomique** : `usedCount` est incremente sous garde optimiste
  (`updateMany where usedCount < maxUses`) dans la transaction du redeem. Deux redeems
  concurrents sur la derniere place ne passent pas tous deux.
- **Deux libelles cloisonnes** : celui du proprietaire (« Wantlist manga avec Alice ») et celui
  du membre (« Wantlist manga de Bob ») ne franchissent jamais la frontiere. Ni log, ni
  metadonnee d'audit ; dans l'export RGPD de leur auteur seulement.
- **Revocation = marquage**, jamais de suppression physique. La trace de ce qui a ete partage
  survit.
- **Un ensemble de statuts vide ne montre rien.** C'est le bon sens de la defaillance pour une
  ligne abimee ; l'inverse ouvrirait la collection entiere.
- **`expiresAt` borne l'usage du code, pas l'adhesion.** Un partage expire cesse d'etre
  rejoignable ; ceux qui l'ont rejoint continuent de lire jusqu'a revocation.

---

## 5. Ou sont passes les gardes

`PremiumGuard` sur `POST /v1/shares` et le bucket a 5/min sur `POST /v1/shares/redeem` ne sont
plus dans ce service : ils sont declares dans la table de routage du gateway, seul endroit qui
voie tout le trafic et qui interroge `billing` avec un cache. Le service garde un throttler a
200/min comme filet contre un appel direct depuis le reseau interne.

Lister et revoquer ses partages restent **hors gate premium**, comme dans le monolithe : un
proprietaire dont l'abonnement a expire doit pouvoir constater et retirer ce qu'il partage.

---

## 6. La suppression de compte, et ses deux roles

`DELETE /internal/users/:id/data` traite les deux cas differemment :

- **membre** : ses adhesions disparaissent, les partages des autres survivent ;
- **proprietaire** : ses partages sont supprimes physiquement, avec entrees et membres. Ici on
  ne revoque pas - la revocation est un geste metier qui conserve la trace, alors qu'un compte
  supprime ne doit rien laisser.

`usedCount` des partages d'autrui n'est **pas** decremente quand un membre part : le compteur
mesure les places consommees, pas les membres presents. Le decrementer rendrait une place a un
code deja distribue, ce que le proprietaire n'a pas demande.

---

## 7. Reste a faire

- **Mesurer le cout de la creation de partage.** Elle diffuse aux catalogs configures pour
  trouver chaque collection - la seule diffusion de la constellation. Acceptable parce que
  l'operation est rare et le resultat denormalise, mais personne ne l'a chronometree.
- **Rafraichir `collection_name` en base** quand le catalog rend un nom different, plutot que
  seulement dans la reponse. Une ecriture par lecture n'en vaut pas le cout ; une ecriture
  conditionnelle, peut-etre.
- **Purger les partages revoques** au-dela d'une retention. Rien ne supprime jamais une ligne
  aujourd'hui, hors suppression de compte.
