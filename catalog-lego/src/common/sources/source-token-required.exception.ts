/**
 * Aucun jeton utilisable pour une source qui en exige un, et l'appelant n'est pas premium.
 * Rendu en `403` avec le membre d'extension `provider`, exactement comme dans le monolithe :
 * l'app propose alors *connecter la source* ou *passer premium*.
 */
export class SourceTokenRequiredException extends Error {
  constructor(readonly provider: string) {
    super(`No usable token for source ${provider}`);
  }
}
