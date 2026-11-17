import { HttpStatus } from '@nestjs/common';

/**
 * Socle de la sonde de disponibilite. **Fichier strictement identique dans tous les
 * services.**
 *
 * Deux sondes, deux questions :
 *
 *   - `GET /health` (vie) : le processus repond-il ? Aucune dependance n'est sollicitee.
 *     C'est elle que vise le `HEALTHCHECK` de l'image : un conteneur ne doit pas etre
 *     declare defaillant, et encore moins relance, parce que la base redemarre.
 *   - `GET /health/ready` (disponibilite) : le service peut-il servir ? Elle repond `503`
 *     des qu'une dependance vitale manque. C'est sur elle que s'appuie la bascule.
 *
 * Le corps a la meme forme en `200` et en `503` : le diagnostic ne doit pas disparaitre au
 * moment precis ou on en a besoin.
 */

/**
 * - `ok` : tout repond.
 * - `degraded` : le service sert, mais une dependance secondaire manque. Reste un `200`.
 * - `unavailable` : une dependance vitale manque. `503`.
 */
export type ReadinessStatus = 'ok' | 'degraded' | 'unavailable';

/**
 * Delai accorde a une dependance pour repondre. Court a dessein : le reseau est local, et
 * une base qui met plus de deux secondes a compter une table n'est pas en etat de servir.
 * Sans cette borne, la sonde herite des delais de connexion du pilote : base arretee, la
 * plupart des services n'avaient toujours pas repondu au bout de deux secondes, et rien ne
 * plafonne ce delai si l'hote ne repond plus du tout.
 */
export const READINESS_TIMEOUT_MS = 2_000;

/**
 * Borne une verification : rejette si `work` n'a pas abouti apres `ms`.
 *
 * Le travail sous-jacent n'est pas annule - une requete SQL partie ne se rappelle pas -
 * mais la sonde, elle, repond. Le minuteur est toujours libere, pour qu'une sonde appelee
 * en boucle n'en accumule pas.
 */
export function withDeadline<T>(
  work: PromiseLike<T>,
  ms: number = READINESS_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sonde: delai de ${ms} ms depasse`)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Statut d'un service. `vital` : ce sans quoi il ne sert rien (sa base, toujours).
 * `secondary` : ce dont l'absence ampute une fonction sans arreter le service.
 */
export function readinessStatus(
  vital: boolean,
  secondary: boolean = true,
): ReadinessStatus {
  if (!vital) return 'unavailable';
  return secondary ? 'ok' : 'degraded';
}

/** Code HTTP de la sonde : `503` pour `unavailable`, `200` sinon. */
export function readinessHttpStatus(status: ReadinessStatus): number {
  return status === 'unavailable'
    ? HttpStatus.SERVICE_UNAVAILABLE
    : HttpStatus.OK;
}
