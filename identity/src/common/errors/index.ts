import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Vocabulaire d'erreur commun a TOUS les services de la constellation.
 *
 * Il est volontairement complet dans chaque service, y compris pour des cas qu'un
 * service donne ne levera jamais : le gateway relaie le corps Problem Details **tel
 * quel** vers l'app, qui discrimine deja sur les URI `type` du monolithe. Un espace
 * de noms qui varierait d'un service a l'autre casserait le contrat sans changer une
 * seule signature - et le seul moyen fiable de garantir qu'il ne varie pas est que
 * `ProblemDetailsExceptionFilter` soit strictement identique partout, donc qu'il
 * puisse importer partout les memes classes.
 *
 * Voir ../../../acervatim-docs/agent/backend/contrats-api-v1.md.
 */

/**
 * 402 - fonctionnalite reservee au premium. Distincte de {@link TechnicalLimitException} :
 * ici payer leve le refus.
 */
export class PaymentRequiredException extends HttpException {
  constructor(message = 'Premium subscription required') {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}

/**
 * 403 - aucun jeton disponible pour une source externe : l'utilisateur n'a pas connecte
 * la source ET n'est pas premium (donc pas de repli Acervatim), et le mode degrade n'a
 * rien pu servir.
 *
 * Distincte du 402 : ici **deux** remediations existent cote app - connecter la source
 * ou passer premium. `provider` sort dans le payload (extension member RFC 9457) pour
 * que l'app route vers le bon parcours.
 */
export class SourceTokenRequiredException extends HttpException {
  constructor(readonly provider: string) {
    super(
      `No access token available for source "${provider}". Connect the source or upgrade to premium.`,
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * 409 - plafond technique atteint. Ce n'est PAS une limite de palier : c'est un garde-fou
 * anti-emballement (client en boucle, import qui derape), identique pour tous les comptes.
 * D'ou le 409 et non le 402 : repondre « Payment Required » dirait a l'utilisateur de payer
 * pour une limite que l'argent ne leve pas.
 */
export class TechnicalLimitException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
  }
}

/**
 * 404 - code de partage inutilisable : inconnu, revoque, expire, epuise, ou membre ejecte.
 *
 * **Une seule exception pour ces cinq cas, volontairement.** Distinguer « inconnu » de
 * « revoque » donnerait un oracle d'existence a qui balaie l'espace des codes, ce que le
 * rate-limit seul ne suffirait pas a contenir.
 */
export class ShareCodeInvalidException extends HttpException {
  constructor(
    message = 'Ce code de partage ne permet pas (ou plus) de rejoindre une collection',
  ) {
    super(message, HttpStatus.NOT_FOUND);
  }
}

/** 410 - l'invitation a existe mais sa fenetre d'usage est depassee. */
export class InvitationExpiredException extends HttpException {
  constructor(message = 'Invitation expiree') {
    super(message, HttpStatus.GONE);
  }
}

/**
 * 409 - l'invitation est valide mais `usedCount >= maxUses`. Couvre aussi la course
 * « place perdue entre le controle et l'increment ».
 */
export class InvitationExhaustedException extends ConflictException {
  constructor(message = 'Invitation epuisee') {
    super(message);
  }
}
